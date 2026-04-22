# syntax=docker/dockerfile:1
FROM node:20-alpine

# ffmpeg ships with ffprobe — used for video thumbnails and duration metadata
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js thumbs.js ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=7117

EXPOSE 7117
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:7117/api/csrf || exit 1

CMD ["node", "server.js"]
