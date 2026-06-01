# ── Builder ──
FROM rust:1.96-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先缓存依赖
COPY Cargo.toml Cargo.lock* ./
COPY build.rs ./
COPY protos/ protos/

RUN mkdir -p src && \
    echo 'fn main() {}' > src/main.rs && \
    cargo build --release && \
    rm -rf src

# 复制源代码并构建
COPY src/ src/
RUN cargo build --release

# ── Runtime ──
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --home /app --shell /sbin/nologin wt8111

WORKDIR /app

COPY --from=builder /app/target/release/cloud-tactical-server /app/
COPY config/server.example.yaml /app/config/server.yaml

RUN chown -R wt8111:wt8111 /app

USER wt8111

EXPOSE 17712

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD /app/cloud-tactical-server healthcheck || exit 1

ENTRYPOINT ["/app/cloud-tactical-server"]
