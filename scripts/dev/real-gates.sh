#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Run the toolkit's real-reader/real-IME checks locally, in a disposable container with Orca,
# speech-dispatcher and fcitx5 inside it (scripts/dev/real-gates/Containerfile), on the same
# headless cage → nested Hyalo path the checks already use locally. Nothing is installed on the
# host, its /etc and its session are never touched, and no vkms device is loaded.
#
#   scripts/dev/real-gates.sh CHECK [CHECK…]
#     CHECK: orca | ime | choices-orca | settings-ime | phase0 | a11y | <name>.py in scripts/ci/
#   env: REAL_GATES_CONTROLS=0  baseline only (NK_REAL_CONTROLS=0), as a PR without `full`
#        REAL_GATES_NO_BUILD=1  use the binaries already in hyalo/ and toolkit/ target/release
#        HYALO_BIN=PATH         a Hyalo built elsewhere (another worktree): not rebuilt here
#
# Evidence: toolkit/target/real-gates/<check>/ (disk, not /tmp). Needs podman (rootless).
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
[ $# -gt 0 ] || { sed -n '3,14p' "$0"; exit 2; }
image=nidara-real-gates:$(sha256sum "$repo/scripts/dev/real-gates/Containerfile" | cut -c1-12)
if ! podman image exists "$image"; then
    podman build -t "$image" -f "$repo/scripts/dev/real-gates/Containerfile" "$repo/scripts/dev/real-gates"
fi
if [ "${REAL_GATES_NO_BUILD:-}" != 1 ]; then
    [ -n "${HYALO_BIN:-}" ] || cargo build --manifest-path "$repo/hyalo/Cargo.toml" --release --locked -q
    cargo build --manifest-path "$repo/toolkit/Cargo.toml" --release --locked -q -p nk-phase0 -p nk-widgets-demo
    if [[ " $* " == *" settings-ime "* || " $* " == *" nk-settings-ime-check.py "* ]]; then
        cargo build --manifest-path "$repo/toolkit/Cargo.toml" --release --locked -q \
            -p nk-settings --features ime-gates --bin nk-settings-ime
    fi
    # The demo reads what the package installs as settings-data (NK_SETTINGS_DATA): its pages and
    # strings, then the tokens — the PKGBUILD's two exports, in its order.
    node --experimental-strip-types "$repo/scripts/export-settings-data.mjs" "$repo/build/settings-data" 2>/dev/null
    node --experimental-strip-types "$repo/scripts/export-tokens.mjs" "$repo/build/settings-data" 2>/dev/null
fi
hyalo=${HYALO_BIN:-$repo/hyalo/target/release/nidara-hyalo}
hyalo=$(realpath "$hyalo")
# A worktree's .git points into the main checkout's: mounted read-only for `git rev-parse`.
gitdir=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)
status=0
for check in "$@"; do
    case "$check" in
        orca) script=nk-orca-check.py ;;
        ime) script=nk-fcitx5-check.py ;;
        choices-orca) script=nk-choices-orca-check.py ;;
        settings-ime) script=nk-settings-ime-check.py ;;
        phase0) script=nk-phase0-check.py ;;
        a11y) script=nk-a11y-check.py ;;
        *.py) script=$check ;;
        *) echo "unknown check: $check" >&2; exit 2 ;;
    esac
    [ -f "$repo/scripts/ci/$script" ] || { echo "no scripts/ci/$script" >&2; exit 2; }
    # The demo's checks need its harness: it serves a Settings portal the demo reads its look
    # from (portal-fixture.py); phase 0's window does not, and has its own.
    harness=toolkit/phase0/check-headless.sh
    case "$script" in nk-choices-*|nk-widgets-check.py|nk-settings-ime-check.py) harness=toolkit/widgets-demo/check-headless.sh ;; esac
    out="$repo/toolkit/target/real-gates/${script%.py}"
    rm -rf "$out"; mkdir -p "$out"
    echo "── $script (evidence: ${out#"$repo/"})"
    # The checks keep a short log path inside the container (speech-dispatcher's Unix socket
    # path must stay under 108 bytes) and the evidence is copied out at the end.
    podman run --rm --userns=keep-id --security-opt label=disable \
        $( [ -d /dev/dri ] && echo --device /dev/dri ) \
        -v "$repo:$repo" -v "$hyalo:$hyalo:ro" -v "$gitdir:$gitdir:ro" -w "$repo" --tmpfs /tmp:exec \
        -e HYALO_BIN="$hyalo" \
        -e HOME=/tmp/home -e NK_PHASE0_CHECK="$script" -e NK_PHASE0_LOG=/tmp/ev \
        -e NK_WIDGETS_CHECK="$script" -e NK_WIDGETS_LOG=/tmp/ev \
        -e NK_WIDGETS_BIN="$repo/toolkit/target/release/nk-widgets-demo" \
        -e NK_REAL_CONTROLS="${REAL_GATES_CONTROLS:-1}" \
        -e NK_SETTINGS_IME_BIN="$repo/toolkit/target/release/nk-settings-ime" \
        -e NK_SETTINGS_DATA="$repo/build/settings-data" \
        "$image" bash -c '
            mkdir -p /tmp/home /tmp/ev
            rc=0; '"$harness"' || rc=$?
            cp -a /tmp/ev/. "'"$out"'"/ 2>/dev/null || true
            exit $rc' || status=1
done
exit "$status"
