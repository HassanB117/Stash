# syntax=docker/dockerfile:1
FROM node:20-alpine

LABEL org.opencontainers.image.source=https://github.com/HassanB117/Stash

RUN apk add --no-cache \
    ffmpeg \
    libva-utils \
    mesa-va-gallium \
    wget && \
    if [ "$(apk --print-arch)" = "x86_64" ]; then \
      apk add --no-cache intel-media-driver; \
    fi

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js thumbs.js term.js ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=7117 \
    SESSION_COOKIE_SECURE=auto \
    REQUIRE_SETUP_TOKEN=true

EXPOSE 7117
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:7117/healthz || exit 1

CMD ["node", "server.js"]
