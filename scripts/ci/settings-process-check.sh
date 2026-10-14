#!/usr/bin/env bash
# Called ONLY by the private smoke-session harnesses. It kills its own Settings,
# never the shell, and checks the actual app through the exported Request door.
set -euo pipefail
[ "${NIDARA_SETTINGS_CHECK_ISOLATED:-}" = 1 ] || { echo 'Refusing a Settings crash walk outside the smoke session' >&2; exit 1; }
ipc=$1; out=$2
mkdir -p "$out"
get_pid() {
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.GetConnectionUnixProcessID "$1" | sed -n 's/.*uint32 \([0-9]*\).*/\1/p'
}
wait_page() {
    for i in $(seq 60); do
        "$ipc" queryUI "$1" > "$out/settings-ui.json"
        if python -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("count",0)>0 else 1)' "$out/settings-ui.json"; then return; fi
        sleep 0.2
    done
    echo "Settings did not map $1" >&2; exit 1
}
[ "$("$ipc" settingsPage appearance)" = ok ]
wait_page .appearance-page@settings
first=$(get_pid org.nidara.Settings); shell=$(get_pid org.nidara.Shell)
[ -n "$first" ] && [ "$first" != "$shell" ]
[ "$("$ipc" settingsPage widgets)" = ok ]
wait_page .widgets-page@settings
[ "$first" = "$(get_pid org.nidara.Settings)" ]
echo 'PASS Settings reuses one process and queryUI crosses the boundary'
kill -KILL "$first"
for i in $(seq 30); do
    if ! get_pid org.nidara.Settings >/dev/null 2>&1; then break; fi
    sleep 0.1
done
"$ipc" dumpState >/dev/null
[ "$shell" = "$(get_pid org.nidara.Shell)" ]
echo 'PASS Settings crash leaves the same shell alive'
[ "$("$ipc" settingsPage widgets)" = ok ]
wait_page .widgets-page@settings
second=$(get_pid org.nidara.Settings)
[ -n "$second" ] && [ "$first" != "$second" ]
echo 'PASS Settings reopens and renders the remote widget catalogue'
kill -TERM "$second"
for i in $(seq 30); do
    if ! get_pid org.nidara.Settings >/dev/null 2>&1; then break; fi
    sleep 0.1
done
if get_pid org.nidara.Settings >/dev/null 2>&1; then echo 'Settings did not exit' >&2; exit 1; fi
echo SETTINGS_PROCESS_OK
