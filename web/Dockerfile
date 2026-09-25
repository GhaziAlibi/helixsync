# syntax=docker/dockerfile:1
# Base images are pinned by digest so builds are reproducible and a moved tag
# cannot change what we ship. The tag is kept for readability (Docker ignores
# it when a digest is present). Refresh with:
#   docker buildx imagetools inspect <tag>
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Baked into the static JS bundle at build time (see docker-compose.yml).
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime

COPY --from=builder /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker-entrypoint.d/10-real-ip.sh /docker-entrypoint.d/10-real-ip.sh
RUN chmod +x /docker-entrypoint.d/10-real-ip.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1
