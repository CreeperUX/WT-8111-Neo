use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::config::ServerConfig;

// ── 内部类型 ──

#[derive(Debug, Clone)]
pub struct TrackPoint {
    pub x_u16: u32,
    pub y_u16: u32,
    pub at: Instant,
}

#[derive(Debug, Clone)]
pub struct Track {
    pub track_id: String,
    pub label_id: u32,
    pub class_id: u32,
    pub affiliation: u32,
    pub x_u16: u32,
    pub y_u16: u32,
    pub heading_i16: i32,
    pub vx_i16: i32,
    pub vy_i16: i32,
    pub confidence_u8: u32,
    pub source_count: u32,
    pub flags: u32,
    pub last_observed_at: Instant,
    pub history: VecDeque<TrackPoint>,
    pub created_at: Instant,
}

#[derive(Debug, Clone)]
pub struct ParsedObservation {
    pub client_id: String,
    pub player_name: Option<String>,
    pub seq: u64,
    pub observed_at_ms: u64,
    pub map_generation: u32,
    pub player_x: u32,
    pub player_y: u32,
    pub player_heading: i32,
    pub objects: Vec<ParsedObject>,
}

#[derive(Debug, Clone)]
pub struct ParsedObject {
    pub local_id: u32,
    pub label_id: u32,
    pub class_id: u32,
    pub affiliation: u32,
    pub x_u16: u32,
    pub y_u16: u32,
    pub heading_i16: i32,
    pub color_id: u32,
    pub flags: u32,
}

/// ROI 预测区域
#[derive(Debug, Clone)]
pub struct PredictedRoi {
    pub track_id: String,
    pub x_u16: u32,
    pub y_u16: u32,
    pub radius_u16: u32,
    pub expires_in_ms: u32,
    pub confidence_u8: u32,
}

/// 一次 tick 的融合结果（全 owned）
#[derive(Debug, Clone)]
pub struct FusionResult {
    pub tracks: Vec<Track>,
    pub rois: Vec<PredictedRoi>,
    pub total_count: u32,
    pub hostile_count: u32,
    pub friendly_count: u32,
    pub stale_count: u32,
}

// ── 融合引擎 ──

pub struct FusionEngine {
    tracks: HashMap<String, Track>,
    track_counter: u64,
    config: ServerConfig,
    pending_observations: Vec<ParsedObservation>,
}

impl FusionEngine {
    pub fn new(config: &ServerConfig) -> Self {
        Self {
            tracks: HashMap::new(),
            track_counter: 0,
            config: config.clone(),
            pending_observations: Vec::new(),
        }
    }

    pub fn push_observation(&mut self, obs: ParsedObservation) {
        self.pending_observations.push(obs);
    }

    /// 执行一次融合 tick
    pub fn tick(&mut self, now: Instant) -> FusionResult {
        let observations = std::mem::take(&mut self.pending_observations);

        for obs in &observations {
            for obj in &obs.objects {
                let fingerprint = TrackFingerprint {
                    affiliation: obj.affiliation,
                    class_id: obj.class_id,
                    label_id: obj.label_id,
                    x_u16: obj.x_u16,
                    y_u16: obj.y_u16,
                };

                if let Some(track_id) = self.match_track(&fingerprint) {
                    self.update_track(&track_id, obj, now);
                } else {
                    let track_id = self.create_track(obj, now);
                    // track 已加入 self.tracks，无需额外操作
                    let _ = track_id;
                }
            }
        }

        // 清理过期 + 生成 ROI
        let (rois, stale_count) = self.prune_and_predict(now);

        // 构建结果
        let all_tracks: Vec<Track> = self.tracks.values().cloned().collect();
        let hostile_count = all_tracks.iter().filter(|t| t.affiliation == 1).count() as u32;
        let friendly_count = all_tracks.iter().filter(|t| t.affiliation == 0).count() as u32;

        FusionResult {
            total_count: all_tracks.len() as u32,
            hostile_count,
            friendly_count,
            stale_count,
            tracks: all_tracks,
            rois,
        }
    }

    fn match_track(&self, fingerprint: &TrackFingerprint) -> Option<String> {
        // Level 1: 精确 (affiliation + class + label) + 距离
        for (id, track) in &self.tracks {
            if track.affiliation == fingerprint.affiliation
                && track.class_id == fingerprint.class_id
                && track.label_id == fingerprint.label_id
            {
                if spatial_dist(track.x_u16, track.y_u16, fingerprint.x_u16, fingerprint.y_u16)
                    < 2000
                {
                    return Some(id.clone());
                }
            }
        }

        // Level 2: (affiliation + class) + 近距离
        let mut best_id: Option<String> = None;
        let mut best_dist = u32::MAX;

        for (id, track) in &self.tracks {
            if track.affiliation == fingerprint.affiliation
                && track.class_id == fingerprint.class_id
            {
                let dist =
                    spatial_dist(track.x_u16, track.y_u16, fingerprint.x_u16, fingerprint.y_u16);
                if dist < 800 && dist < best_dist {
                    best_dist = dist;
                    best_id = Some(id.clone());
                }
            }
        }

        best_id
    }

