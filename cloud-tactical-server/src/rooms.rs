use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

use crate::config::ServerConfig;
use crate::fusion::{FusionEngine, FusionResult, ParsedObservation};

#[derive(Debug, Clone)]
pub struct RoomInfo {
    pub room_id: String,
    pub password_hash: Option<String>,
    pub created_at: std::time::Instant,
    pub relay_count: usize,
    pub viewer_count: usize,
    pub map_generation: u32,
}

struct RoomState {
    info: RoomInfo,
    observation_tx: mpsc::UnboundedSender<ParsedObservation>,
    snapshot_tx: broadcast::Sender<FusionResult>,
    relay_counter: Arc<AtomicUsize>,
    viewer_counter: Arc<AtomicUsize>,
}

#[derive(Clone)]
pub struct RoomHandle {
    pub info: RoomInfo,
    pub observation_tx: mpsc::UnboundedSender<ParsedObservation>,
    pub snapshot_tx: broadcast::Sender<FusionResult>,
    pub relay_counter: Arc<AtomicUsize>,
    pub viewer_counter: Arc<AtomicUsize>,
}

impl RoomHandle {
    /// Verify password against stored hash. Returns true if room has no password.
    pub fn check_password(&self, password: &str) -> bool {
        match &self.info.password_hash {
            None => true,
            Some(hash) => verify_password(password, hash),
        }
    }

