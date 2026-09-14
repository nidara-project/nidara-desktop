import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "../../lib/file"
import { execAsync } from "../../lib/process"
import { formatDatePart } from "../../lib/date-names"
import { defineSettings } from "./configFile"

export type TimeFormat = "24h" | "12h"
export type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

export interface RegionSettings {
    timeFormat: TimeFormat
    dateFormat: DateFormat
    timezone: string
    showSeconds: boolean
    regionalLocale: string  // e.g. "es_ES.UTF-8"; "" = same as LANG
}

// Path where Nidara writes user-level LC_* overrides, picked up by systemd/PAM on login
const LOCALE_ENV_PATH = `${GLib.get_user_config_dir()}/environment.d/nidara-locale.conf`

// Variables that represent "regional format" (not UI language)
const REGIONAL_LC_VARS = [
    "LC_TIME", "LC_NUMERIC", "LC_MONETARY",
    "LC_PAPER", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT",
]

// ── Where each of these lives (#573) ─────────────────────────────────────────
// Only the three clock preferences are STORED, in GSettings `org.nidara.region`.
// The other two fields of RegionSettings each had a home before region.json copied
// them, and a copy is a second answer that can disagree:
//  - timezone → the SYSTEM's (/etc/localtime, set with timedatectl), read live;
//  - regionalLocale → ~/.config/environment.d/nidara-locale.conf, the file systemd
//    reads at login, which is what actually decides the regional format.
// region.json was imported once by migrations/2026-09-14d-widgets-pinned-region.sh.
//
// `dateFormat` defaults to "long": what nidara-setup seeded into every fresh
// install's region.json, and what the greeter and lock screen fall back to. The old
// code default ("short") only ever showed on a machine that skipped nidara-setup.
const DATE_FORMATS: readonly DateFormat[] = ["none", "short", "short-year", "long", "numeric", "iso"]
const clock = defineSettings<{ timeFormat: TimeFormat; dateFormat: DateFormat; showSeconds: boolean }>("region", {
    timeFormat: "24h",
    dateFormat: "long",
    showSeconds: false,
}, {
    timeFormat: v => v === "24h" || v === "12h",
    dateFormat: v => DATE_FORMATS.includes(v),
})

class RegionConfigManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "RegionConfigManager",
            Signals: { "changed": {} },
        }, this)
    }

    private _regionalLocale = ""

    constructor() {
        super()
        this._regionalLocale = this._readRegionalLocaleFromFile()
        // A change from any process — Settings, or `gsettings set` — restyles the clock.
        // The greeter's copy of it is written by the shell alone, core/RegionSync.ts (#571).
        clock.subscribeAll(() => this.emit("changed"))
    }

    /** Reads LC_TIME from the environment.d file to detect the saved regional locale. */
    private _readRegionalLocaleFromFile(): string {
        try {
            if (!GLib.file_test(LOCALE_ENV_PATH, GLib.FileTest.EXISTS)) return ""
            const content = readFile(LOCALE_ENV_PATH)
            for (const line of content.split("\n")) {
                const m = line.match(/^LC_TIME=(.+)$/)
                if (m) return m[1].trim()
            }
        } catch {}
        return ""
    }

    /**
     * Reads the active timezone from /etc/localtime symlink.
     * Returns empty string if undetectable.
     */
    detectTimezone(): string {
        try {
            const link = GLib.file_read_link("/etc/localtime")
            const match = link?.match(/zoneinfo\/(.+)$/)
            return match ? match[1] : ""
        } catch {}
        return ""
    }

    get timeFormat(): TimeFormat      { return clock.get("timeFormat") }
    get dateFormat(): DateFormat      { return clock.get("dateFormat") }
    get timezone(): string            { return this.detectTimezone() }
    get showSeconds(): boolean        { return clock.get("showSeconds") }
    get regionalLocale(): string      { return this._regionalLocale }

    /**
     * Writes all REGIONAL_LC_VARS to ~/.config/environment.d/nidara-locale.conf.
     * Pass "" to remove the file (LC_* fall back to LANG).
     * Takes effect on next login (systemd/PAM reads environment.d).
     */
    setRegionalLocale(locale: string) {
        // The unchanged-guard every sibling setter here has, and the only one that
        // was missing it — which mattered more here than anywhere else, because
        // this setter does not just save: it rewrites (or DELETES) a file the
        // systemd user manager reads at login.
        if (this._regionalLocale === locale) return
        this._regionalLocale = locale
        try {
            const dir = `${GLib.get_user_config_dir()}/environment.d`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            if (!locale) {
                if (GLib.file_test(LOCALE_ENV_PATH, GLib.FileTest.EXISTS))
                    GLib.unlink(LOCALE_ENV_PATH)
            } else {
                const content = REGIONAL_LC_VARS.map(v => `${v}=${locale}`).join("\n") + "\n"
                writeFile(LOCALE_ENV_PATH, content)
            }
        } catch (e) {
            console.error("[RegionConfig] Failed to write locale env:", e)
        }
        this.emit("changed")
    }

    // The store notifies synchronously, and the subscription in the constructor
    // emits "changed" — so a setter only writes.
    setTimeFormat(v: TimeFormat)  { clock.set("timeFormat", v) }
    setDateFormat(v: DateFormat)  { clock.set("dateFormat", v) }
    setShowSeconds(v: boolean)    { clock.set("showSeconds", v) }

    setTimezone(tz: string) {
        if (!tz || this.timezone === tz) return
        // The system's timezone IS the setting — requires polkit / sudo or
        // user-level timedatectl. Nothing to store: the getter reads it back.
        execAsync(["timedatectl", "set-timezone", tz])
            .then(() => this.emit("changed"))
            .catch(e => console.error("[RegionConfig] Failed to set timezone:", e))
    }

    /**
     * Returns a fully formatted clock string. The date portion (names + field
     * order) follows the system regional format — LC_TIME via ui/lib/date-names.ts,
     * like Gtk.Calendar — not the in-app UI language.
     */
    formatClock(dt?: GLib.DateTime): string {
        const now = dt ?? GLib.DateTime.new_now_local()
        const sec = this.showSeconds ? ":%S" : ""
        const timeFmt = this.timeFormat === "12h" ? `%I:%M${sec} %p` : `%H:%M${sec}`
        const time  = now.format(timeFmt) ?? ""
        if (this.dateFormat === "none") return time
        return `${formatDatePart(this.dateFormat, now)}  ${time}`
    }

    /** @deprecated Use formatClock() — returns locale-independent output */
    getClockFormat(): string {
        const sec = this.showSeconds ? ":%S" : ""
        const timePart = this.timeFormat === "12h" ? `%I:%M${sec} %p` : `%H:%M${sec}`
        switch (this.dateFormat) {
            case "none":       return timePart
            case "short-year": return `%a %d %b %Y  ${timePart}`
            case "long":       return `%A, %d %b  ${timePart}`
            case "numeric":    return `%d/%m/%Y  ${timePart}`
            case "iso":        return `%Y-%m-%d  ${timePart}`
            default:           return `%a %d %b  ${timePart}`
        }
    }
}

export const regionConfig = new RegionConfigManager()
export default regionConfig
