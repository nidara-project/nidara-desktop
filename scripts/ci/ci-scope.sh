#!/usr/bin/env bash
# What does this change need run?
#
#   ci-scope.sh BASE_SHA        → prints code=… and gates=…, for $GITHUB_OUTPUT
#   ci-scope.sh --self-test     → both classifiers against known lists; exits 1 if wrong
#
# code: the long jobs (smoke, hyalo, toolkit, sessiond). false ONLY when every changed
#   path is a `.md`: no long job reads one at run time (the packaging and the assistant
#   do, and their jobs are short and always run).
# gates: the real fcitx5 and Orca matrices inside the Hyalo job (~35 of its ~50 min).
#   They test typing (input methods) and the screen reader in the toolkit's test window
#   on Hyalo, so false ONLY when every changed path is in an area they do not use
#   (`unrelated` below) — a list of what to SKIP, so a new file nobody classified runs
#   them. Inside Hyalo and the toolkit that list is by file: drawing, window management,
#   capture, settings data… skip; input, focus, the keyboard, the screen reader's
#   keyboard, the layers protocol, the backend and the toolkit's crates run them.
#   The shell does run beside them in that session. What a skip lets through — and two
#   queued changes that only break them together — the nightly full run on main finds
#   (`schedule` in ci.yml: no base, so everything runs).
# Every doubt — no base, a failed fetch, an empty diff — is true for both.
# A wrong `true` costs time; a wrong `false` lands untested code, so the doubt runs.
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

