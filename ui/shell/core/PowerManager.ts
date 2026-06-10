import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"

const HOME = GLib.get_home_dir()
const BIN  = `${HOME}/.local/bin`

// Run by hypridle before_sleep_cmd: persist volume, then lock
const BEFORE_SLEEP = `#!/bin/bash
wpctl get-volume @DEFAULT_SINK@ 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+' | head -1 > /tmp/.crystal-vol
crystal-lock
`

// Run by hypridle after_sleep_cmd: DPMS first, then restore volume once PipeWire is ready
const AFTER_SLEEP = `#!/bin/bash
sleep 0.5
hyprctl dispatch dpms on
sleep 1.5
v=$(cat /tmp/.crystal-vol 2>/dev/null)
[ -n "$v" ] && wpctl set-volume @DEFAULT_SINK@ "$v" 2>/dev/null
`

function ensureDir(path: string) {
    try { Gio.File.new_for_path(path).make_directory_with_parents(null) } catch {}
}

function writeExec(path: string, content: string) {
    try {
        Gio.File.new_for_path(path).replace_contents(
            new TextEncoder().encode(content), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null
        )
        execAsync(["chmod", "+x", path]).catch(() => {})
    } catch (e) {
        console.warn(`[PowerManager] write ${path}:`, e)
    }
}

export function installPowerHooks() {
    ensureDir(BIN)
    writeExec(`${BIN}/crystal-before-sleep`, BEFORE_SLEEP)
    writeExec(`${BIN}/crystal-after-sleep`,  AFTER_SLEEP)
}
