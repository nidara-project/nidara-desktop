import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

// Governance for the agent-facing surface (Settings → AI). This gates the
// OFFICIAL door (`ags request setConfig`, future MCP server) — it is a consent
// layer, not a security boundary: any local process can still edit config
// files directly, same as the user. Reading state (dumpState/getConfig) is
// always allowed; it powers nidara-doctor and diagnostics.
const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/ai.json`

interface AgentSettings {
    allowConfigWrite: boolean  // agents may change settings via setConfig, default true
    allowScreenshot: boolean   // agents may capture the screen via the screenshot IPC, default true
    allowMcp: boolean          // nidara-mcp serves tools to MCP clients, default true
    allowComputerUse: boolean      // agents may PERCEIVE third-party apps via AT-SPI (nidara-a11y),
                                   // default FALSE — reaches outside the shell's own surface
                                   // (privacy-sensitive, ≈ the screenshot gate)
    allowComputerControl: boolean  // agents may ACT on third-party apps via AT-SPI do_action
                                   // (nidara-act), default FALSE — requires allowComputerUse;
                                   // while granted the bar shows a kill-switch indicator: subtle
                                   // "armed" when idle, a bright "active" pulse while acting
                                   // (see computerActing / pulseComputerAction)
}

const DEFAULTS: AgentSettings = {
    allowConfigWrite: true,
    allowScreenshot: true,
    allowMcp: true,
    allowComputerUse: false,
    allowComputerControl: false,
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
        const dir = `${GLib.get_user_config_dir()}/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify(_settings, null, 2))
    } catch (e) {
        console.error("[AgentConfig] Save failed:", e)
    }
}

const _listeners = new Set<() => void>()

// Transient computer-use ACTIVITY — distinct from allowComputerControl (the
// persistent PERMISSION). Lit by pulseComputerAction() when a real action lands
// (the standalone tools ping `ags request notifyComputerAction`), then decays.
// The bar indicator reads both: "armed" = permitted-but-idle, "active" = acting.
let _acting = false
let _actingTimer = 0
const ACTING_DECAY_MS = 4000

export const agentConfig = {
    get allowConfigWrite() { return _settings.allowConfigWrite },
    get allowScreenshot() { return _settings.allowScreenshot },
    get allowMcp() { return _settings.allowMcp },
    get allowComputerUse() { return _settings.allowComputerUse },
    get allowComputerControl() { return _settings.allowComputerControl },

    // True for ACTING_DECAY_MS after the most recent computer-use action fired.
    get computerActing() { return _acting },

    // Called when a real action lands (via the notifyComputerAction IPC). Lights
    // the active state and (re)arms the decay timer so a burst of actions keeps it
    // lit; the indicator falls back to "armed" once actions stop. Notifies listeners.
    pulseComputerAction() {
        _acting = true
        if (_actingTimer) GLib.source_remove(_actingTimer)
        _actingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACTING_DECAY_MS, () => {
            _acting = false
            _actingTimer = 0
            _listeners.forEach(fn => fn())
            return GLib.SOURCE_REMOVE
        })
        _listeners.forEach(fn => fn())
    },

    setAllowConfigWrite(val: boolean) {
        _settings.allowConfigWrite = val
        save()
        _listeners.forEach(fn => fn())
    },

    setAllowScreenshot(val: boolean) {
        _settings.allowScreenshot = val
        save()
        _listeners.forEach(fn => fn())
    },

    // Read live by the standalone nidara-mcp process (it re-reads
    // ai.json on every tool call), so flipping this needs no restarts.
    setAllowMcp(val: boolean) {
        _settings.allowMcp = val
        save()
        _listeners.forEach(fn => fn())
    },

    // Read live by the standalone nidara-a11y helper (re-reads ai.json per
    // call). Enabling it also turns on toolkit-accessibility — the capability is
    // useless while the a11y stack is globally off, and GTK4 apps only fully
    // populate their AT-SPI tree when it's on. Best-effort; never flipped back
    // off on disable (it may be wanted by other assistive tech).
    setAllowComputerUse(val: boolean) {
        _settings.allowComputerUse = val
        save()
        if (val) {
            try {
                GLib.spawn_command_line_async(
                    "gsettings set org.gnome.desktop.interface toolkit-accessibility true",
                )
            } catch (e) {
                console.error("[AgentConfig] enabling toolkit-accessibility failed:", e)
            }
        }
        _listeners.forEach(fn => fn())
    },

    // Read live by the standalone nidara-act helper + the do_app_action MCP
    // tool (both re-read ai.json per call). Control REQUIRES perception: enabling
    // it implies allowComputerUse (which also flips on toolkit-accessibility) —
    // you can't drive what you can't see. The shell renders a bar indicator +
    // kill switch while this is on.
    setAllowComputerControl(val: boolean) {
        _settings.allowComputerControl = val
        if (val && !_settings.allowComputerUse) {
            _settings.allowComputerUse = true
            try {
                GLib.spawn_command_line_async(
                    "gsettings set org.gnome.desktop.interface toolkit-accessibility true",
                )
            } catch (e) {
                console.error("[AgentConfig] enabling toolkit-accessibility failed:", e)
            }
        }
        save()
        _listeners.forEach(fn => fn())
    },

    onChange(fn: () => void) {
        _listeners.add(fn)
        return () => _listeners.delete(fn)
    },
}

export default agentConfig
