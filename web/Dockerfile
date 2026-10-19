# syntax=docker/dockerfile:1
# Base images are pinned by digest so builds are reproducible and a moved tag
# cannot change what we ship. The tag is kept for readability (Docker ignores
# it when a digest is present). Refresh with:
#   docker buildx imagetools inspect <tag>
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Baked into the static JS bundle at build time (see docker-compose.yml).
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build

FROM nginx:1.30-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS runtime

COPY --from=builder /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker-entrypoint.d/10-real-ip.sh /docker-entrypoint.d/10-real-ip.sh
RUN chmod +x /docker-entrypoint.d/10-real-ip.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1
