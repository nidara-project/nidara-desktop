#!/usr/bin/env bash
# Does this change need the long jobs (smoke, hyalo, toolkit, sessiond)?
#
#   ci-scope.sh BASE_SHA        → prints code=true|false, for $GITHUB_OUTPUT
#   ci-scope.sh --self-test     → the classifier against known lists; exits 1 if wrong
#
# false ONLY when every changed path is a `.md`: no long job reads one at run time
# (the packaging and the assistant do, and their jobs are short and always run).
# Everything else — and every doubt: no base, a failed fetch, an empty diff — is true.
# A wrong `true` costs an hour; a wrong `false` lands untested code, so the doubt runs.
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

if [ "${1:-}" = --self-test ]; then
    fail=0
    check() {
        local want=$1 got
        shift
        got=$(printf '%s\n' "$@" | classify)
        if [ "$got" != "$want" ]; then
            echo "::error::ci-scope: [$*] gave $got, want $want"
            fail=1
        fi
    }
    check false toolkit/CONTRACT.md
    check false README.md .claude/skills/nidara/SKILL.md
    check true toolkit/CONTRACT.md hyalo/compositor/src/control.rs
    check true scripts/ci/hyalo-smoke.sh
    check true docs/notes.md.bak
    check true ''
    [ "$fail" -eq 0 ] && echo "ci-scope self-test: ok"
    exit "$fail"
fi

base=${1:-}
if [ -z "$base" ] || ! git fetch --quiet --depth=1 origin "$base" \
        || ! changed=$(git diff --name-only "$base" HEAD); then
    echo "ci-scope: cannot diff against '${base}', running everything" >&2
    echo code=true
    exit 0
fi
printf '%s\n' "$changed" | sed 's/^/ci-scope: changed /' >&2
echo "code=$(printf '%s\n' "$changed" | classify)"
