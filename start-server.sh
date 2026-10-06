#!/bin/bash
cd /home/gitgitmiko/WEBUNIME
if pgrep -f "node server/app.js" >/dev/null; then
  exit 0
fi
mkdir -p logs
exec /usr/local/bin/node server/app.js >> logs/server.log 2>&1
