use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::config::ServerConfig;

// ── 融合参数 ──

/// EMA 时间常数 (毫秒)
/// total_age = τ 时, α = e^(-1) ≈ 0.37
const FUSION_TAU_MS: f64 = 1000.0;

/// 属性切换阈值: α 高于此值才允许覆盖 label_id / affiliation
const ATTR_SWITCH_ALPHA: f64 = 0.6;

/// source_count 统计窗口
const SOURCE_WINDOW_SECS: f64 = 2.0;

// ── 内部类型 ──

#[derive(Debug, Clone)]
pub struct TrackPoint {
    pub x_u16: u32,
    pub y_u16: u32,
    pub at: Instant,
}

/// 记录某个 client 最近一次贡献此 track 的时间
#[derive(Debug, Clone)]
pub(crate) struct ClientContribution {
    client_id: String,
    last_seen: Instant,
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
    pub last_observed_at_ms: u64,   // 服务端 UNIX 毫秒 (用于多端融合)
    pub total_age_ms: u32,          // 最近一次更新的总数据年龄
    pub history: VecDeque<TrackPoint>,
    pub created_at: Instant,
    pub contributing_clients: Vec<ClientContribution>,

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
    pub observed_at_ms: u64,        // 客户端 NTP 同步后的采样时刻 (服务端时间线)
    pub measurement_age_ms: u32,    // 客户端自报: 8111 采样→打包的间隔
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
    /// `now` — monotonic Instant (用于历史裁剪)
    /// `now_ms` — 服务端 UNIX 毫秒 (用于多端融合时钟对齐)
    pub fn tick(&mut self, now: Instant, now_ms: u64) -> FusionResult {
        let observations = std::mem::take(&mut self.pending_observations);

        for obs in &observations {
            for obj in &obs.objects {
                // ── 时间戳校验: 限制 observed_at_ms 在合理范围 ──
                // 防止客户端用未来时间戳获得过高融合权重
                let clamped_observed_at = clamp_timestamp(obs.observed_at_ms, now_ms);

                // ── 计算 total_age_ms ──
                let transit_ms = now_ms.saturating_sub(clamped_observed_at) as u32;
                let total_age_ms = transit_ms.saturating_add(obs.measurement_age_ms);

                let fingerprint = TrackFingerprint {
                    affiliation: obj.affiliation,
                    class_id: obj.class_id,
                    label_id: obj.label_id,
                    x_u16: obj.x_u16,
                    y_u16: obj.y_u16,
                };

                if let Some(track_id) = self.match_track(&fingerprint) {
                    self.update_track(
                        &track_id,
                        obj,
                        &obs.client_id,
                        now,
                        now_ms,
                        total_age_ms,
                    );
                } else {
                    let _ = self.create_track(
                        obj,
                        &obs.client_id,
                        now,
                        now_ms,
                        total_age_ms,
                    );
                }
            }
        }

        // 清理 source_count 过期记录
        let cutoff = now - Duration::from_secs_f64(SOURCE_WINDOW_SECS);
        for track in self.tracks.values_mut() {
            track
                .contributing_clients
                .retain(|c| c.last_seen >= cutoff);
        }

        // 生成 ROI（基于 last_observed_at_ms）
        let (rois, stale_count) = self.predict_rois(now_ms);

        // 清理过期（基于 last_observed_at_ms）
        let roi_ttl_ms = (self.config.roi_ttl_secs * 1000.0) as u64;
        self.tracks
            .retain(|_, t| now_ms.saturating_sub(t.last_observed_at_ms) < roi_ttl_ms);

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

    // ── 关联 ──

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

    // ── 创建新 track ──

    fn create_track(
        &mut self,
        obj: &ParsedObject,
        client_id: &str,
        now: Instant,
        now_ms: u64,
        total_age_ms: u32,
    ) -> String {
        let id = format!("trk_{:08x}", self.track_counter);
        self.track_counter += 1;

        let alpha = compute_alpha(total_age_ms);
        let initial_conf = (alpha * 255.0) as u32;

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
                confidence_u8: initial_conf.max(1),
                source_count: 1,
                flags: obj.flags,
                last_observed_at: now,
                last_observed_at_ms: now_ms,
                total_age_ms,
                history,
                created_at: now,
                contributing_clients: vec![ClientContribution {
                    client_id: client_id.to_string(),
                    last_seen: now,
                }],
                anchor_x_u16: obj.x_u16,
                anchor_y_u16: obj.y_u16,
                anchor_vx_i16: 0,
                anchor_vy_i16: 0,
            },
        );

