use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,

    #[serde(default = "default_port")]
    pub port: u16,

    #[serde(default = "default_fusion_interval_ms")]
    pub fusion_interval_ms: u64,

    #[serde(default = "default_track_history_secs")]
    pub track_history_secs: f64,

    #[serde(default = "default_roi_ttl_secs")]
    pub roi_ttl_secs: f64,

    #[serde(default = "default_max_rooms")]
    pub max_rooms: usize,

    #[serde(default = "default_room_password_required")]
    pub room_password_required: bool,

    #[serde(default = "default_max_clients_per_room")]
    pub max_clients_per_room: usize,

    #[serde(default = "default_max_map_image_bytes")]
    pub max_map_image_bytes: usize,
}

fn default_host() -> String {
    "0.0.0.0".into()
}

fn default_port() -> u16 {
    17712
}

fn default_fusion_interval_ms() -> u64 {
    500
}

fn default_track_history_secs() -> f64 {
    3.0
}

fn default_roi_ttl_secs() -> f64 {
    15.0
}

fn default_max_rooms() -> usize {
    100
}

fn default_room_password_required() -> bool {
    false
}

fn default_max_clients_per_room() -> usize {
    32
}

fn default_max_map_image_bytes() -> usize {
    8 * 1024 * 1024
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            fusion_interval_ms: default_fusion_interval_ms(),
            track_history_secs: default_track_history_secs(),
            roi_ttl_secs: default_roi_ttl_secs(),
            max_rooms: default_max_rooms(),
            room_password_required: default_room_password_required(),
            max_clients_per_room: default_max_clients_per_room(),
            max_map_image_bytes: default_max_map_image_bytes(),
        }
    }
}

impl ServerConfig {
    pub fn load() -> Self {
        // 优先读环境变量 CONFIG_PATH，其次读默认路径
        let path = std::env::var("CONFIG_PATH").unwrap_or_else(|_| "config/server.yaml".into());

        match std::fs::read_to_string(&path) {
            Ok(contents) => match serde_yaml::from_str(&contents) {
                Ok(config) => {
                    tracing::info!("Loaded config from {path}");
                    config
                }
                Err(e) => {
                    tracing::warn!("Failed to parse config {path}: {e}, using defaults");
                    Self::default()
                }
            },
            Err(_) => {
                tracing::info!("No config file at {path}, using defaults");
                Self::default()
            }
        }
    }

    pub fn socket_addr(&self) -> std::net::SocketAddr {
        format!("{}:{}", self.host, self.port)
            .parse()
            .expect("Invalid server address")
    }
}
