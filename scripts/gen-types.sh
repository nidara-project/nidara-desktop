#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/gen-types.sh — generate the git-ignored @girs/ typings.
# Replaces `ags types -d .` (2026-08-18), which was this exact ts-for-gir
# invocation wrapped in a spinner.
#
#   scripts/gen-types.sh [target-dir]        # default: ui/shell
#
# Reads the system's .gir XML (shipped by the -devel side of each GI library)
# and writes ~58 MB of .d.ts into <target>/@girs. Needed only for `npm run
# typecheck` and editor IntelliSense — no build consumes it, which is why it is
# git-ignored and why CI downloads a published snapshot instead
# (scripts/dev/publish-ci-typings.sh).
#
# ⚠️ It generates EVERY typelib on the machine, not just the ones we import.
# That is deliberate and inherited: narrowing the list means maintaining it, and
# a missing module shows up as a wall of "has no exported member" errors that
# look like real type errors.
# ⚠️ ts-for-gir is deliberately UNPINNED (as it was under AGS): it is a dev-only
# instrument whose output is regenerated, never committed. Pin it with
# TS_FOR_GIR=@ts-for-gir/cli@x.y.z if a release ever breaks generation.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

target="${1:-$(dirname "$(realpath "$0")")/../ui/shell}"
target="$(realpath "$target")"

command -v npx >/dev/null 2>&1 || { echo "gen-types.sh: npx not found (install nodejs/npm)" >&2; exit 1; }

gir_dirs=(-g /usr/local/share/gir-1.0 -g /usr/share/gir-1.0 -g '/usr/share/*/gir-1.0')
if [ -n "${EXTRA_GIR_DIRS:-}" ]; then
    IFS=':' read -r -a _extra <<< "$EXTRA_GIR_DIRS"
    for d in "${_extra[@]}"; do [ -n "$d" ] && gir_dirs+=(-g "$d"); done
fi

echo "Generating $target/@girs — this takes a few minutes…"
npx -y "${TS_FOR_GIR:-@ts-for-gir/cli}" generate '*' \
    --ignoreVersionConflicts \
    --outdir "$target/@girs" \
    "${gir_dirs[@]}"
echo "[OK] $target/@girs"
