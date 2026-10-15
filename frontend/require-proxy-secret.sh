#!/bin/sh
# Runs before nginx starts (/docker-entrypoint.d): refuse to start without
# the Edge proxy secret, rather than serve a site nobody can load.
if [ "${#PROXY_SECRET}" -lt 32 ]; then
    echo "FATAL: PROXY_SECRET must be set (32+ characters, the same as LOGISIM_PROXY_SECRET in the Edge stack's .env): LogiSim only answers requests that come through the Edge reverse proxy" >&2
    exit 1
fi
