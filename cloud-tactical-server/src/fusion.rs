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

    // ROI 锚点：目标消失瞬间的位置和速度
    pub anchor_x_u16: u32,
    pub anchor_y_u16: u32,
    pub anchor_vx_i16: i32,
    pub anchor_vy_i16: i32,
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

/// 椭圆 ROI 预测
#[derive(Debug, Clone)]
pub struct PredictedRoi {
    pub track_id: String,
    pub center_x_u16: u32,
    pub center_y_u16: u32,
    pub anchor_x_u16: u32,
    pub anchor_y_u16: u32,
    pub radius_major_u16: u32,
    pub radius_minor_u16: u32,
    pub heading_i16: i32,
    pub expires_in_ms: u32,
    pub confidence_u8: u32,
}

/// 一次 tick 的融合结果
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
                    let _ = self.create_track(obj, now);
                }
            }
        }

        // 生成 ROI
        let (rois, stale_count) = self.predict_rois(now);

        // 清理过期
        let roi_duration = Duration::from_secs_f64(self.config.roi_ttl_secs);
        self.tracks
            .retain(|_, t| now.duration_since(t.last_observed_at) < roi_duration);

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
                anchor_x_u16: obj.x_u16,
                anchor_y_u16: obj.y_u16,
                anchor_vx_i16: 0,
                anchor_vy_i16: 0,
            },
        );

        id
    }

    fn update_track(&mut self, track_id: &str, obj: &ParsedObject, now: Instant) {
        let Some(track) = self.tracks.get_mut(track_id) else {
            return;
        };

        // 速度估算
        let prev_vx = track.vx_i16;
        let prev_vy = track.vy_i16;
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

        // 冻结锚点：记录最新观测时的位置和速度
        track.anchor_x_u16 = obj.x_u16;
        track.anchor_y_u16 = obj.y_u16;
        track.anchor_vx_i16 = track.vx_i16;
        track.anchor_vy_i16 = track.vy_i16;

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

    /// 生成椭圆 ROI：主轴沿运动方向，前向拉长
    fn predict_rois(&self, now: Instant) -> (Vec<PredictedRoi>, u32) {
        let mut rois = Vec::new();
        let mut stale_count = 0u32;
        let roi_ttl_ms = (self.config.roi_ttl_secs * 1000.0) as u32;
        let roi_ttl = self.config.roi_ttl_secs;

        for track in self.tracks.values() {
            // ROI 预测仅对飞机 (class_id == 0) 生效
            // 坦克等地面目标速度低、机动弱，圆形衰减即可
            if track.class_id != 0 {
                continue;
            }

            let ms_since = now.duration_since(track.last_observed_at).as_millis() as u32;

            // 只在目标消失期间生成 ROI
            if ms_since == 0 || ms_since >= roi_ttl_ms {
                continue;
            }

            let elapsed = ms_since as f64 / 1000.0;

            // ── 椭圆中心 = 锚点 + 速度 × 时间 ──
            let center_x = (track.anchor_x_u16 as f64
                + track.anchor_vx_i16 as f64 * elapsed)
                .clamp(0.0, 65535.0) as u32;
            let center_y = (track.anchor_y_u16 as f64
                + track.anchor_vy_i16 as f64 * elapsed)
                .clamp(0.0, 65535.0) as u32;

            // ── 主轴方向 ──
            let speed = ((track.anchor_vx_i16 as f64).powi(2)
                + (track.anchor_vy_i16 as f64).powi(2))
                .sqrt();
            let heading = if speed > 1.0 {
                // atan2(dx, -dy) → 0=北, 顺时针
                (track.anchor_vx_i16 as f64)
                    .atan2(-track.anchor_vy_i16 as f64)
                    .to_degrees() as i32
            } else {
                // 静止目标 → 各向同性，heading 无效
                0
            };

            // ── 半长轴 (沿运动方向，增长快) ──
            // base + speed_factor * elapsed + growth_rate * elapsed
            let base_radius = 200u32;
            let speed_bonus = (speed * elapsed * 800.0) as u32; // 速度越快，前向越长
            let time_growth = (elapsed * 300.0) as u32; // 基础时间增长
            let radius_major = (base_radius + speed_bonus + time_growth).min(5000);

            // ── 半短轴 (垂直于运动方向，增长慢) ──
            let radius_minor = (base_radius + (elapsed.sqrt() * 150.0) as u32).min(2000);

            // ── 置信度随时间衰减 ──
            let confidence =
                ((255.0 * (1.0 - elapsed / roi_ttl)) as u32).max(20);

            // ── 剩余时间 ──
            let expires_in = ((roi_ttl - elapsed) * 1000.0) as u32;

            rois.push(PredictedRoi {
                track_id: track.track_id.clone(),
                center_x_u16: center_x,
                center_y_u16: center_y,
                anchor_x_u16: track.anchor_x_u16,
                anchor_y_u16: track.anchor_y_u16,
                radius_major_u16: radius_major,
                radius_minor_u16: radius_minor,
                heading_i16: heading,
                expires_in_ms: expires_in,
                confidence_u8: confidence,
            });

            stale_count += 1;
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