        id
    }

    // ── EMA 加权更新 ──

    fn update_track(
        &mut self,
        track_id: &str,
        obj: &ParsedObject,
        client_id: &str,
        now: Instant,
        now_ms: u64,
        total_age_ms: u32,
    ) {
        let Some(track) = self.tracks.get_mut(track_id) else {
            return;
        };

        // ── 1. 计算 EMA 权重 ──
        let alpha = compute_alpha(total_age_ms);

        // ── 2. 速度估算 (基于历史, 不考虑 alpha) ──
        if let Some(last) = track.history.back() {
            let dt = now.duration_since(last.at).as_secs_f64().max(0.1);
            let raw_vx = (obj.x_u16 as f64 - last.x_u16 as f64) / dt;
            let raw_vy = (obj.y_u16 as f64 - last.y_u16 as f64) / dt;
            // 速度也用 EMA 平滑
            track.vx_i16 = (alpha * raw_vx + (1.0 - alpha) * track.vx_i16 as f64) as i32;
            track.vy_i16 = (alpha * raw_vy + (1.0 - alpha) * track.vy_i16 as f64) as i32;
        }

        // ── 3. 位置 EMA 融合 ──
        track.x_u16 = (alpha * obj.x_u16 as f64 + (1.0 - alpha) * track.x_u16 as f64) as u32;
        track.y_u16 = (alpha * obj.y_u16 as f64 + (1.0 - alpha) * track.y_u16 as f64) as u32;

        // ── 4. 朝向 EMA ──
        if obj.heading_i16 != 0 {
            track.heading_i16 =
                (alpha * obj.heading_i16 as f64 + (1.0 - alpha) * track.heading_i16 as f64) as i32;
        }

        // ── 5. 属性仲裁: 仅高 α 时覆盖 ──
        if alpha > ATTR_SWITCH_ALPHA {
            track.label_id = obj.label_id;
            track.affiliation = obj.affiliation;
        }

        // ── 6. 置信度 EMA 累积 ──
        let raw_conf = alpha * 255.0 + (1.0 - alpha) * track.confidence_u8 as f64;
        track.confidence_u8 = (raw_conf as u32).min(255);

        // ── 7. 标志位 ──
        track.flags = obj.flags;
        track.last_observed_at = now;
        track.last_observed_at_ms = now_ms;
        track.total_age_ms = total_age_ms;

        // ── 8. 来源追踪 (去重) ──
        let cutoff = now - Duration::from_secs_f64(SOURCE_WINDOW_SECS);
        track.contributing_clients.retain(|c| c.last_seen >= cutoff);

        if let Some(existing) = track
            .contributing_clients
            .iter_mut()
            .find(|c| c.client_id == client_id)
        {
            existing.last_seen = now;
        } else {
            track.contributing_clients.push(ClientContribution {
                client_id: client_id.to_string(),
                last_seen: now,
            });
        }
        track.source_count = track.contributing_clients.len() as u32;

        // ── 9. ROI 锚点更新 ──
        track.anchor_x_u16 = obj.x_u16;
        track.anchor_y_u16 = obj.y_u16;
        track.anchor_vx_i16 = track.vx_i16;
        track.anchor_vy_i16 = track.vy_i16;

        // ── 10. 历史 ──
        track.history.push_back(TrackPoint {
            x_u16: obj.x_u16,
            y_u16: obj.y_u16,
            at: now,
        });

        let history_cutoff = now - Duration::from_secs_f64(self.config.track_history_secs);
        while track.history.front().map_or(false, |p| p.at < history_cutoff) {
            track.history.pop_front();
        }
    }

    /// 生成椭圆 ROI：主轴沿运动方向，前向拉长
    /// 使用 last_observed_at_ms (服务端对齐时钟) 计算消失时长
    fn predict_rois(&self, now_ms: u64) -> (Vec<PredictedRoi>, u32) {
        let mut rois = Vec::new();
        let mut stale_count = 0u32;
        let roi_ttl_ms = (self.config.roi_ttl_secs * 1000.0) as u64;
        let roi_ttl = self.config.roi_ttl_secs;

        for track in self.tracks.values() {
            // ROI 预测仅对飞机 (class_id == 0) 生效
            // 坦克等地面目标速度低、机动弱，圆形衰减即可
            if track.class_id != 0 {
                continue;
            }

            let ms_since = now_ms.saturating_sub(track.last_observed_at_ms);

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
            let base_radius = 200u32;
            let speed_bonus = (speed * elapsed * 800.0) as u32;
            let time_growth = (elapsed * 300.0) as u32;
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

// ── 辅助 ──

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

/// 计算 EMA 权重 α = exp(-total_age_ms / τ)
fn compute_alpha(total_age_ms: u32) -> f64 {
    (-(total_age_ms as f64) / FUSION_TAU_MS).exp().clamp(0.0, 1.0)
}

/// 时间戳校验: 限制 observed_at_ms 在合理范围
/// - 不允许超过 30s 的未来时间 (防止权重作弊)
/// - 不允许超过 60s 的过旧时间 (防止重放旧数据)
/// - 超限则 clamp 到边界值
fn clamp_timestamp(observed_at_ms: u64, server_now_ms: u64) -> u64 {
    const MAX_FUTURE_MS: u64 = 30_000;  // 30s
    const MAX_PAST_MS: u64 = 60_000;    // 60s

    let earliest = server_now_ms.saturating_sub(MAX_PAST_MS);
    let latest = server_now_ms.saturating_add(MAX_FUTURE_MS);

    if observed_at_ms > latest {
        tracing::warn!(
            "Clamping future timestamp: observed_at_ms={} > server_now+30s={}",
            observed_at_ms, latest
        );
        latest
    } else if observed_at_ms < earliest {
        tracing::warn!(
            "Clamping stale timestamp: observed_at_ms={} < server_now-60s={}",
            observed_at_ms, earliest
        );
        earliest
    } else {
        observed_at_ms
    }
}
