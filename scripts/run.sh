#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/run.sh — run a bundle from source. Replaces `ags run` (2026-08-18).
#
#   scripts/run.sh <entry.ts> [gjs args…]
#
# The dev loop's engine: bin/nidara-ui calls this when ~/.config/nidara/.dev
# exists, and `npm run dev` is the same thing by hand. It bundles the entry with
# scripts/bundle.sh (same flags as a release build — dev and prod must not
# diverge in the transform), drops the JS in $XDG_RUNTIME_DIR and execs gjs on
# it, exactly as `ags run` did.
#
# ⚠️ LD_PRELOAD is set HERE for the same reason bundle.sh writes it into the
# wrapper: without libgtk4-layer-shell the shell boots with no bar and no dock,
# and says nothing about why.
# ⚠️ CWD is the entry file's directory, like `ags run`. core/Paths.ts falls back
# to get_current_dir() when NIDARA_SHELL_ROOT is unset, so a different cwd here
# silently moves where assets and style.css are looked up.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: run.sh <entry> [gjs args…]" >&2; exit 2; }

entry="$1"; shift
[ -f "$entry" ] || { echo "run.sh: no such entry file: $entry" >&2; exit 1; }

here="$(dirname "$(realpath "$0")")"
entry_abs="$(realpath "$entry")"
entry_dir="$(dirname "$entry_abs")"

# One JS per entry file name — two bundles run side by side (shell + a probe)
# without fighting over the path.
out="${XDG_RUNTIME_DIR:-/tmp}/nidara-run-$(basename "${entry_abs%.*}").js"

"$here/bundle.sh" --js "$entry_abs" "$out"

layer_shell="${NIDARA_GTK4_LAYER_SHELL:-}"
if [ -z "$layer_shell" ]; then
    _libdir="$(pkg-config --variable=libdir gtk4-layer-shell-0 2>/dev/null || true)"
    layer_shell="${_libdir:-/usr/lib}/libgtk4-layer-shell.so"
fi

cd "$entry_dir"
exec env LD_PRELOAD="$layer_shell" gjs -m "$out" "$@"
