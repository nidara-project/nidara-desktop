#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Proves the audio worker wakes for a request (#1054) against the real PipeWire,
# which CI does not have. Runs a nidara-sessiond built with --features audio-native
# on private session/system buses and sets the default output's Muted to its current
# value (a no-op) three times. Passes when every call answers within one second; a
# build whose Backend::send does not wake the worker times out after five.
# Usage: scripts/dev/audio-wake-check.sh <nidara-sessiond>
set -u
bin=$(realpath "$1")
repo=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$repo/target"
root=$(mktemp -d -p "$repo/target" audio-wake-XXXX)
dbus-daemon --session --nofork --nopidfile --address="unix:path=$root/sys" 2>/dev/null & s1=$!
dbus-daemon --session --nofork --nopidfile --address="unix:path=$root/ses" 2>/dev/null & s2=$!
sleep 0.5
mkdir -p "$root/home"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$root/ses"
env -i PATH=/usr/bin HOME="$root/home" XDG_CONFIG_HOME="$root/home/.config" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" GSETTINGS_BACKEND=memory \
  DBUS_SYSTEM_BUS_ADDRESS="unix:path=$root/sys" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  "$bin" >"$root/log" 2>&1 & pid=$!
cleanup() { kill $pid $s1 $s2 2>/dev/null; wait 2>/dev/null; rm -rf "$root"; }
trap cleanup EXIT
sleep 6
get() { gdbus call -e -d org.nidara.Session -o "$1" -m org.freedesktop.DBus.Properties.Get "$2" "$3"; }
node=$(get /org/nidara/Audio org.nidara.Audio1 DefaultOutput | grep -o "'/[^']*'" | tr -d "'")
muted=$(get "$node" org.nidara.AudioNode1 Muted | grep -o "true\|false")
[ -n "$node" ] && [ -n "$muted" ] || { echo "FAIL: no default output (is PipeWire running?)"; exit 1; }
status=0
for i in 1 2 3; do
  start=$(date +%s%N)
  gdbus call -e -t 8 -d org.nidara.Session -o /org/nidara/Audio \
    -m org.nidara.Audio1.SetMuted "$node" "$muted" >/dev/null 2>&1 || status=1
  ms=$((($(date +%s%N) - start) / 1000000))
  echo "call $i: $ms ms"
  [ "$ms" -lt 1000 ] || status=1
  sleep 1
done
[ $status -eq 0 ] && echo "PASS: the audio worker wakes for requests" || echo "FAIL: a request waited for the worker"
exit $status
