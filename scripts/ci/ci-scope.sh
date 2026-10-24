#!/usr/bin/env bash
# What does this change need run?
#
#   ci-scope.sh BASE_SHA        → prints code=…, gates=… and full=…, for $GITHUB_OUTPUT
#   ci-scope.sh --self-test     → both classifiers against known lists; exits 1 if wrong
#
# code: the long jobs (smoke, hyalo, toolkit, sessiond). false ONLY when every changed
#   path is a `.md`: no long job reads one at run time (the packaging and the assistant
#   do, and their jobs are short and always run).
# gates: the real fcitx5 and Orca matrices inside the Hyalo job (~35 of its ~45 min).
#   They test typing (input methods) and the screen reader in the toolkit's test window on
#   Hyalo, so true ONLY when a changed path is one they use (`needs_gates` below) — a list
#   of what RUNS them (owner, 2026-10-19; it was a list of what skipped them until then, and
#   nearly every Hyalo PR ran the 35 minutes).
# full: the matrices' controls (each assertion re-run with a fault) and their second scale
#   (1.25), the AT-SPI check's controls (nk-a11y-check.py, ~2 of its ~3 min) and the control
#   material check's (hyalo-control-material-check.py, seven of its ten runs): true only
#   when the checks or the test window's faults change (`needs_full`).
# What a skip lets through — and two queued changes that only break together — the nightly
# full run on main finds (`schedule` in ci.yml: no base, so everything runs) and reports.
# Every doubt — no base, a failed fetch, an empty diff — is true for all three.
set -uo pipefail

# Reads paths on stdin, one per line.
classify() {
    local any=0 path
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        any=1
        case "$path" in
            *.md) ;;
            *) echo true; return ;;
        esac
    done
    [ "$any" -eq 1 ] && echo false || echo true
}

