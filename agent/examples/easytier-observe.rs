// Read-only diagnostic using exactly the Agent's production collector.
#[tokio::main]
async fn main() {
    let target = std::env::args().nth(1).expect("target IP is required");
    println!("{}", farhelm_agent::easytier::observe(&target).await);
}
