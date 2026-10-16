#!/bin/sh
set -eu
PIXELART_DESKTOP_DEV=1 exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/start.sh"