    fn create_track(&mut self, obj: &ParsedObject, now: Instant) -> String {
        let id = format!("trk_{:08x}", self.track_counter);
        self.track_counter += 1;

        let mut history = VecDeque::new();
        history.push_back(TrackPoint {
            x_u16: obj.x_u16,
            y_u16: obj.y_u16,
            at: now,
        });

        self.tracks.insert(
            id.clone(),
            Track {
                track_id: id.clone(),
                label_id: obj.label_id,
                class_id: obj.class_id,
                affiliation: obj.affiliation,
                x_u16: obj.x_u16,
                y_u16: obj.y_u16,
                heading_i16: obj.heading_i16,
                vx_i16: 0,
                vy_i16: 0,
                confidence_u8: 255,
                source_count: 1,
                flags: obj.flags,
                last_observed_at: now,
                history,
                created_at: now,
            },
        );

        id
    }

    fn update_track(&mut self, track_id: &str, obj: &ParsedObject, now: Instant) {
        let Some(track) = self.tracks.get_mut(track_id) else {
            return;
        };

        // 速度估算
        if let Some(last) = track.history.back() {
            let dt = now.duration_since(last.at).as_secs_f64().max(0.1);
            track.vx_i16 = ((obj.x_u16 as f64 - last.x_u16 as f64) / dt) as i32;
            track.vy_i16 = ((obj.y_u16 as f64 - last.y_u16 as f64) / dt) as i32;
        }

        track.x_u16 = obj.x_u16;
        track.y_u16 = obj.y_u16;
        track.heading_i16 = obj.heading_i16;
        track.flags = obj.flags;
        track.last_observed_at = now;
        track.confidence_u8 = 255;

        track.history.push_back(TrackPoint {
            x_u16: obj.x_u16,
            y_u16: obj.y_u16,
            at: now,
        });

        // 只保留最近 3 秒
        let cutoff = now - Duration::from_secs_f64(self.config.track_history_secs);
        while track.history.front().map_or(false, |p| p.at < cutoff) {
            track.history.pop_front();
        }
    }

    fn prune_and_predict(&mut self, now: Instant) -> (Vec<PredictedRoi>, u32) {
        let mut rois = Vec::new();
        let mut stale_count = 0u32;
        let mut expired: Vec<String> = Vec::new();

        for (track_id, track) in &self.tracks {
            let ms_since = now.duration_since(track.last_observed_at).as_millis() as u32;
            let roi_ttl_ms = (self.config.roi_ttl_secs * 1000.0) as u32;

            if ms_since >= roi_ttl_ms {
                expired.push(track_id.clone());
            } else if ms_since > 0 {
                let elapsed = ms_since as f64 / 1000.0;
                let pred_x =
                    (track.x_u16 as f64 + track.vx_i16 as f64 * elapsed).clamp(0.0, 65535.0) as u32;
                let pred_y =
                    (track.y_u16 as f64 + track.vy_i16 as f64 * elapsed).clamp(0.0, 65535.0) as u32;

                let radius_growth = (elapsed * 500.0) as u32;
                let radius = (200 + radius_growth).min(3000);
                let confidence = ((255.0 * (1.0 - elapsed / self.config.roi_ttl_secs)) as u32).max(20);
                let expires_in = ((self.config.roi_ttl_secs - elapsed) * 1000.0) as u32;

                rois.push(PredictedRoi {
                    track_id: track_id.clone(),
                    x_u16: pred_x,
                    y_u16: pred_y,
                    radius_u16: radius,
                    expires_in_ms: expires_in,
                    confidence_u8: confidence,
                });

                stale_count += 1;
            }
        }

        for id in expired {
            self.tracks.remove(&id);
        }

        (rois, stale_count)
    }
}

struct TrackFingerprint {
    affiliation: u32,
    class_id: u32,
    label_id: u32,
    x_u16: u32,
    y_u16: u32,
}

fn spatial_dist(x1: u32, y1: u32, x2: u32, y2: u32) -> u32 {
    let dx = x1 as i64 - x2 as i64;
    let dy = y1 as i64 - y2 as i64;
    ((dx * dx + dy * dy) as f64).sqrt() as u32
}
