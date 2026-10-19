# syntax=docker/dockerfile:1
# Base images are pinned by digest so builds are reproducible and a moved tag
# cannot change what we ship. The tag is kept for readability (Docker ignores
# it when a digest is present). Refresh with:
#   docker buildx imagetools inspect <tag>
FROM rust:1-slim-bookworm@sha256:a24e292b4af7bdee351a31d3a6379972a5652f0ea22a1b6d6883324ac4f5097c AS builder

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

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime

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
