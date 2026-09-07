#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# acct-expiry-probe — does `nidara-lock`'s ACCOUNT stack still reach a real
# verdict, from an unprivileged caller?
#
#   sudo ./scripts/dev/acct-expiry-probe.sh          # the three cases
#   sudo ./scripts/dev/acct-expiry-probe.sh --blind  # prove the probe can fail
#
# ── Why this exists, next to the other probes ────────────────────────────────
#
# `scripts/dev/pam-auth-probe-deny` is a positive control for the SIGNAL — it
# proves `account-denied` fires before `fail`. But it denies with `pam_deny.so`,
# so it never runs `pam_unix`'s account path, and that path is where the doubt
# was: an unprivileged caller logs
#
#     pam_unix(nidara-lock:account): setuid failed: Operation not permitted
#
# on every single unlock (#478). The question that mattered was whether
# pam_acct_mgmt() still answers correctly after that, or whether the checks
# restored on 2026-08-23 had gone decorative again. A synthetic denial cannot
# answer it; only the real module with a real expired account can.
#
# The answer, measured 2026-09-07: the message is `pam_unix` logging at
# LOG_DEBUG and CARRYING ON. Its `_unix_run_verify_binary` tries `setuid(0)`,
# and when that fails it only bails if `geteuid() == 0` — i.e. if it really was
# root and something is wrong. For an ordinary caller it logs and proceeds to
# `execve(unix_chkpwd)`, which is setuid root and reads /etc/shadow for us.
# The journal entry's PRIORITY is 7 (debug); the branch that gives up logs at 3.
#
# ── What it does ─────────────────────────────────────────────────────────────
#
# Creates a throwaway user, expires it two ways, asks as that user, deletes it.
# It never touches an existing account: no faillock, no password of yours, and
# nothing that can lock you out of your own session.
# ─────────────────────────────────────────────────────────────────────────────
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/scripts/dev/acct-probe.c"
BLIND=0
[ "${1:-}" = "--blind" ] && BLIND=1

if [ "$(id -u)" != 0 ]; then
    echo "must run as root (it creates and deletes a throwaway user)" >&2
    exit 2
fi

BIN="$(mktemp -d)/acct-probe"
gcc -O0 -o "$BIN" "$SRC" -lpam || exit 2
chmod 755 "$(dirname "$BIN")" "$BIN"

U=nidara-acct-probe
cleanup() { userdel -r "$U" 2>/dev/null; rm -rf "$(dirname "$BIN")"; }
trap cleanup EXIT

userdel -r "$U" 2>/dev/null
useradd -m -s /bin/bash "$U" || exit 2
echo "$U:probe-only-$$" | chpasswd || exit 2
UID_U=$(id -u "$U"); GID_U=$(id -g "$U")

# The lockscreen's shape: unprivileged, asking about ITSELF.
run() { setpriv --reuid="$UID_U" --regid="$GID_U" --clear-groups "$BIN" nidara-lock "$U" 2>/dev/null; }
# The blind shape: unprivileged, asking about SOMEBODY ELSE. Always 9.
run_blind() { setpriv --reuid=65534 --regid=65534 --clear-groups "$BIN" nidara-lock "$U" 2>/dev/null; }

code() { echo "$1" | sed -n 's/^pam_acct_mgmt -> \([0-9]*\).*/\1/p'; }

if [ "$BLIND" = 1 ]; then
    echo "== --blind: asking as 'nobody' about $U — the mistake this probe guards against"
    for label in healthy "password expired" "account expired"; do
        case "$label" in
            "password expired") chage -d 0 "$U" ;;
            "account expired")  chage -d 20000 -E 2020-01-01 "$U" ;;
        esac
        printf '   %-18s -> %s\n' "$label" "$(code "$(run_blind | tail -1)")"
    done
    echo
    echo "All three read 9 (PAM_AUTHINFO_UNAVAIL) — identical for a healthy account"
    echo "and an expired one. A probe that answers 9 to everything has measured"
    echo "nothing, and its 'refusals' are not verdicts. This is what the real run"
    echo "must NOT look like."
    exit 0
fi

fail=0
check() {  # label  expected
    local out code
    out="$(run | tail -1)"; code="$(code "$out")"
    if [ "$code" = "$2" ]; then
        printf '   ✓ %-18s %s\n' "$1" "$out"
    else
        printf '   ✗ %-18s %s   (expected %s)\n' "$1" "$out" "$2"
        fail=1
    fi
}

echo "== nidara-lock account stack, asked by an unprivileged caller"
check "healthy"           0    # PAM_SUCCESS
chage -d 0 "$U"
check "password expired"  12   # PAM_NEW_AUTHTOK_REQD → we unlock ANYWAY, on purpose
chage -d 20000 -E 2020-01-01 "$U"
check "account expired"   13   # PAM_ACCT_EXPIRED     → account-denied, no unlock

echo
if [ "$fail" = 0 ]; then
    echo "PASS — three different verdicts, so the account stack is doing real work"
    echo "       despite the 'setuid failed' line pam_unix logs at debug level."
    echo "       12 and 13 are exactly the two branches nidara-auth.c tells apart."
else
    echo "FAIL — if all three agree, the account stack is decorative and the"
    echo "       2026-08-23 fix has regressed. Run with --blind first: an"
    echo "       all-9 result means the PROBE is broken, not the stack."
fi
exit "$fail"
