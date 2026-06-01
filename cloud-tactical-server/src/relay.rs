use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;

use crate::fusion::ParsedObservation;
use crate::mod_pb::{
    ws_envelope, ErrorResponse, JoinResponse, ObservationFrame, WsEnvelope,
};
use crate::rooms::RoomHandle;

/// 处理 relay WebSocket 连接
pub async fn handle_relay(
    mut ws: WebSocket,
    room: RoomHandle,
    client_id: String,
) {
    let session_id = uuid::Uuid::new_v4().to_string();
    tracing::info!("Relay {client_id} connected to room {} (session {session_id})", room.info.room_id);

    // 等待 JoinRequest
    let joined = match wait_for_join(&mut ws).await {
        Ok(true) => {
            send_envelope(&mut ws, WsEnvelope {
                payload: Some(ws_envelope::Payload::JoinResponse(JoinResponse {
                    accepted: true,
                    session_id: session_id.clone(),
                    server_protocol_version: 1,
                    error_message: String::new(),
                })),
            }).await;
            true
        }
        Ok(false) => {
            send_envelope(&mut ws, WsEnvelope {
                payload: Some(ws_envelope::Payload::JoinResponse(JoinResponse {
                    accepted: false,
                    session_id: String::new(),
                    server_protocol_version: 1,
                    error_message: "Invalid protocol version".into(),
                })),
            }).await;
            let _ = ws.close().await;
            false
        }
        Err(_) => {
            let _ = ws.close().await;
            false
        }
    };

    if !joined {
        return;
    }

    // 主消息循环
    while let Some(msg) = ws.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                match WsEnvelope::decode(data.as_ref()) {
                    Ok(envelope) => {
                        match envelope.payload {
                            Some(ws_envelope::Payload::Observation(frame)) => {
                                let parsed = parse_observation(frame, &client_id);
                                let _ = room.observation_tx.send(parsed);
                            }
                            Some(ws_envelope::Payload::Ping(ping)) => {
                                send_envelope(&mut ws, WsEnvelope {
                                    payload: Some(ws_envelope::Payload::Pong(
                                        crate::mod_pb::Pong {
                                            client_time_ms: ping.client_time_ms,
                                            server_time_ms: unix_ms(),
                                        },
                                    )),
                                }).await;
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Relay {client_id}: decode error: {e}");
                        send_error(&mut ws, 400, "Invalid protobuf").await;
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Err(e) => {
                tracing::warn!("Relay {client_id}: WS error: {e}");
                break;
            }
            _ => {}
        }
    }

    tracing::info!("Relay {client_id} disconnected from room {}", room.info.room_id);
}

async fn wait_for_join(ws: &mut WebSocket) -> Result<bool, ()> {
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(5));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if let Ok(envelope) = WsEnvelope::decode(data.as_ref()) {
                            if let Some(ws_envelope::Payload::JoinRequest(req)) = envelope.payload {
                                return Ok(req.protocol_version == 1);
                            }
                        }
                    }
                    Some(Err(_)) => return Err(()),
                    None => return Err(()),
                    _ => {}
                }
            }
            _ = &mut timeout => {
                return Err(());
            }
        }
    }
}

fn parse_observation(frame: ObservationFrame, client_id: &str) -> ParsedObservation {
    ParsedObservation {
        client_id: client_id.to_string(),
        player_name: if frame.player_name.is_empty() {
            None
        } else {
            Some(frame.player_name)
        },
        seq: frame.seq,
        observed_at_ms: frame.observed_at_ms,
        map_generation: frame.map_generation,
        player_x: frame.player.map_or(0, |p| p.x_u16),
        player_y: frame.player.map_or(0, |p| p.y_u16),
        player_heading: frame.player.map_or(0, |p| p.heading_i16),
        objects: frame
            .objects
            .into_iter()
            .map(|o| crate::fusion::ParsedObject {
                local_id: o.local_id,
                label_id: o.label_id,
                class_id: o.class_id,
                affiliation: o.affiliation,
                x_u16: o.x_u16,
                y_u16: o.y_u16,
                heading_i16: o.heading_i16,
                color_id: o.color_id,
                flags: o.flags,
            })
            .collect(),
    }
}

async fn send_envelope(ws: &mut WebSocket, envelope: WsEnvelope) {
    let buf = envelope.encode_to_vec();
    let _ = ws.send(Message::Binary(buf.into())).await;
}

async fn send_error(ws: &mut WebSocket, code: u32, message: &str) {
    send_envelope(
        ws,
        WsEnvelope {
            payload: Some(ws_envelope::Payload::Error(ErrorResponse {
                code,
                message: message.into(),
            })),
        },
    )
    .await;
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
