#!/usr/bin/env bash
# night-light-sync-probe.sh — does a change made OUTSIDE the shell drive hyprsunset, once?
#
#   scripts/dev/night-light-sync-probe.sh
#
# A fake `hyprsunset` on PATH logs START <temp> / STOP; the probe process runs
# NightLightSync, and the driver flips org.nidara.night-light with `gsettings set`.
# Private bus with its env on the daemon's command line + a dconf canary, and the schema
# compiled from this checkout. No display, no compositor: nothing reaches the session.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d -t nidara-nightlight-XXXXXX)"
cleanup() {
  # Any fake still running (a failed run) dies by the PID it logged — never by name.
  [ -f "$work/sunset.log" ] && while read -r pid _; do kill "$pid" 2>/dev/null; done < "$work/sunset.log"
  rm -rf "$work" 2>/dev/null || { sleep 0.5; rm -rf "$work"; }   # dconf may still be writing runtime/
}
trap cleanup EXIT
mkdir -p "$work/bin" "$work/config" "$work/runtime" "$work/schemas"; chmod 700 "$work/runtime"
cp "$repo"/config/gsettings/*.gschema.xml "$work/schemas/" && glib-compile-schemas "$work/schemas"
"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/night-light-sync-probe.ts" "$work/probe.js" >/dev/null 2>&1

# `exec`, so the PID logged IS the process NightLightSync holds: force_exit is SIGKILL,
# which no trap can log, so the driver asks the kernel who is still alive instead.
cat > "$work/bin/hyprsunset" <<FAKE
#!/usr/bin/env bash
echo "\$\$ \$2" >> "$work/sunset.log"
exec sleep infinity
FAKE
chmod +x "$work/bin/hyprsunset"

env -u DBUS_SESSION_BUS_ADDRESS -u HYPRLAND_INSTANCE_SIGNATURE -u WAYLAND_DISPLAY -u DISPLAY \
  PATH="$work/bin:$PATH" HOME="$work" XDG_CONFIG_HOME="$work/config" XDG_RUNTIME_DIR="$work/runtime" \
  GSETTINGS_SCHEMA_DIR="$work/schemas" GIO_USE_VFS=local work="$work" \
  dbus-run-session -- bash -c '
set -uo pipefail
dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/config/dconf/user" ] || { echo "ABORT dconf canary"; exit 1; }
S=org.nidara.night-light
# Alive hyprsunsets as "temp", from the log of every one ever started.
alive() { [ -f "$work/sunset.log" ] || return 0; while read -r pid t; do kill -0 "$pid" 2>/dev/null && printf "%s " "$t"; done < "$work/sunset.log"; }
log() { sleep 0.8; echo "-- after $1: started=$(wc -l < "$work/sunset.log" 2>/dev/null || echo 0) alive=[ $(alive)]"; }

gsettings set $S enabled false
gjs -m "$work/probe.js" > "$work/probe.log" 2>&1 & p=$!
sleep 1.5; log "start (disabled)"
gsettings set $S enabled true;          log "enabled=true"
gsettings set $S temperature 3000;      log "temperature=3000 (debounced)"
gsettings set $S temperature 3000;      log "temperature=3000 again (no change)"
gsettings set $S enabled false;         log "enabled=false"
# Schedule covering every minute but now: from = now+1min, to = now → overnight wrap
# makes the window everything EXCEPT [now, now+1) — i.e. "now" is OUT. Then the whole day.
now=$(date +%H:%M); next=$(date -d "+1 min" +%H:%M)
gsettings set $S schedule-from "$now"; gsettings set $S schedule-to "$next"
gsettings set $S enabled true; sleep 0.3
gsettings set $S schedule-enabled true; log "schedule on, now INSIDE [$now,$next)"
gsettings set $S schedule-from "$next"; gsettings set $S schedule-to "$now"; log "schedule moved, now OUTSIDE"
echo "enabled key now: $(gsettings get $S enabled)"
kill $p; wait $p 2>/dev/null
grep -iE "error|critical" "$work/probe.log" | head -3
'
