#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
OUT="${1:-$REPO/public/wasm/wavetable.wasm}"
CLANG="${WASI_CLANG:-clang}"
mkdir -p "$(dirname "$OUT")"
"$CLANG" --target=wasm32 \
  -ffreestanding -nostdlib -fno-builtin -fno-exceptions \
  -O3 -ffast-math -Wall -Wextra \
  -Wl,--no-entry \
  -Wl,--export-dynamic \
  -Wl,--strip-all \
  -Wl,--allow-undefined-file=/dev/null \
  -Wl,--initial-memory=131072 \
  -Wl,--max-memory=131072 \
  -Wl,-z,stack-size=8192 \
  -o "$OUT" \
  "$ROOT/wavetable.c"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
