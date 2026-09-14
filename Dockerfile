FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg python3 su-exec && \
    wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -O /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

ARG FETCHERR_VERSION=""
ARG FETCHERR_COMMIT=""
ARG FETCHERR_IMAGE_TAG=""
ARG FETCHERR_BUILD_DATE=""

ENV FETCHERR_VERSION=$FETCHERR_VERSION \
    FETCHERR_COMMIT=$FETCHERR_COMMIT \
    FETCHERR_IMAGE_TAG=$FETCHERR_IMAGE_TAG \
    FETCHERR_BUILD_DATE=$FETCHERR_BUILD_DATE

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chown -R node:node /app && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 9990

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:9990/healthz >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
