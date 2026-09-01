import { defineConfig } from "./configFile"

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

type NotifKey = keyof NotifSettings

const config = defineConfig("notif-config.json", DEFAULTS)

export const notifConfig = {
    get popupTimeout() { return config.get("popupTimeout") },
    get popupTimeoutMs() { return config.get("popupTimeout") * 1000 },
    get doNotDisturb() { return config.get("doNotDisturb") },

    setPopupTimeout(seconds: number) {
        config.set("popupTimeout", Math.round(seconds))
    },

    /** Guarded on equality: the Settings switch and the CC tile both write on
     *  every user interaction, and an unguarded setter would re-notify the other
     *  face of the same value. */
    setDoNotDisturb(on: boolean) {
        config.set("doNotDisturb", on)
    },

    onChange(fn: (key: NotifKey) => void): () => void {
        return config.subscribeAll(fn)
    },

    subscribe<K extends NotifKey>(key: K, cb: (v: NotifSettings[K]) => void): () => void {
        return config.subscribe(key, cb)
    },
}

export default notifConfig

