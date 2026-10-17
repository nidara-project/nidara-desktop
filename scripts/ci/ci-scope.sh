#!/usr/bin/env bash
# What does this change need run?
#
#   ci-scope.sh BASE_SHA        → prints code=… and gates=…, for $GITHUB_OUTPUT
#   ci-scope.sh --self-test     → both classifiers against known lists; exits 1 if wrong
#
# code: the long jobs (smoke, hyalo, toolkit, sessiond). false ONLY when every changed
#   path is a `.md`: no long job reads one at run time (the packaging and the assistant
#   do, and their jobs are short and always run).
# gates: the real fcitx5 and Orca matrices inside the Hyalo job (~35 of its ~47 min).
#   They test the toolkit's window on Hyalo, so false ONLY when every changed path is in
#   an area that window does not use (`unrelated` below) — a list of what to SKIP, so a
#   new directory nobody classified runs them. The shell does run beside them in that
#   session; a shell change that broke them would show on the next toolkit/Hyalo change.
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
        ui/*|bin/*|defaults/*|config/*|lib/*|session/*|packaging/*|migrations/*|skills/*) return 0 ;;
        install.sh|VERSION|DCO|LICENSE|NOTICE) return 0 ;;
        scripts/ci/*.mjs|scripts/ci/*.txt|scripts/ci/headless-smoke.sh) return 0 ;;
        scripts/ci/agent-loop-test.py|scripts/ci/sessiond-test.py|scripts/ci/settings-process-check.sh) return 0 ;;
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
    check_gates true ui/shell/app.ts toolkit/crates/nk-text/src/lib.rs
    check_gates true protocols/nidara-layers-v1.xml
    check_gates true config/hyalo/hyalo.toml
    check_gates true scripts/ci/nk-orca-check.py
    check_gates true scripts/ci/hyalo-smoke.sh
    check_gates true .github/workflows/ci.yml
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
