import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { readFile, writeFile } from "ags/file"
import { execAsync } from "ags/process"

export type TimeFormat = "24h" | "12h"
export type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

export interface RegionSettings {
    timeFormat: TimeFormat
    dateFormat: DateFormat
    timezone: string
    showSeconds: boolean
    regionalLocale: string  // e.g. "es_ES.UTF-8"; "" = same as LANG
}

const CONFIG_PATH = `${GLib.get_user_config_dir()}/crystal-shell/region.json`

// Path where Crystal Shell writes user-level LC_* overrides, picked up by systemd/PAM on login
const LOCALE_ENV_PATH = `${GLib.get_user_config_dir()}/environment.d/crystal-locale.conf`

// Variables that represent "regional format" (not UI language)
const REGIONAL_LC_VARS = [
    "LC_TIME", "LC_NUMERIC", "LC_MONETARY",
    "LC_PAPER", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT",
]

const DEFAULTS: RegionSettings = {
    timeFormat: "24h",
    dateFormat: "short",
    timezone: "",
    showSeconds: false,
    regionalLocale: "",
}

class RegionConfigManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "RegionConfigManager",
            Signals: { "changed": {} },
        }, this)
    }

    private _settings: RegionSettings = { ...DEFAULTS }

    constructor() {
        super()
        this._settings = this.load()

        if (!this._settings.timezone) {
            this._settings.timezone = this.detectTimezone()
        }
        // Detect regional locale from the environment.d file if not saved yet
        if (!this._settings.regionalLocale) {
            this._settings.regionalLocale = this._readRegionalLocaleFromFile()
        }
    }

    private load(): RegionSettings {
        try {
            if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(CONFIG_PATH)) as Partial<RegionSettings>
                return { ...DEFAULTS, ...data }
            }
        } catch {}
        return { ...DEFAULTS }
    }

    private save() {
        try {
            const dir = `${GLib.get_user_config_dir()}/crystal-shell`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o755)
            writeFile(CONFIG_PATH, JSON.stringify(this._settings, null, 2))
        } catch (e) {
            console.error("[RegionConfig] Save failed:", e)
        }
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

    get timeFormat(): TimeFormat      { return this._settings.timeFormat }
    get dateFormat(): DateFormat      { return this._settings.dateFormat }
    get timezone(): string            { return this._settings.timezone }
    get showSeconds(): boolean        { return this._settings.showSeconds ?? false }
    get regionalLocale(): string      { return this._settings.regionalLocale ?? "" }

    /**
     * Writes all REGIONAL_LC_VARS to ~/.config/environment.d/crystal-locale.conf.
     * Pass "" to remove the file (LC_* fall back to LANG).
     * Takes effect on next login (systemd/PAM reads environment.d).
     */
    setRegionalLocale(locale: string) {
        this._settings.regionalLocale = locale
        this.save()
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

    setTimeFormat(v: TimeFormat) {
        if (this._settings.timeFormat === v) return
        this._settings.timeFormat = v
        this.save()
        this.emit("changed")
    }

    setDateFormat(v: DateFormat) {
        if (this._settings.dateFormat === v) return
        this._settings.dateFormat = v
        this.save()
        this.emit("changed")
    }

    setShowSeconds(v: boolean) {
        if ((this._settings.showSeconds ?? false) === v) return
        this._settings.showSeconds = v
        this.save()
        this.emit("changed")
    }

    setTimezone(tz: string) {
        if (!tz || this._settings.timezone === tz) return
        // Apply system timezone — requires polkit / sudo or user-level timedatectl
        execAsync(["timedatectl", "set-timezone", tz])
            .then(() => {
                this._settings.timezone = tz
                this.save()
                this.emit("changed")
            })
            .catch(e => console.error("[RegionConfig] Failed to set timezone:", e))
    }

    /**
     * Returns the `date` format string for use in the bar clock.
     * e.g.  "%a %d %b  %H:%M"
     */
    getClockFormat(): string {
        const sec = this._settings.showSeconds ? ":%S" : ""
        const timePart = this._settings.timeFormat === "12h" ? `%I:%M${sec} %p` : `%H:%M${sec}`
        switch (this._settings.dateFormat) {
            case "none":       return timePart
            case "short-year": return `%a %d %b %Y  ${timePart}`
            case "long":       return `%A, %d %b  ${timePart}`
            case "numeric":    return `%d/%m/%Y  ${timePart}`
            case "iso":        return `%Y-%m-%d  ${timePart}`
            default:           return `%a %d %b  ${timePart}` // short
        }
    }
}

export const regionConfig = new RegionConfigManager()
export default regionConfig
