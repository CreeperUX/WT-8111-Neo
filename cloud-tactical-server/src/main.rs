mod config;
mod fusion;
mod mod_pb;
mod relay;
mod rooms;
mod server;
mod viewer;

use std::sync::Arc;
use tokio::sync::Mutex;

use crate::config::ServerConfig;
use crate::rooms::RoomManager;
use crate::server::AppState;

#[tokio::main]
async fn main() {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("cloud_tactical_server=debug".parse().unwrap())
                .add_directive("tower_http=info".parse().unwrap()),
        )
        .init();

    // 加载配置
    let config = ServerConfig::load();
    let addr = config.socket_addr();

    tracing::info!(
        "WT 8111 Neo Cloud Tactical Server v{}",
        env!("CARGO_PKG_VERSION")
    );
    tracing::info!("Fusion interval: {}ms", config.fusion_interval_ms);
    tracing::info!("Track history: {}s, ROI TTL: {}s", config.track_history_secs, config.roi_ttl_secs);
    tracing::info!("Max rooms: {}, Max clients/room: {}", config.max_rooms, config.max_clients_per_room);

    // 构建应用状态
    let state = AppState {
        rooms: Arc::new(Mutex::new(RoomManager::new(&config))),
        start_time: std::time::Instant::now(),
    };

    let app = server::build_router(state);

    // 启动
    tracing::info!("Listening on {}", addr);
    tracing::info!("Health check: http://{}/healthz", addr);
    tracing::info!("WebSocket relay: ws://{}/ws/rooms/{{room_id}}/relay", addr);
    tracing::info!("WebSocket viewer: ws://{}/ws/rooms/{{room_id}}/viewer", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind address");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("Shutting down...");
        })
        .await
        .unwrap();
}
