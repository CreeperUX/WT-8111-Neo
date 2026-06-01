use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use rust_embed::RustEmbed;
use tower_http::cors::{Any, CorsLayer};

pub const SERVICE_PORT: u16 = 17711;
const WT_BASE_URL: &str = "http://127.0.0.1:8111";

#[derive(RustEmbed)]
#[folder = "../dist"]
struct WebAssets;

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let state = AppState {
        http: reqwest::Client::new(),
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/wt/map.img", get(wt_map_image))
        .route("/api/wt/{*path}", get(wt_proxy))
        .fallback(static_asset)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), SERVICE_PORT);
    let url = format!("http://127.0.0.1:{SERVICE_PORT}");

    println!("WT 8111 Neo service listening on {url}");
    println!("Open this URL from another LAN device: http://<this-pc-ip>:{SERVICE_PORT}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;

    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "service": "wt-8111-neo",
        "port": SERVICE_PORT
    }))
}

async fn wt_proxy(
    State(state): State<AppState>,
    Path(path): Path<String>,
    query: axum::extract::RawQuery,
) -> impl IntoResponse {
    proxy_wt(&state.http, &path, query.0.as_deref()).await
}

async fn wt_map_image(
    State(state): State<AppState>,
    query: axum::extract::RawQuery,
) -> impl IntoResponse {
    proxy_wt(&state.http, "map.img", query.0.as_deref()).await
}

async fn proxy_wt(http: &reqwest::Client, path: &str, query: Option<&str>) -> Response<Body> {
    let url = match query {
        Some(query) if !query.is_empty() => format!("{WT_BASE_URL}/{path}?{query}"),
        _ => format!("{WT_BASE_URL}/{path}"),
    };

    let Ok(response) = http.get(url).send().await else {
        return error_response(StatusCode::BAD_GATEWAY, "War Thunder 8111 is not reachable");
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));

    match response.bytes().await {
        Ok(bytes) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .expect("failed to build WT proxy response"),
        Err(_) => error_response(
            StatusCode::BAD_GATEWAY,
            "Failed to read War Thunder 8111 response",
        ),
    }
}

async fn static_asset(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match WebAssets::get(path).or_else(|| WebAssets::get("index.html")) {
        Some(asset) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(asset.data.into_owned()))
                .expect("failed to build static asset response")
        }
        None => error_response(StatusCode::NOT_FOUND, "Asset not found"),
    }
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response<Body> {
    let body = serde_json::json!({
        "ok": false,
        "error": message.into()
    });

    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("failed to build error response")
}
