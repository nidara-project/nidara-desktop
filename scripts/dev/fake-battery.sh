#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# fake-battery.sh — DEV ONLY. Stand up a mock org.freedesktop.UPower so the
# battery widget (1×1 / 2×1 / 2×2 tiles + bar glyph) can be exercised on a
# desktop with no real battery.
#
# AstalBattery only ever reads UPower's composite *DisplayDevice* over the
# *system* D-Bus. So, like fake-bluetooth.sh does for org.bluez, we replace
# org.freedesktop.UPower wholesale with python-dbusmock's `upower` template, then
# seed the DisplayDevice through `org.freedesktop.DBus.Properties.Set` (UPower's bus
# policy blocks the template's own `org.freedesktop.DBus.Mock` control interface —
# see setp() below). Same approach GNOME uses to test its power panel.
#
# Requires: python-dbusmock (pacman -S python-dbusmock). Must run as root, both
# to stop upower.service and to own org.freedesktop.UPower on the system bus.
#
# Usage:  sudo ./fake-battery.sh start [percent] [charging|discharging|full]
#         sudo ./fake-battery.sh stop
#
#   start 72                 → 72%, discharging   (default state)
#   start 10 discharging     → 10%, discharging   (low → red fill)
#   start 45 charging        → 45%, charging      (green fill)
#   start 100 full           → fully charged
#
# Re-running `start` with new values re-seeds live (no relaunch) — the UI updates
# without a reload. The FIRST `start` flips is_present false→true, so reload the
# shell once (Super+Shift+R) after it before the tiles render the glyph.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PIDFILE="/tmp/crystal-upower-mock.pid"
BUS="org.freedesktop.UPower"
OBJ="/org/freedesktop/UPower"
DEV="/org/freedesktop/UPower/devices/DisplayDevice"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

# Set one DisplayDevice property via the standard Properties interface. We do NOT use
# the template's SetupDisplayDevice control method: UPower's D-Bus system policy
# whitelists send_interface (Introspectable/Peer/Properties/UPower[.Device]) and the
# dbusmock control interface `org.freedesktop.DBus.Mock` is NOT in it, so that call is
# "Access denied". `org.freedesktop.DBus.Properties.Set` IS allowed and dbusmock objects
# accept it (mutating the prop store + emitting PropertiesChanged → live UI updates).
setp() {
  busctl --system call "$BUS" "$DEV" org.freedesktop.DBus.Properties Set ssv \
      org.freedesktop.UPower.Device "$1" "$2" "$3" >/dev/null
}

# UPower States: 1=charging 2=discharging 4=fully-charged. WarningLevels: 1=none 3=low.
seed() {
  local pct="$1" mode="$2" state tte ttf warn=1
  case "$mode" in
    charging)    state=1; tte=0;     ttf=4200 ;;
    full)        state=4; tte=0;     ttf=0;    pct=100 ;;
    *)           state=2; tte=9000;  ttf=0;    [ "$pct" -le 15 ] && warn=3 ;;
  esac
  setp Type        u 2
  setp IsPresent   b true
  setp State       u "$state"
  setp Percentage  d "$pct"
  setp TimeToEmpty x "$tte"
  setp TimeToFull  x "$ttf"
  setp WarningLevel u "$warn"
  echo "  display device: ${pct}% ${mode} (state=$state warn=$warn)"
}

case "${1:-}" in
  start)
    pct="${2:-72}"; mode="${3:-discharging}"

    python3 -c "import dbusmock.templates.upower" 2>/dev/null \
      || { echo "python-dbusmock (upower template) missing: pacman -S python-dbusmock" >&2; exit 1; }

    if ! busctl --system introspect "$BUS" "$OBJ" >/dev/null 2>&1 || [ ! -f "$PIDFILE" ]; then
      # Free the name so the mock can own it, then launch on the system bus.
      systemctl stop upower.service 2>/dev/null || true
      echo "Starting upower mock on the system bus…"
      python3 -m dbusmock --system --template upower >/tmp/crystal-upower-mock.log 2>&1 &
      echo $! > "$PIDFILE"
      for _ in $(seq 1 50); do
        busctl --system introspect "$BUS" "$OBJ" >/dev/null 2>&1 && break
        sleep 0.2
      done
      busctl --system introspect "$BUS" "$OBJ" >/dev/null 2>&1 \
        || { echo "mock never claimed $BUS — see /tmp/crystal-upower-mock.log" >&2; exit 1; }
    fi

    seed "$pct" "$mode"
    echo "Mock $BUS up. If the tiles still show the dim icon, reload the shell (Super+Shift+R)."
    echo "Change live with: sudo $0 start <pct> <charging|discharging|full>   ·   stop: sudo $0 stop"
    ;;

  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
    pkill -f "dbusmock --system --template upower" 2>/dev/null || true
    rm -f /tmp/crystal-upower-mock.log
    systemctl start upower.service 2>/dev/null || true
    echo "Mock torn down; upower.service restored. Reload the shell to re-bind."
    ;;

  *)
    echo "Usage: sudo $0 start [percent] [charging|discharging|full] | stop" >&2; exit 1 ;;
esac
