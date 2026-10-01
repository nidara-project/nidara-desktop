#!/bin/sh
# apt.sh — apt-get on GitHub's Ubuntu runners, with a way out of a stalled mirror.
#
#   scripts/ci/apt.sh install PKG…     update the lists, then install
#
# Twice on 2026-10-01 a job sat on `apt-get update` with no output for 45 minutes — the Azure
# Ubuntu mirror stopped answering mid-download — until Actions cancelled the job. In the merge
# queue that is 45 minutes of nothing, and the entry is thrown out. apt's own timeouts make a
# stalled connection fail instead of wait (plus its retries); `timeout` caps an attempt that
# trickles; and a stalled attempt is tried again, three times in all, before the step fails.
set -u
[ "${1:-}" = install ] && [ $# -ge 2 ] || { echo "usage: $0 install PKG…" >&2; exit 2; }
shift
opts="-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30"
attempt() {
    # shellcheck disable=SC2086
    sudo timeout 240 apt-get $opts update -qq \
        && sudo timeout 600 apt-get $opts install -y -qq "$@"
}
for i in 1 2 3; do
    attempt "$@" && exit 0
    echo "::warning::apt-get stalled or failed (attempt $i of 3)"
    sleep 5
done
echo "::error::apt-get failed three times — the Ubuntu mirror is not answering"
exit 1