# What the real fcitx5 and Orca matrices USE: typing (keyboard, input methods, text-input),
# focus, the screen reader (and its keyboard), the layers a field can live in, and the
# toolkit's crates and test window they drive — plus the checks themselves. A list of what
# RUNS them (owner, 2026-10-19: the matrices are ~35 min of every PR's ~45, and a PR that
# touches none of this gets the same result every time). What a path outside it breaks there,
# the nightly full run finds.
needs_gates() {
    case "$1" in
        *.md) return 1 ;;
        hyalo/compositor/src/input.rs|hyalo/compositor/src/focus.rs|hyalo/compositor/src/a11y.rs) return 0 ;;
        hyalo/compositor/src/handlers.rs|hyalo/compositor/src/shortcuts.rs|hyalo/compositor/src/binds.rs) return 0 ;;
        hyalo/compositor/src/control.rs|hyalo/compositor/src/protocols/layers*|hyalo/compositor/src/protocols/focus_grab.rs) return 0 ;;
        hyalo/Cargo.lock|hyalo/Cargo.toml|hyalo/compositor/Cargo.toml) return 0 ;;
        toolkit/settings-slice/*) return 1 ;;
        # The native Settings (#915): nothing the matrices drive yet. Its own keyboard and Orca
        # walk (PHASE1.md gate 2) comes with its window; then it joins this list.
        toolkit/settings/*) return 1 ;;
        toolkit/*) return 0 ;;
        protocols/nidara-layers-v1.xml|config/hyalo/*) return 0 ;;
        scripts/ci/nk-fcitx5-check.py|scripts/ci/nk-orca-check.py|scripts/ci/nk-real-common.py|scripts/ci/nk-widgets-check.py) return 0 ;;
        scripts/ci/nk-a11y-check.py|scripts/ci/nk-choices-check.py|scripts/ci/nk-choices-orca-check.py) return 0 ;;
    esac
    return 1
}

# The matrices' CONTROLS (each assertion re-run with a fault injected, to prove it can fail)
# and their second scale: they change only with the checks, the faults the test window
# injects, or the window's scaling — so a PR runs them only then; the nightly run always.
needs_full() {
    case "$1" in
        scripts/ci/nk-fcitx5-check.py|scripts/ci/nk-orca-check.py|scripts/ci/nk-real-common.py) return 0 ;;
        scripts/ci/nk-a11y-check.py|scripts/ci/nk-choices-check.py|toolkit/widgets-demo/src/choices.rs) return 0 ;;
        scripts/ci/nk-choices-orca-check.py) return 0 ;;
        scripts/ci/hyalo-control-material-check.py|scripts/ci/hyalo-control-material-probe.c) return 0 ;;
        toolkit/phase0/*) return 0 ;;
    esac
    return 1
}

# Reads paths on stdin, one per line: true when one of them needs it — or when there are none
# (an empty diff is a doubt, and the doubt runs).
any_needs() {
    local need=$1 any=0 path
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        any=1
        "$need" "$path" && { echo true; return; }
    done
    [ "$any" -eq 1 ] && echo false || echo true
}
gates() { any_needs needs_gates; }
full() { any_needs needs_full; }

if [ "${1:-}" = --self-test ]; then
    fail=0
    check() {
        local want=$1 got
        shift
        got=$(printf '%s\n' "$@" | classify)
        if [ "$got" != "$want" ]; then
            echo "::error::ci-scope: code [$*] gave $got, want $want"
            fail=1
        fi
    }
    check_gates() {
        local want=$1 got
        shift
        got=$(printf '%s\n' "$@" | gates)
        if [ "$got" != "$want" ]; then
            echo "::error::ci-scope: gates [$*] gave $got, want $want"
            fail=1
        fi
    }
    check false toolkit/CONTRACT.md
    check false README.md .claude/skills/nidara/SKILL.md
    check true toolkit/CONTRACT.md hyalo/compositor/src/control.rs
    check true scripts/ci/hyalo-smoke.sh
    check true docs/notes.md.bak
    check true ''
    check_full() {
        local want=$1 got
        shift
        got=$(printf '%s\n' "$@" | full)
        if [ "$got" != "$want" ]; then
            echo "::error::ci-scope: full [$*] gave $got, want $want"
            fail=1
        fi
    }
    # What does not touch typing, focus, the screen reader or the toolkit: no matrices.
    check_gates false ui/shell/surfaces/bar/Bar.tsx README.md
    check_gates false bin/nidara-agent config/hypr/hyprland.lua session/daemon/src/model.rs
    check_gates false hyalo/compositor/src/render/decor.rs hyalo/compositor/src/wm/motion.rs hyalo/compositor/src/ipc/server.rs
    check_gates false toolkit/settings-slice/src/host.rs protocols/nidara-material-v1.xml scripts/ci/nk-layer-motion-check.py
    check_gates false hyalo/compositor/src/protocols/material.rs scripts/ci/hyalo-resize-check.py scripts/export-tokens.mjs
    check_gates false hyalo/compositor/src/backend/mod.rs hyalo/compositor/src/render/controls.rs scripts/ci/hyalo-window-controls-probe.c
    check_gates false scripts/ci/hyalo-smoke.sh .github/workflows/ci.yml .gitignore
    check_gates false hyalo/compositor/src/newmodule.rs newdir/anything
    check_gates false toolkit/crates/nk-text/README.md
    check_gates false toolkit/settings/src/session.rs toolkit/settings/tests/bus.rs
    # What does: the matrices.
    check_gates true hyalo/compositor/src/control.rs
    check_gates true hyalo/compositor/src/render/decor.rs hyalo/compositor/src/input.rs
    check_gates true hyalo/compositor/src/a11y.rs
    check_gates true hyalo/compositor/src/focus.rs
    check_gates true hyalo/compositor/src/protocols/layers/presentation.rs
    check_gates true hyalo/Cargo.lock
    check_gates true toolkit/crates/nk-wayland/src/material.rs
    check_gates true toolkit/crates/nk-widgets/src/lib.rs
    check_gates true toolkit/widgets-demo/src/main.rs
    check_gates true scripts/ci/nk-widgets-check.py
    check_gates true scripts/ci/nk-choices-check.py
    check_gates true toolkit/crates/nk-newcrate/src/lib.rs
    check_gates true toolkit/phase0/src/main.rs
    check_gates true scripts/ci/nk-real-common.py
    check_gates true ui/shell/app.ts toolkit/crates/nk-text/src/lib.rs
    check_gates true protocols/nidara-layers-v1.xml
    check_gates true config/hyalo/hyalo.toml
    check_gates true scripts/ci/nk-orca-check.py
    check_gates true scripts/ci/nk-choices-orca-check.py
    check_gates true ''
    # Their controls and second scale: only when the checks or the faults change.
    check_full false toolkit/crates/nk-text/src/lib.rs hyalo/compositor/src/input.rs
    check_full false ui/shell/app.ts
    check_full true scripts/ci/nk-fcitx5-check.py
    check_full true scripts/ci/nk-a11y-check.py
    check_full true scripts/ci/nk-choices-check.py
    check_full true scripts/ci/nk-choices-orca-check.py
    check_full true toolkit/widgets-demo/src/choices.rs
    check_full false toolkit/widgets-demo/src/main.rs
    check_full true scripts/ci/hyalo-control-material-check.py
    check_full false toolkit/crates/nk-a11y/src/lib.rs
    check_full true toolkit/phase0/src/main.rs
    check_full true ''
    [ "$fail" -eq 0 ] && echo "ci-scope self-test: ok"
    exit "$fail"
fi

base=${1:-}
if [ -z "$base" ] || ! git fetch --quiet --depth=1 origin "$base" \
        || ! changed=$(git diff --name-only "$base" HEAD); then
    echo "ci-scope: cannot diff against '${base}', running everything" >&2
    echo code=true
    echo gates=true
    echo full=true
    exit 0
fi
printf '%s\n' "$changed" | sed 's/^/ci-scope: changed /' >&2
echo "code=$(printf '%s\n' "$changed" | classify)"
echo "gates=$(printf '%s\n' "$changed" | gates)"
echo "full=$(printf '%s\n' "$changed" | full)"