    /// Try to acquire a relay slot. Returns true if under max_clients_per_room.
    pub fn try_acquire_relay(&self, max_per_room: usize) -> bool {
        let current = self.relay_counter.fetch_add(1, Ordering::SeqCst);
        // Check limit BEFORE incrementing? No, we already incremented.
        // Check total (relay + viewer)
        let viewers = self.viewer_counter.load(Ordering::SeqCst);
        if current + viewers + 1 > max_per_room {
            // Rollback
            self.relay_counter.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }

    pub fn release_relay(&self) {
        self.relay_counter.fetch_sub(1, Ordering::SeqCst);
    }

    pub fn try_acquire_viewer(&self, max_per_room: usize) -> bool {
        let current = self.viewer_counter.fetch_add(1, Ordering::SeqCst);
        let relays = self.relay_counter.load(Ordering::SeqCst);
        if current + relays + 1 > max_per_room {
            self.viewer_counter.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }

    pub fn release_viewer(&self) {
        self.viewer_counter.fetch_sub(1, Ordering::SeqCst);
    }

    /// Refresh counts from atomics into RoomInfo
    pub fn snapshot_info(&self) -> RoomInfo {
        RoomInfo {
            room_id: self.info.room_id.clone(),
            password_hash: self.info.password_hash.clone(),
            created_at: self.info.created_at,
            relay_count: self.relay_counter.load(Ordering::SeqCst),
            viewer_count: self.viewer_counter.load(Ordering::SeqCst),
            map_generation: self.info.map_generation,
        }
    }
}

pub struct RoomManager {
    rooms: HashMap<String, RoomState>,
    config: ServerConfig,
}

impl RoomManager {
    pub fn new(config: &ServerConfig) -> Self {
        Self {
            rooms: HashMap::new(),
            config: config.clone(),
        }
    }

    pub fn create_room(
        &mut self,
        room_id: String,
        password: Option<String>,
    ) -> Result<RoomHandle, RoomError> {
        if self.rooms.len() >= self.config.max_rooms {
            return Err(RoomError::TooManyRooms);
        }

        if self.rooms.contains_key(&room_id) {
            return Err(RoomError::RoomExists);
        }

        let password_hash = password.map(|p| hash_password(&p));

        let (obs_tx, obs_rx) = mpsc::unbounded_channel();
        let (snap_tx, _snap_rx) = broadcast::channel(64);
        let relay_counter = Arc::new(AtomicUsize::new(0));
        let viewer_counter = Arc::new(AtomicUsize::new(0));

        let info = RoomInfo {
            room_id: room_id.clone(),
            password_hash,
            created_at: std::time::Instant::now(),
            relay_count: 0,
            viewer_count: 0,
            map_generation: 0,
        };

        // 启动房间融合 loop
        let fusion = FusionEngine::new(&self.config);
        let fusion_config = self.config.clone();
        let fusion_room_id = room_id.clone();
        let fusion_snap_tx = snap_tx.clone();

        tokio::spawn(async move {
            run_fusion_loop(
                fusion_room_id,
                fusion,
                obs_rx,
                fusion_snap_tx,
                fusion_config.fusion_interval_ms,
            )
            .await;
        });

        let handle = RoomHandle {
            info,
            observation_tx: obs_tx.clone(),
            snapshot_tx: snap_tx.clone(),
            relay_counter: relay_counter.clone(),
            viewer_counter: viewer_counter.clone(),
        };

        self.rooms.insert(
            room_id,
            RoomState {
                info: handle.info.clone(),
                observation_tx: obs_tx,
                snapshot_tx: snap_tx,
                relay_counter,
                viewer_counter,
            },
        );

        Ok(handle)
    }

    pub fn get_room(&self, room_id: &str) -> Option<RoomHandle> {
        self.rooms.get(room_id).map(|state| RoomHandle {
            info: state.info.clone(),
            observation_tx: state.observation_tx.clone(),
            snapshot_tx: state.snapshot_tx.clone(),
            relay_counter: state.relay_counter.clone(),
            viewer_counter: state.viewer_counter.clone(),
        })
    }

    pub fn verify_password(&self, room_id: &str, password: &str) -> bool {
        self.rooms
            .get(room_id)
            .map(|state| match &state.info.password_hash {
                None => true,
                Some(hash) => verify_password(password, hash),
            })
            .unwrap_or(false)
    }

    pub fn list_rooms(&self) -> Vec<RoomInfo> {
        self.rooms
            .values()
            .map(|s| {
                RoomInfo {
                    room_id: s.info.room_id.clone(),
                    password_hash: s.info.password_hash.clone(),
                    created_at: s.info.created_at,
                    relay_count: s.relay_counter.load(Ordering::SeqCst),
                    viewer_count: s.viewer_counter.load(Ordering::SeqCst),
                    map_generation: s.info.map_generation,
                }
            })
            .collect()
    }

    pub fn remove_room(&mut self, room_id: &str) -> bool {
        self.rooms.remove(room_id).is_some()
    }

    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    pub fn max_clients_per_room(&self) -> usize {
        self.config.max_clients_per_room
    }
}

#[derive(Debug)]
pub enum RoomError {
    RoomExists,
    TooManyRooms,
    RoomNotFound,
    InvalidPassword,
    RoomFull,
}

impl std::fmt::Display for RoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RoomError::RoomExists => write!(f, "Room already exists"),
            RoomError::TooManyRooms => write!(f, "Server room limit reached"),
            RoomError::RoomNotFound => write!(f, "Room not found"),
            RoomError::InvalidPassword => write!(f, "Invalid password"),
            RoomError::RoomFull => write!(f, "Room is full"),
        }
    }
}

// ── 融合 loop ──

async fn run_fusion_loop(
    room_id: String,
    mut fusion: FusionEngine,
    mut obs_rx: mpsc::UnboundedReceiver<ParsedObservation>,
    snap_tx: broadcast::Sender<FusionResult>,
    interval_ms: u64,
) {
    let mut tick_interval = tokio::time::interval(
        std::time::Duration::from_millis(interval_ms),
    );

    loop {
        tokio::select! {
            _ = tick_interval.tick() => {
                let now = std::time::Instant::now();
                let now_ms = unix_ms();
                let result = fusion.tick(now, now_ms);

                if result.total_count > 0 || !result.rois.is_empty() {
                    tracing::debug!(
                        "Room {}: {} tracks, {} rois, {} hostile",
                        room_id, result.total_count, result.rois.len(), result.hostile_count
                    );
                }

                let _ = snap_tx.send(result);
            }

            Some(obs) = obs_rx.recv() => {
                fusion.push_observation(obs);
            }

            else => {
                tracing::info!("Room {} fusion loop exiting (no senders)", room_id);
                break;
            }
        }
    }
}

// ── 简单的密码哈希（第一阶段） ──

fn hash_password(password: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    password.hash(&mut hasher);
    "wt8111-salted-".hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    hash_password(password) == hash
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
