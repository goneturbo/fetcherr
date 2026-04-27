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

RUN apk add --no-cache ffmpeg

ARG FETCHERR_VERSION=""
ARG FETCHERR_COMMIT=""
ARG FETCHERR_IMAGE_TAG=""
ARG FETCHERR_BUILD_DATE=""

ENV FETCHERR_VERSION=$FETCHERR_VERSION \
    FETCHERR_COMMIT=$FETCHERR_COMMIT \
    FETCHERR_IMAGE_TAG=$FETCHERR_IMAGE_TAG \
    FETCHERR_BUILD_DATE=$FETCHERR_BUILD_DATE

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 9990

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:9990/healthz >/dev/null || exit 1

CMD ["node", "dist/index.js"]
