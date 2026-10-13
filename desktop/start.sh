#!/bin/sh
set -eu
PIXELART_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PIXELART_ELECTRON="$PIXELART_ROOT/desktop/node_modules/electron/dist/electron"
if [ ! -x "$PIXELART_ELECTRON" ]; then
  printf '%s\n' '请先安装桌面依赖：npm --prefix desktop install && npm --prefix desktop run setup（Node.js >= 22.12）' >&2
  exit 1
fi
exec "$PIXELART_ELECTRON" "$PIXELART_ROOT/desktop"
