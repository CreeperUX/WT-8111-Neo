use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

use crate::rooms::{RoomError, RoomManager};

pub struct AppState {
    pub rooms: Arc<Mutex<RoomManager>>,
    pub start_time: std::time::Instant,
}

pub fn build_router(state: AppState) -> Router {
    let shared = Arc::new(state);

    Router::new()
        .route("/healthz", get(healthz))
        .route("/version", get(version))
        .route("/api/rooms", get(list_rooms).post(create_room))
        .route("/api/rooms/{room_id}", get(get_room))
        .route("/api/rooms/{room_id}/join", post(join_room))
        .route("/ws/rooms/{room_id}/relay", get(ws_relay))
        .route("/ws/rooms/{room_id}/viewer", get(ws_viewer))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(shared)
}

// ── HTTP handlers ──

async fn healthz(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let rooms = state.rooms.lock().await;
    Json(serde_json::json!({
        "ok": true,
        "service": "cloud-tactical-server",
        "uptime_secs": state.start_time.elapsed().as_secs(),
        "rooms": rooms.room_count(),
    }))
}

async fn version() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "service": "cloud-tactical-server",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": 1,
    }))
}

#[derive(Deserialize)]
struct CreateRoomRequest {
    #[serde(default)]
    room_id: Option<String>,
    password: Option<String>,
    player_name: Option<String>,
}

#[derive(Serialize)]
struct RoomResponse {
    room_id: String,
    relay_url: String,
    viewer_url: String,
}

async fn create_room(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<RoomResponse>, AppError> {
    let mut rooms = state.rooms.lock().await;
    let room_id = req
        .room_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string().split_at(8).0.to_string());

    let handle = rooms.create_room(room_id.clone(), req.password)?;

    Ok(Json(RoomResponse {
        room_id,
        relay_url: format!("/ws/rooms/{}/relay", handle.info.room_id),
        viewer_url: format!("/ws/rooms/{}/viewer", handle.info.room_id),
    }))
}

async fn list_rooms(
    State(state): State<Arc<AppState>>,
) -> Json<Vec<serde_json::Value>> {
    let rooms = state.rooms.lock().await;
    let list: Vec<_> = rooms
        .list_rooms()
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "room_id": r.room_id,
                "has_password": r.password_hash.is_some(),
                "created_secs_ago": r.created_at.elapsed().as_secs(),
                "relay_count": r.relay_count,
                "viewer_count": r.viewer_count,
            })
        })
        .collect();

    Json(list)
}

async fn get_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rooms = state.rooms.lock().await;
    let room = rooms
        .get_room(&room_id)
        .ok_or(RoomError::RoomNotFound)?;

    Ok(Json(serde_json::json!({
        "room_id": room.info.room_id,
        "has_password": room.info.password_hash.is_some(),
        "created_secs_ago": room.info.created_at.elapsed().as_secs(),
        "relay_count": room.info.relay_count,
        "viewer_count": room.info.viewer_count,
        "relay_url": format!("/ws/rooms/{}/relay", room_id),
        "viewer_url": format!("/ws/rooms/{}/viewer", room_id),
    })))
}

#[derive(Deserialize)]
struct JoinRoomRequest {
    password: Option<String>,
}

async fn join_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    Json(req): Json<JoinRoomRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rooms = state.rooms.lock().await;
    let room = rooms
        .get_room(&room_id)
        .ok_or(RoomError::RoomNotFound)?;

    if let Some(ref _hash) = room.info.password_hash {
        let provided = req.password.unwrap_or_default();
        if !rooms.verify_password(&room_id, &provided) {
            return Err(RoomError::InvalidPassword.into());
        }
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "room_id": room_id,
        "relay_url": format!("/ws/rooms/{}/relay", room_id),
        "viewer_url": format!("/ws/rooms/{}/viewer", room_id),
    })))
}

// ── WebSocket handlers ──

async fn ws_relay(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let rooms = state.rooms.lock().await;
    let room = rooms.get_room(&room_id).ok_or(RoomError::RoomNotFound)?;

    let client_id = uuid::Uuid::new_v4().to_string();

    Ok(ws.on_upgrade(move |socket| {
        crate::relay::handle_relay(socket, room, client_id)
    }))
}

async fn ws_viewer(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let rooms = state.rooms.lock().await;
    let room = rooms.get_room(&room_id).ok_or(RoomError::RoomNotFound)?;

    let client_id = uuid::Uuid::new_v4().to_string();

    Ok(ws.on_upgrade(move |socket| {
        crate::viewer::handle_viewer(socket, room, client_id)
    }))
}

// ── 错误处理 ──

struct AppError {
    status: StatusCode,
    message: String,
}

impl From<RoomError> for AppError {
    fn from(e: RoomError) -> Self {
        let status = match &e {
            RoomError::RoomNotFound => StatusCode::NOT_FOUND,
            RoomError::InvalidPassword => StatusCode::FORBIDDEN,
            RoomError::RoomFull => StatusCode::SERVICE_UNAVAILABLE,
            RoomError::RoomExists => StatusCode::CONFLICT,
            RoomError::TooManyRooms => StatusCode::SERVICE_UNAVAILABLE,
        };

        AppError {
            status,
            message: e.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = serde_json::json!({
            "ok": false,
            "error": self.message
        });

        Response::builder()
            .status(self.status)
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }
}
