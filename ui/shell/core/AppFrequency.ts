import GLib from "gi://GLib"

interface FrequencyEntry {
    count: number
    last: number // Unix timestamp in seconds
}

interface FrequencyData {
    version: 1
    entries: Record<string, FrequencyEntry>
}

// 14 days half-life in seconds (14 * 24 * 3600)
const HALF_LIFE_SECS = 14 * 86400
const MIN_RETAIN_SCORE = 0.05

export class AppFrequency {
    private entries = new Map<string, FrequencyEntry>()
    private saveTimerId: number | null = null
    private readonly filePath: string

    constructor(customPath?: string) {
        const configDir = `${GLib.get_user_config_dir()}/nidara`
        this.filePath = customPath ?? `${configDir}/app-frequency.json`
        this.load()
    }

    private normId(id: string): string {
        const base = (id || "").split("/").pop() || id || ""
        return base.toLowerCase().replace(/\.desktop$/, "").trim()
    }

    private decay(entry: FrequencyEntry, now: number): number {
        if (!entry || entry.count <= 0) return 0
        const elapsed = Math.max(0, now - entry.last)
        return entry.count * Math.pow(2, -elapsed / HALF_LIFE_SECS)
    }

    private nowSecs(): number {
        return Math.floor(Date.now() / 1000)
    }

    /**
     * Get the decayed launch frequency score for an application ID.
     */
    getFrequency(id: string): number {
        const key = this.normId(id)
        if (!key) return 0
        const entry = this.entries.get(key)
        if (!entry) return 0
        return this.decay(entry, this.nowSecs())
    }

    /**
     * Get all active app frequencies mapped by normalized ID.
     */
    getFrequencies(): Map<string, number> {
        const now = this.nowSecs()
        const result = new Map<string, number>()
        for (const [key, entry] of this.entries) {
            const score = this.decay(entry, now)
            if (score >= MIN_RETAIN_SCORE) {
                result.set(key, score)
            }
        }
        return result
    }

    /**
     * Record an application launch, advancing its frequency score and updating its timestamp.
     */
    recordLaunch(id: string): void {
        const key = this.normId(id)
        if (!key) return

        const now = this.nowSecs()
        const existing = this.entries.get(key)
        const currentDecayed = existing ? this.decay(existing, now) : 0
        const newCount = currentDecayed + 1.0

        this.entries.set(key, { count: newCount, last: now })
        this.scheduleSave()
    }

    private scheduleSave(): void {
        if (this.saveTimerId !== null) return
        this.saveTimerId = GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
            this.saveTimerId = null
            this.save()
            return GLib.SOURCE_REMOVE
        })
    }

    save(): void {
        const now = this.nowSecs()
        const prunedEntries: Record<string, FrequencyEntry> = {}

        for (const [key, entry] of this.entries) {
            const score = this.decay(entry, now)
            if (score >= MIN_RETAIN_SCORE) {
                prunedEntries[key] = { count: score, last: now }
            }
        }

        const data: FrequencyData = {
            version: 1,
            entries: prunedEntries,
        }

        try {
            const dir = GLib.path_get_dirname(this.filePath)
            GLib.mkdir_with_parents(dir, 0o755)
            GLib.file_set_contents(this.filePath, JSON.stringify(data, null, 2))
        } catch (e) {
            console.error("[AppFrequency] Failed to save frequency data:", e)
        }
    }

    load(): void {
        this.entries.clear()
        try {
            if (!GLib.file_test(this.filePath, GLib.FileTest.EXISTS)) return
            const [ok, bytes] = GLib.file_get_contents(this.filePath)
            if (!ok || !bytes) return

            const text = new TextDecoder().decode(bytes)
            const data = JSON.parse(text) as Partial<FrequencyData>
            if (data && data.version === 1 && data.entries && typeof data.entries === "object") {
                const now = this.nowSecs()
                for (const [key, val] of Object.entries(data.entries)) {
                    if (val && typeof val.count === "number" && typeof val.last === "number") {
                        if (this.decay(val, now) >= MIN_RETAIN_SCORE) {
                            this.entries.set(key, { count: val.count, last: val.last })
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[AppFrequency] Failed to load frequency data:", e)
        }
    }
}

export const appFrequency = new AppFrequency()
export default appFrequency
