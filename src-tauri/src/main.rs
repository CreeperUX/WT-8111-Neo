mod server;

#[tokio::main]
async fn main() {
    if let Err(error) = server::run().await {
        eprintln!("WT 8111 Neo service failed: {error}");
        std::process::exit(1);
    }
}
