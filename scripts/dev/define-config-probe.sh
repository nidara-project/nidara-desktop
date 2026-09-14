#!/usr/bin/env bash
# define-config-probe.sh — bundle and run scripts/dev/define-config-probe.ts in
# an isolated settings environment.
#
#   scripts/dev/define-config-probe.sh [out-dir]
#
# The probe writes settings. It must never write YOURS: it gets a scratch
# XDG_CONFIG_HOME, the keyfile GSettings backend (which lives inside that scratch
# directory and needs no bus) and a schema directory compiled from the tree plus
# the probe's own test schemas. The probe refuses to run without that
# environment. Needs a display (it opens GTK), which is why the headless smoke is
# the job that runs it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"

"$REPO/scripts/bundle.sh" --js "$REPO/scripts/dev/define-config-probe.ts" "$OUT/dcp.js" >/dev/null

schemas="$OUT/schemas"
config="$OUT/config"
rm -rf "$schemas" "$config"
mkdir -p "$schemas" "$config/nidara"
cp "$REPO"/config/gsettings/*.gschema.xml "$REPO"/scripts/dev/probe-schemas/*.gschema.xml "$schemas/"
glib-compile-schemas --strict "$schemas"

# The greeter mirrors too: ThemeManager and RegionConfig write them when they are
# constructed, and the real ones in /var/tmp/nidara are what the login screen shows.
mkdir -p "$OUT/mirror"
exec env XDG_CONFIG_HOME="$config" GSETTINGS_BACKEND=keyfile GSETTINGS_SCHEMA_DIR="$schemas" \
    NIDARA_GREETER_MIRROR_DIR="$OUT/mirror" \
    NIDARA_DEFINE_CONFIG_PROBE=1 gjs -m "$OUT/dcp.js"
