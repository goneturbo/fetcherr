#!/bin/sh
set -e

# The image runs as root only to reach this point. A bind-mounted ./data on
# the host is usually created by the Docker daemon before the container ever
# starts, so it lands owned by root regardless of what the image itself sets
# up at build time — the node user can't open a database file inside it, and
# SQLITE_CANTOPEN kills the container on every restart. Fix ownership here,
# then drop to node for the actual process.
if [ "$(id -u)" = '0' ]; then
  data_dir=$(dirname "${DATABASE_PATH:-/app/data/fetcherr.db}")
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  exec su-exec node "$@"
fi

exec "$@"
