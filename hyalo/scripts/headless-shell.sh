#!/bin/sh
# Hyalo in a headless cage with the REAL shell (sealed off, see sandboxed-shell.sh) as its
# client; a screenshot after N seconds.
#   hyalo/scripts/headless-shell.sh <out.png> <seconds>
# HYALO_EXTRA: another client started first (e.g. a window to sit behind the glass).
set -eu
here=$(dirname "$(realpath "$0")")
log=${HYALO_SHELL_LOG:-/tmp/nidara-hyalo-shell.log}
extra=${HYALO_EXTRA:+$HYALO_EXTRA & }
exec "$here/headless-shot.sh" "$1" "$2" "sh -c '$extra$here/sandboxed-shell.sh >$log 2>&1'"
