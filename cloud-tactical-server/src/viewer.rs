use axum::extract::ws::{Message, WebSocket};
use futures_util::StreamExt;
use prost::Message as ProstMessage;
use tokio::sync::broadcast;

use crate::fusion::FusionResult;
use crate::mod_pb::{
    ws_envelope, FusedSnapshot, FusedTrack, InterestRegion, TacticalSummary, WsEnvelope,
};
use crate::rooms::RoomHandle;

/// 处理 viewer WebSocket 连接
pub async fn handle_viewer(
    mut ws: WebSocket,
    room: RoomHandle,
    client_id: String,
) {
    tracing::info!("Viewer {client_id} connected to room {}", room.info.room_id);

    let mut snap_rx = room.snapshot_tx.subscribe();

    loop {
        tokio::select! {
            result = snap_rx.recv() => {
                match result {
                    Ok(fusion_result) => {
                        let snapshot = build_snapshot(&fusion_result, &room.info.room_id);
                        let envelope = WsEnvelope {
                            payload: Some(ws_envelope::Payload::Snapshot(snapshot)),
                        };

                        let buf = envelope.encode_to_vec();
                        if ws.send(Message::Binary(buf.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!("Viewer {client_id}: lagged by {skipped} frames");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }

            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) => break,
                    Some(Err(e)) => {
                        tracing::warn!("Viewer {client_id}: WS error: {e}");
                        break;
                    }
                    None => break,
                    _ => {}
                }
            }
        }
    }

    tracing::info!("Viewer {client_id} disconnected from room {}", room.info.room_id);
}

fn build_snapshot(result: &FusionResult, room_id: &str) -> FusedSnapshot {
    let tracks: Vec<FusedTrack> = result
        .tracks
        .iter()
        .map(|t| FusedTrack {
            track_id: t.track_id.clone(),
            label_id: t.label_id,
            class_id: t.class_id,
            affiliation: t.affiliation,
            x_u16: t.x_u16,
            y_u16: t.y_u16,
            heading_i16: t.heading_i16,
            vx_i16: t.vx_i16,
            vy_i16: t.vy_i16,
            confidence_u8: t.confidence_u8,
            last_seen_ms_ago: 0,
            source_count: t.source_count,
            flags: t.flags,
        })
        .collect();

    let rois: Vec<InterestRegion> = result
        .rois
        .iter()
        .map(|r| InterestRegion {
            track_id: r.track_id.clone(),
            x_u16: r.x_u16,
            y_u16: r.y_u16,
            radius_u16: r.radius_u16,
            expires_in_ms: r.expires_in_ms,
            confidence_u8: r.confidence_u8,
        })
        .collect();

    FusedSnapshot {
        protocol_version: 1,
        room_id: room_id.to_string(),
        seq: 0,
        server_time_ms: unix_ms(),
        map_generation: 0,
        tracks,
        interest_regions: rois,
        summary: Some(TacticalSummary {
            total_tracks: result.total_count,
            hostile_tracks: result.hostile_count,
            friendly_tracks: result.friendly_count,
            stale_tracks: result.stale_count,
            interest_regions: result.rois.len() as u32,
        }),
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
