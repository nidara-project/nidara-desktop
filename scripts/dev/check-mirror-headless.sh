#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Physical scanout acceptance is separate. This exercises real GL/client/capture/input locally.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${OUT:-$repo/target/mirror/headless-$(date +%s-%N)}
mkdir -p "$(dirname "$out")"
mkdir -m 700 "$out"
out=$(realpath "$out")
runtime=$(mktemp -d /tmp/nd-mirror-XXXXXX)
trap 'rm -rf "$runtime"' EXIT
mkdir -m 700 "$out/config"
export MIRROR_EVIDENCE="$out"
export HYALO_CONTROL="$out/control"
cargo build --locked --manifest-path "$repo/hyalo/Cargo.toml" -p nidara-hyalo >"$out/build.log" 2>&1
probe=${CARGO_TARGET_DIR:-$repo/hyalo/target}/debug/nidara-hyalo
env -u DISPLAY XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$out/config" \
    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LIBGL_ALWAYS_SOFTWARE=1 \
    GTK_USE_PORTAL=0 GTK_A11Y=none NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory \
    timeout 60s dbus-run-session -- cage -d -- "$probe" --mirror-probe >"$out/check.log" 2>&1
cat "$out/check.log"
