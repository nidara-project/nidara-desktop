#!/usr/bin/env bash
# Called ONLY by the private smoke-session harnesses. It kills its own Settings,
# never the shell, and checks the actual app through the exported Request door.
#
# Two shapes, told apart by who owns org.nidara.Settings:
# - the native entry point (/usr/bin/nidara-settings): it draws Appearance and hands every
#   other page to the legacy Settings, org.nidara.SettingsLegacy, which it starts;
# - the GJS Settings run directly (NIDARA_SETTINGS_EXECUTABLE, the Hyprland smoke).
# queryUI reaches the GJS window in both (the native one forwards it).
set -euo pipefail
[ "${NIDARA_SETTINGS_CHECK_ISOLATED:-}" = 1 ] || { echo 'Refusing a Settings crash walk outside the smoke session' >&2; exit 1; }
ipc=$1; out=$2
mkdir -p "$out"
get_pid() {
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.GetConnectionUnixProcessID "$1" 2>/dev/null | sed -n 's/.*uint32 \([0-9]*\).*/\1/p'
}
wait_page() {
    for i in $(seq 60); do
        "$ipc" queryUI "$1" > "$out/settings-ui.json" || true
        if python -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("count",0)>0 else 1)' "$out/settings-ui.json" 2>/dev/null; then return; fi
        sleep 0.2
    done
    echo "Settings did not map $1" >&2; exit 1
}
wait_gone() {
    for i in $(seq 30); do
        [ -z "$(get_pid "$1")" ] && return
        sleep 0.1
    done
    echo "$1 did not exit" >&2; exit 1
}
# The executable's file name, and its process name (15 bytes of it, as Linux keeps it).
is_exe() {
    [ "$(basename "$(readlink "/proc/$1/exe")")" = "$2" ] && [ "$(cat "/proc/$1/comm")" = "${3:-$2}" ]
}
[ "$("$ipc" settingsPage appearance)" = ok ]
entry=$(get_pid org.nidara.Settings); shell=$(get_pid org.nidara.Shell)
[ -n "$entry" ] && [ "$entry" != "$shell" ]
is_exe "$shell" nidara-shell
if is_exe "$entry" nidara-settings-native nidara-settings; then
    native=1 gjs_name=org.nidara.SettingsLegacy
    [ "$entry" = "$(get_pid org.nidara.SettingsNative)" ]
else
    native="" gjs_name=org.nidara.Settings
    is_exe "$entry" nidara-settings
    wait_page .appearance-page@settings
fi
echo "PASS shell and Settings use their own native executables${native:+ (native entry point)}"

[ "$("$ipc" settingsPage widgets)" = ok ]
wait_page .widgets-page@settings
gjs=$(get_pid "$gjs_name")
[ -n "$gjs" ] && [ "$gjs" != "$shell" ]
is_exe "$gjs" nidara-settings
[ -z "$native" ] || { [ "$gjs" != "$entry" ] && echo 'PASS a page the native Settings does not draw opens in the legacy one'; }
[ "$("$ipc" settingsPage widgets)" = ok ]
[ "$entry" = "$(get_pid org.nidara.Settings)" ] && [ "$gjs" = "$(get_pid "$gjs_name")" ]
echo 'PASS Settings reuses its processes and queryUI crosses the boundary'

# The GJS window crashing leaves the shell (and the native entry point) alive.
kill -KILL "$gjs"
wait_gone "$gjs_name"
"$ipc" dumpState >/dev/null
[ "$shell" = "$(get_pid org.nidara.Shell)" ]
[ -z "$native" ] || [ "$entry" = "$(get_pid org.nidara.Settings)" ]
echo 'PASS Settings crash leaves the same shell alive'
[ "$("$ipc" settingsPage widgets)" = ok ]
wait_page .widgets-page@settings
second=$(get_pid "$gjs_name")
[ -n "$second" ] && [ "$gjs" != "$second" ]
echo 'PASS Settings reopens and renders the remote widget catalogue'

if [ -n "$native" ]; then
    # The entry point crashing: the shell starts a new one, which draws Appearance again.
    kill -KILL "$entry"
    wait_gone org.nidara.Settings
    [ "$shell" = "$(get_pid org.nidara.Shell)" ]
    [ "$("$ipc" settingsPage appearance)" = ok ]
    again=$(get_pid org.nidara.Settings)
    [ -n "$again" ] && [ "$again" != "$entry" ]
    is_exe "$again" nidara-settings-native nidara-settings
    echo 'PASS the native entry point restarts after a crash'
    kill -TERM "$again"
    wait_gone org.nidara.Settings
fi
kill -TERM "$second"
wait_gone "$gjs_name"
echo SETTINGS_PROCESS_OK
