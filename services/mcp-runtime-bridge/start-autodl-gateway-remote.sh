#!/usr/bin/env bash
set -euo pipefail

AUTODL_HOST="${AUTODL_HOST:-connect.westd.seetacloud.com}"
AUTODL_PORT="${AUTODL_PORT:-46294}"
AUTODL_USER="${AUTODL_USER:-root}"
AUTODL_KEY="${AUTODL_KEY:-/root/.ssh/autodl_bridge_ed25519}"

exec /usr/bin/ssh \
  -i "${AUTODL_KEY}" \
  -o BatchMode=yes \
  -o ConnectTimeout=20 \
  -o StrictHostKeyChecking=accept-new \
  -p "${AUTODL_PORT}" \
  "${AUTODL_USER}@${AUTODL_HOST}" \
  'if ! test -s /root/comfyui-gateway.pid || ! kill -0 "$(cat /root/comfyui-gateway.pid)" 2>/dev/null; then
     rm -f /root/comfyui-gateway.pid
     start-stop-daemon --start --background --make-pidfile \
       --pidfile /root/comfyui-gateway.pid \
       --chdir /root/comfyui-gateway \
       --startas /usr/local/bin/python3 \
       --output /root/gateway.log -- main.py
   fi'
