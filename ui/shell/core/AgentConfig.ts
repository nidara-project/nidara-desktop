import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

// Governance for the agent-facing surface (Settings → AI). This gates the
// OFFICIAL door (`ags request setConfig`, future MCP server) — it is a consent
// layer, not a security boundary: any local process can still edit config
// files directly, same as the user. Reading state (dumpState/getConfig) is
// always allowed; it powers crystal-shell-doctor and diagnostics.
const CONFIG_PATH = `${GLib.get_user_config_dir()}/crystal-shell/ai.json`

interface AgentSettings {
    allowConfigWrite: boolean // agents may change settings via setConfig, default true
}

const DEFAULTS: AgentSettings = {
    allowConfigWrite: true,
}

let _settings: AgentSettings = { ...DEFAULTS }
try {
    if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
        const data = JSON.parse(readFile(CONFIG_PATH)) as Partial<AgentSettings>
        _settings = { ...DEFAULTS, ...data }
    }
} catch {}

function save() {
    try {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify(_settings, null, 2))
    } catch (e) {
        console.error("[AgentConfig] Save failed:", e)
    }
}

const _listeners = new Set<() => void>()

export const agentConfig = {
    get allowConfigWrite() { return _settings.allowConfigWrite },

    setAllowConfigWrite(val: boolean) {
        _settings.allowConfigWrite = val
        save()
        _listeners.forEach(fn => fn())
    },

    onChange(fn: () => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default agentConfig
