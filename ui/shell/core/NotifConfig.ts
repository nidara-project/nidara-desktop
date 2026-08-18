import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"
import { loadKnown } from "./configFile"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/notif-config.json`

// 🔑 `doNotDisturb` is the LIVE flag, not a preference about it — the CC focus
// tile, Settings → Notifications and the agent key `notifications.doNotDisturb`
// are three faces of this one bit, and this file is its ONLY home.
//
// It moved here on 2026-08-18, when `core/notifd.ts` replaced AstalNotifd. It was
// never daemon behaviour: the library's own documentation says the property "does
// not have any effect on its own; it is merely a value shared between the daemon
// process and proxies" — it lived in GSettings so several Astal processes could
// read one bit. Nidara is one process, and what actually consults the flag is the
// banner layer, which is UI policy. So it belongs with the other notification
// preference rather than in the server.
//
// What must NOT come back is a SECOND copy of it (the retired `dndDefault`,
// removed 2026-08-16, was one: it could only ever set the flag, never clear it).
interface NotifSettings {
    popupTimeout: number  // seconds, default 6
    doNotDisturb: boolean
}

const DEFAULTS: NotifSettings = {
    popupTimeout: 6,
    doNotDisturb: false,
}

let _settings: NotifSettings = { ...DEFAULTS }
try {
    if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
        // `loadKnown`, not a spread: an existing install's file still has the
        // retired `dndDefault`, and a spread would carry it into `_settings` and
        // write it back out on every save, forever. See core/configFile.ts.
        _settings = loadKnown(DEFAULTS, JSON.parse(readFile(CONFIG_PATH)))
    }
} catch {}

function save() {
    try {
        const dir = `${GLib.get_user_config_dir()}/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify(_settings, null, 2))
    } catch (e) {
        console.error("[NotifConfig] Save failed:", e)
    }
}

type NotifKey = keyof NotifSettings

// Listeners are told WHICH key moved. Do Not Disturb has four faces watching it
// and the timeout slider has one; without the key, every one of them would
// repaint whenever the other changed.
const _listeners = new Set<(key: NotifKey) => void>()

function emit(key: NotifKey) {
    save()
    _listeners.forEach(fn => { try { fn(key) } catch (e) { console.error("[NotifConfig] listener:", e) } })
}

export const notifConfig = {
    get popupTimeout() { return _settings.popupTimeout },
    get popupTimeoutMs() { return _settings.popupTimeout * 1000 },
    get doNotDisturb() { return _settings.doNotDisturb },

    setPopupTimeout(seconds: number) {
        _settings.popupTimeout = Math.round(seconds)
        emit("popupTimeout")
    },

    /** Guarded on equality: the Settings switch and the CC tile both write on
     *  every user interaction, and an unguarded setter would re-notify the other
     *  face of the same value. */
    setDoNotDisturb(on: boolean) {
        if (_settings.doNotDisturb === on) return
        _settings.doNotDisturb = on
        emit("doNotDisturb")
    },

    onChange(fn: (key: NotifKey) => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default notifConfig