unrelated() {
    case "$1" in
        *.md) return 0 ;;
        config/hyalo/*) return 1 ;;
        # Hyalo: what the typing and screen-reader tests never reach. Everything else of it —
        # a11y.rs, input.rs, focus.rs, handlers.rs, state.rs, shortcuts.rs, binds.rs,
        # control.rs, main.rs, backend/, shell/mod.rs, wm/mod.rs, protocols/{mod,layers*,
        # focus_grab}, Cargo.* — runs them, and so does a file added later.
        hyalo/compositor/src/render/*|hyalo/compositor/src/ipc/*) return 0 ;;
        hyalo/compositor/src/wm/actions.rs|hyalo/compositor/src/wm/games.rs|hyalo/compositor/src/wm/grabs.rs) return 0 ;;
        hyalo/compositor/src/wm/layout/*|hyalo/compositor/src/wm/minimize.rs|hyalo/compositor/src/wm/motion.rs|hyalo/compositor/src/wm/rules.rs) return 0 ;;
        hyalo/compositor/src/capture.rs|hyalo/compositor/src/screenshot.rs|hyalo/compositor/src/protocols/screencopy.rs) return 0 ;;
        hyalo/compositor/src/night_light.rs|hyalo/compositor/src/idle.rs|hyalo/compositor/src/lock.rs|hyalo/compositor/src/logind.rs) return 0 ;;
        hyalo/compositor/src/cursor.rs|hyalo/compositor/src/crash.rs|hyalo/compositor/src/config.rs|hyalo/compositor/src/sandbox.rs) return 0 ;;
        hyalo/compositor/src/activation.rs|hyalo/compositor/src/outputs.rs|hyalo/compositor/src/xwayland.rs) return 0 ;;
        hyalo/compositor/src/protocols/material.rs|hyalo/compositor/src/protocols/virtual_pointer.rs|hyalo/compositor/src/protocols/window_controls.rs) return 0 ;;
        hyalo/compositor/src/shell/decoration.rs|hyalo/compositor/src/shell/layer.rs|hyalo/scripts/*|hyalo/session/*) return 0 ;;
        # The toolkit: the Settings slice is not in those tests; its crates and phase 0 are.
        toolkit/crates/nk-widgets/*|toolkit/widgets-demo/*) return 1 ;;
        toolkit/settings-slice/*) return 0 ;;
        protocols/nidara-material-v1.xml) return 0 ;;
        ui/*|bin/*|defaults/*|config/*|lib/*|session/*|packaging/*|migrations/*|skills/*) return 0 ;;
        install.sh|VERSION|DCO|LICENSE|NOTICE) return 0 ;;
        scripts/ci/*.mjs|scripts/ci/*.txt|scripts/ci/headless-smoke.sh) return 0 ;;
        scripts/ci/agent-loop-test.py|scripts/ci/sessiond-test.py|scripts/ci/settings-process-check.sh) return 0 ;;
        # The other checks of the Hyalo job: theirs, not the typing and screen-reader tests'
        # (nk-fcitx5-check.py, nk-orca-check.py, nk-real-common.py and hyalo-smoke.sh run them).
        scripts/ci/hyalo-*-check.py|scripts/ci/hyalo-*.js|scripts/ci/config-service-check.py|scripts/ci/settings-*-check.py) return 0 ;;
        scripts/ci/nk-layer-motion-check.py|scripts/ci/nk-phase0-check.py|scripts/ci/nk-a11y-check.py|scripts/ci/nk-*-control.py) return 0 ;;
        scripts/export-*.mjs) return 0 ;;
        # CI's own plumbing: nearly every change adds its check to hyalo-smoke.sh or ci.yml,
        # and that ran the ~35 minutes each time (7 of the 12 last code PRs, 2026-10-18). The
        # tests' own lines there change rarely; when they do, the nightly run says so.
        scripts/ci/hyalo-smoke.sh|scripts/ci/ci-scope.sh|.github/workflows/ci.yml|.gitignore) return 0 ;;
        scripts/dev/*|scripts/i18n/*) return 0 ;;
    esac
    return 1
}

# Reads paths on stdin, one per line.
gates() {
    local any=0 path
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        any=1
        unrelated "$path" || { echo true; return; }
    done
    [ "$any" -eq 1 ] && echo false || echo true
}

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
    check_gates false ui/shell/surfaces/bar/Bar.tsx README.md
    check_gates false bin/nidara-agent config/hypr/hyprland.lua session/daemon/src/model.rs
    check_gates true hyalo/compositor/src/control.rs
    check_gates false hyalo/compositor/src/render/decor.rs hyalo/compositor/src/wm/motion.rs hyalo/compositor/src/ipc/server.rs
    check_gates false toolkit/settings-slice/src/host.rs protocols/nidara-material-v1.xml scripts/ci/nk-layer-motion-check.py
    check_gates false hyalo/compositor/src/protocols/material.rs scripts/ci/hyalo-resize-check.py scripts/export-tokens.mjs
    check_gates true hyalo/compositor/src/render/decor.rs hyalo/compositor/src/input.rs
    check_gates true hyalo/compositor/src/a11y.rs
    check_gates true hyalo/compositor/src/protocols/layers/presentation.rs
    check_gates true hyalo/compositor/src/backend/mod.rs
    check_gates true hyalo/Cargo.lock
    check_gates true hyalo/compositor/src/newmodule.rs
    check_gates true toolkit/crates/nk-wayland/src/material.rs
    check_gates true toolkit/crates/nk-widgets/src/lib.rs
    check_gates true toolkit/widgets-demo/src/main.rs
    check_gates true scripts/ci/nk-widgets-check.py
    check_gates true toolkit/phase0/src/main.rs
    check_gates true scripts/ci/nk-real-common.py
    check_gates true ui/shell/app.ts toolkit/crates/nk-text/src/lib.rs
    check_gates true protocols/nidara-layers-v1.xml
    check_gates true config/hyalo/hyalo.toml
    check_gates true scripts/ci/nk-orca-check.py
    check_gates false scripts/ci/hyalo-smoke.sh .github/workflows/ci.yml .gitignore
    check_gates true newdir/anything
    check_gates true ''
    [ "$fail" -eq 0 ] && echo "ci-scope self-test: ok"
    exit "$fail"
fi

base=${1:-}
if [ -z "$base" ] || ! git fetch --quiet --depth=1 origin "$base" \
        || ! changed=$(git diff --name-only "$base" HEAD); then
    echo "ci-scope: cannot diff against '${base}', running everything" >&2
    echo code=true
    echo gates=true
    exit 0
fi
printf '%s\n' "$changed" | sed 's/^/ci-scope: changed /' >&2
echo "code=$(printf '%s\n' "$changed" | classify)"
echo "gates=$(printf '%s\n' "$changed" | gates)"
