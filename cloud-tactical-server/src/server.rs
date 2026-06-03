use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

use crate::rooms::{MapImage, RoomError, RoomManager};

const CLOUD_WEBGUI_HTML: &str = include_str!("../webgui/index.html");
const CLOUD_MAP_HTML: &str = include_str!("../webgui/map.html");

pub struct AppState {
    pub rooms: Arc<Mutex<RoomManager>>,
    pub start_time: std::time::Instant,
    pub max_map_image_bytes: usize,
}

pub fn build_router(state: AppState) -> Router {
    let max_map_image_bytes = state.max_map_image_bytes;
    let shared = Arc::new(state);

    Router::new()
        .route("/", get(web_gui))
        .route("/rooms", get(web_gui))
        .route("/map", get(cloud_map))
        .route("/healthz", get(healthz))
        .route("/version", get(version))
        .route("/api/rooms", get(list_rooms).post(create_room))
        .route("/api/rooms/{room_id}", get(get_room))
        .route("/api/rooms/{room_id}/join", post(join_room))
        .route(
            "/api/rooms/{room_id}/map-image",
            get(get_room_map_image).put(upload_room_map_image),
        )
        .route("/ws/rooms/{room_id}/relay", get(ws_relay))
        .route("/ws/rooms/{room_id}/viewer", get(ws_viewer))
        .layer(DefaultBodyLimit::max(max_map_image_bytes))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(shared)
}

// ── HTTP handlers ──

async fn web_gui() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(CLOUD_WEBGUI_HTML))
        .expect("failed to build Web GUI response")
}

async fn cloud_map() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(CLOUD_MAP_HTML))
        .expect("failed to build cloud map response")
}

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
            let has_map_image = rooms.has_map_image(&r.room_id);
            serde_json::json!({
                "room_id": r.room_id,
                "has_password": r.password_hash.is_some(),
                "created_secs_ago": r.created_at.elapsed().as_secs(),
                "relay_count": r.relay_count,
                "viewer_count": r.viewer_count,
                "map_generation": r.map_generation,
                "has_map_image": has_map_image,
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
    let has_map_image = rooms.has_map_image(&room_id);

    Ok(Json(serde_json::json!({
        "room_id": room.info.room_id,
        "has_password": room.info.password_hash.is_some(),
        "created_secs_ago": room.info.created_at.elapsed().as_secs(),
        "relay_count": room.info.relay_count,
        "viewer_count": room.info.viewer_count,
        "map_generation": room.info.map_generation,
        "has_map_image": has_map_image,
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

async fn upload_room_map_image(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    if body.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "Map image upload body is empty",
        ));
    }

    if body.len() > state.max_map_image_bytes {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "Map image exceeds {} byte limit",
                state.max_map_image_bytes
            ),
        ));
    }

    let content_type = normalize_image_content_type(&headers, &body)?;
    let map_generation = read_u32_header(&headers, "x-wt8111-map-generation").unwrap_or(0);
    let uploaded_by = read_string_header(&headers, "x-wt8111-client-id")
        .unwrap_or_else(|| "unknown".into());
    let password = read_string_header(&headers, "x-wt8111-room-password").unwrap_or_default();

    let mut rooms = state.rooms.lock().await;
    let room = rooms
        .get_room(&room_id)
        .ok_or(RoomError::RoomNotFound)?;

    if room.info.password_hash.is_some() && !rooms.verify_password(&room_id, &password) {
        return Err(RoomError::InvalidPassword.into());
    }

    let image = MapImage {
        bytes: body,
        content_type,
        uploaded_at: std::time::Instant::now(),
        uploaded_by,
        map_generation,
    };
    let (accepted, stored) = rooms.store_first_map_image(&room_id, image)?;

    if accepted {
        tracing::info!(
            "Room {} accepted map image from {} ({} bytes, generation {})",
            room_id,
            stored.uploaded_by,
            stored.bytes.len(),
            stored.map_generation
        );
    } else {
        tracing::debug!(
            "Room {} ignored later map image upload; first image came from {}",
            room_id,
            stored.uploaded_by
        );
    }

    let status = if accepted {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };

    Ok((
        status,
        Json(serde_json::json!({
            "ok": true,
            "accepted": accepted,
            "room_id": room_id,
            "bytes": stored.bytes.len(),
            "content_type": stored.content_type,
            "map_generation": stored.map_generation,
            "uploaded_secs_ago": stored.uploaded_at.elapsed().as_secs(),
        })),
    )
        .into_response())
}

async fn get_room_map_image(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> Result<Response, AppError> {
    let image = {
        let rooms = state.rooms.lock().await;
        rooms.get_map_image(&room_id)?
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, image.content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-WT8111-Map-Generation", image.map_generation.to_string())
        .body(Body::from(image.bytes))
        .map_err(|_| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response"))
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

impl AppError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl From<RoomError> for AppError {
    fn from(e: RoomError) -> Self {
        let status = match &e {
            RoomError::RoomNotFound => StatusCode::NOT_FOUND,
            RoomError::MapImageMissing => StatusCode::NOT_FOUND,
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

fn normalize_image_content_type(headers: &HeaderMap, body: &Bytes) -> Result<String, AppError> {
    if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png".into());
    }

    if body.starts_with(b"\xff\xd8\xff") {
        return Ok("image/jpeg".into());
    }

    if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        return Ok("image/gif".into());
    }

    if body.starts_with(b"RIFF") && body.get(8..12) == Some(&b"WEBP"[..]) {
        return Ok("image/webp".into());
    }

    let content_type = read_string_header(headers, header::CONTENT_TYPE.as_str())
        .and_then(|value| value.split(';').next().map(|value| value.trim().to_ascii_lowercase()))
        .unwrap_or_default();

    if content_type.starts_with("image/") {
        return Ok(content_type);
    }

    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        "Map image upload must be an image",
    ))
}

fn read_string_header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_u32_header(headers: &HeaderMap, name: &str) -> Option<u32> {
    read_string_header(headers, name)?.parse().ok()
}
