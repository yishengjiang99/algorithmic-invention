#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/wasm/wavetable"
export PATH="${HOME}/.cargo/bin:${PATH}"
cargo build --release --target wasm32-unknown-unknown
mkdir -p "$ROOT/public/wasm"
cp target/wasm32-unknown-unknown/release/wavetable.wasm "$ROOT/public/wasm/wavetable.wasm"
echo "wrote public/wasm/wavetable.wasm ($(wc -c < "$ROOT/public/wasm/wavetable.wasm") bytes)"
