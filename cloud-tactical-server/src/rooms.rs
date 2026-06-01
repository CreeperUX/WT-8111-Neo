use std::collections::HashMap;
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
}

#[derive(Clone)]
pub struct RoomHandle {
    pub info: RoomInfo,
    pub observation_tx: mpsc::UnboundedSender<ParsedObservation>,
    pub snapshot_tx: broadcast::Sender<FusionResult>,
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
        };

        self.rooms.insert(
            room_id,
            RoomState {
                info: handle.info.clone(),
                observation_tx: obs_tx,
                snapshot_tx: snap_tx,
            },
        );

        Ok(handle)
    }

    pub fn get_room(&self, room_id: &str) -> Option<RoomHandle> {
        self.rooms.get(room_id).map(|state| RoomHandle {
            info: state.info.clone(),
            observation_tx: state.observation_tx.clone(),
            snapshot_tx: state.snapshot_tx.clone(),
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
        self.rooms.values().map(|s| s.info.clone()).collect()
    }

    pub fn remove_room(&mut self, room_id: &str) -> bool {
        self.rooms.remove(room_id).is_some()
    }

    pub fn room_count(&self) -> usize {
        self.rooms.len()
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

fn verify_password(password: &str, hash: &str) -> bool {
    hash_password(password) == hash
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
