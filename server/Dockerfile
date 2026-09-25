# syntax=docker/dockerfile:1
FROM rust:1-slim-bookworm AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# Cache dependency compilation separately from application source.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && echo "" > src/lib.rs
RUN cargo build --release --locked || true

COPY . .
# SQLX_OFFLINE avoids requiring a live database during the Docker build;
# the .sqlx/ query cache (committed to the repo) is used instead. See
# docs/deployment.md.
ENV SQLX_OFFLINE=true
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --uid 10001 helixsync

WORKDIR /app
COPY --from=builder /build/target/release/helixsync-server /app/helixsync-server
COPY --from=builder /build/migrations /app/migrations

USER helixsync
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://127.0.0.1:8080/readyz || exit 1

ENTRYPOINT ["/app/helixsync-server"]
