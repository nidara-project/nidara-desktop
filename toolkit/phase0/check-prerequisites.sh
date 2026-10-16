#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Isolate real fcitx5/Orca, including Mozc's abstract socket and process discovery.
# Optional NK_PREFLIGHT_SYSROOT supplies packages extracted into a temporary root.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
case "${1:-}" in
    ime) check=nk-fcitx5-check.py ;;
    orca) check=nk-orca-check.py ;;
    *) echo "usage: $0 ime|orca" >&2; exit 2 ;;
esac
export NK_PHASE0_LOG=${NK_PHASE0_LOG:-/tmp/nk-prerequisites-$1}
mkdir -p "$NK_PHASE0_LOG"
NK_PHASE0_LOG=$(realpath "$NK_PHASE0_LOG")
export NK_PHASE0_LOG
scratch=$(mktemp -d /tmp/nk-prerequisites.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
args=(--die-with-parent --unshare-all --ro-bind / / --proc /proc
      --bind /tmp /tmp --dev-bind /dev /dev --bind "$NK_PHASE0_LOG" "$NK_PHASE0_LOG")
if [ -n "${NK_PREFLIGHT_SYSROOT:-}" ]; then
    test -d "$NK_PREFLIGHT_SYSROOT/usr" || { echo 'sysroot must contain usr/' >&2; exit 2; }
    args+=(--overlay-src /usr --overlay-src "$(realpath "$NK_PREFLIGHT_SYSROOT")/usr" --ro-overlay /usr)
fi
if [ "$1" = orca ]; then
    # sd_dummy still initializes an audio backend. libao's built-in null driver
    # gives it a working backend without reaching the user's audio server.
    mkdir -p "$scratch/etc" "$scratch/schemas"
    echo 'default_driver=null' > "$scratch/etc/libao.conf"
    args+=(--overlay-src /etc --overlay-src "$scratch/etc" --ro-overlay /etc)
    cp -a /usr/share/glib-2.0/schemas/. "$scratch/schemas/"
    if [ -n "${NK_PREFLIGHT_SYSROOT:-}" ]; then
        cp -a "$NK_PREFLIGHT_SYSROOT/usr/share/glib-2.0/schemas/." "$scratch/schemas/"
    fi
    glib-compile-schemas --strict "$scratch/schemas"
    export GSETTINGS_SCHEMA_DIR="$scratch/schemas"
fi
bwrap "${args[@]}" -- env NK_PHASE0_CHECK="$check" \
    "$repo/toolkit/phase0/check-headless.sh"
