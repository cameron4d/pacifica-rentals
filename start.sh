#!/bin/bash

set -a
source .env
set +a

node server.js &
SERVER_PID=$!
echo "Express server started (PID: $SERVER_PID)"

PORT="${PORT:-5500}"
SCHEME="http"
[ -f key.pem ] && [ -f cert.pem ] && SCHEME="https"
BACKEND_URL="$SCHEME://localhost:$PORT"

# Wait for Express to come up before launching browser-sync
for _ in $(seq 1 30); do
  if curl -sk -o /dev/null "$BACKEND_URL"; then break; fi
  sleep 0.5
done

# browser-sync proxies the Express server, watches static files,
# and auto-reloads the browser tab on save.
npx browser-sync start \
  --proxy "$BACKEND_URL" \
  --files "index.html, architecture.html, pulse-brief-utils.js, *.css" \
  --port 3000 \
  --no-notify \
  --no-ui &
BS_PID=$!
echo "browser-sync started (PID: $BS_PID) — http://localhost:3000"

trap 'kill $SERVER_PID $BS_PID 2>/dev/null' EXIT
wait
