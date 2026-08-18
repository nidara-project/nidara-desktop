// Registers the agent-facing config surface (core/ConfigRegistry) against the
// real services. Lives at the app level — NOT in core/ — because some settings
// (dock) are owned by widget-layer state; core must never import widget code.
// Called once from app.ts main().
//
// Adding a setting here is ALL it takes for agents to see it in
// `describeConfig` and use it via `getConfig`/`setConfig`. Keep descriptions
// real — they are the documentation agents read. First wave is a representative
// subset; grow it opportunistically as services gain setters.

import { registerConfig } from "./core/ConfigRegistry"
import { AGENT_PROVIDERS } from "./core/AgentProviders"
import Theme from "./core/ThemeManager"
import { ACCENT_PALETTE, type AccentKey, type ShellAppearance } from "./core/NidaraTheme"
import NightLight from "./core/NightLightManager"
import notifConfig from "./core/NotifConfig"
import { dontDisturb, setDontDisturb } from "./core/NotifService"
import { reduceMotion, setReduceMotion } from "./core/ReduceMotion"
import recordingConfig, {
    FORMATS, QUALITIES, type RecordFormat, type RecordQuality,
} from "./core/RecordingConfig"
import Gaming, { type WallpaperMode } from "./core/GamingManager"
import agentConfig from "./core/AgentConfig"
import { dockSettings, updateDockSettings, type DockPosition } from "./surfaces/dock/state"

export function registerConfigEntries() {
    // ── Appearance ────────────────────────────────────────────────────────
    registerConfig("appearance.darkMode", {
        desc: "Dark mode (false = light). Propagates to GTK apps and the portal.",
        type: "boolean",
        get: () => Theme.isDark,
        set: v => void Theme.setDarkMode(v as boolean),
    })
    registerConfig("appearance.accent", {
        desc: "Accent color used for active/selected state across the shell and libadwaita apps.",
        type: "enum",
        enum: Object.keys(ACCENT_PALETTE),
        get: () => Theme.accentColor,
        set: v => void Theme.setAccentColor(v as AccentKey),
    })
    registerConfig("appearance.shellAppearance", {
        desc: "Whole shell-skin appearance (bar, dock, and overlays), independent of the system/app mode: 'system' follows dark/light, 'dark'/'light' pin the shell so its text/icons stay legible over any wallpaper. Settings & About are excluded (they follow the app mode).",
        type: "enum",
        enum: ["system", "dark", "light"],
        get: () => Theme.shellAppearance,
        set: v => void Theme.setShellAppearance(v as ShellAppearance),
    })

    // ── Dock ──────────────────────────────────────────────────────────────
    registerConfig("dock.position", {
        desc: "Screen edge the dock anchors to.",
        type: "enum",
        enum: ["bottom", "left", "right"],
        get: () => dockSettings.position,
        set: v => updateDockSettings({ position: v as DockPosition }),
    })
    registerConfig("dock.iconSize", {
        desc: "Base dock icon size in pixels.",
        type: "number",
        min: 32,
        max: 96,
        get: () => dockSettings.iconSize,
        set: v => updateDockSettings({ iconSize: Math.round(v as number) }),
    })
    registerConfig("dock.magnification", {
        desc: "Icon magnification on hover.",
        type: "boolean",
        get: () => dockSettings.magnification,
        set: v => updateDockSettings({ magnification: v as boolean }),
    })
    registerConfig("dock.maxIconSize", {
        desc: "Peak icon size in pixels at full magnification.",
        type: "number",
        min: 64,
        max: 128,
        get: () => dockSettings.maxIconSize,
        set: v => updateDockSettings({ maxIconSize: Math.round(v as number) }),
    })
    registerConfig("dock.autoHide", {
        desc: "Hide the dock until the pointer reaches its screen edge.",
        type: "boolean",
        get: () => dockSettings.autoHide,
        set: v => updateDockSettings({ autoHide: v as boolean }),
    })

    // ── Night light ───────────────────────────────────────────────────────
    registerConfig("nightlight.enabled", {
        desc: "Blue-light filter (hyprsunset).",
        type: "boolean",
        get: () => NightLight.enabled,
        set: v => NightLight.setEnabled(v as boolean),
    })
    registerConfig("nightlight.temperature", {
        desc: "Night light color temperature in Kelvin (lower = warmer).",
        type: "number",
        min: 2700,
        max: 6500,
        get: () => NightLight.temperature,
        set: v => NightLight.setTemperature(v as number),
    })

    // ── Notifications ─────────────────────────────────────────────────────
    registerConfig("notifications.popupTimeout", {
        desc: "Seconds a notification popup stays on screen.",
        type: "number",
        min: 2,
        max: 15,
        get: () => notifConfig.popupTimeout,
        set: v => notifConfig.setPopupTimeout(v as number),
    })
    // The LIVE flag, not a preference about it: this is the same bit the Control
    // Center's focus tile and Settings → Notifications flip, and the daemon persists
    // it on its own, so setting it here survives across sessions with no help from
    // us. It replaced `notifications.dndDefault` (2026-08-16), which only seeded the
    // flag TRUE at startup and could never clear it.
    registerConfig("notifications.doNotDisturb", {
        desc: "Do Not Disturb: suppress notification popups (critical ones still show). Persists across sessions until turned off.",
        type: "boolean",
        get: dontDisturb,
        set: v => setDontDisturb(v as boolean),
    })

    // ── Accessibility ─────────────────────────────────────────────────────
    // Backed by the GNOME gsetting `enable-animations` (inverted), NOT by a
    // nidara-*.json — see core/ReduceMotion.ts for why a shadow copy would be
    // wrong. Writing it here reaches the shell's own motion AND Hyprland's.
    registerConfig("accessibility.reduceMotion", {
        desc: "Reduce motion: overlays appear without their pop, dock icons snap instead of springing, and Hyprland's window/workspace animations are switched off. Movement that follows the pointer (swipes, sliders) and the Assistant's pointer animation are deliberately unaffected.",
        type: "boolean",
        get: () => reduceMotion(),
        set: v => setReduceMotion(v as boolean),
    })

    // ── Screen recording ──────────────────────────────────────────────────
    registerConfig("recording.audioSource", {
        desc: "What the capture panel's Audio switch records: '@system' (the default output's monitor — what you hear), '@mic' (the default input), or a literal PulseAudio source name from `pactl list short sources`. A named device that is no longer present falls back to '@system' rather than silently recording something else.",
        type: "string",
        get: () => recordingConfig.audioSource,
        set: v => recordingConfig.setAudioSource(v as string),
    })
    registerConfig("recording.quality", {
        desc: "Encoder quality preset for screen recordings. Trades file size against fidelity; the exact CRF/QP depends on the codec the format selects.",
        type: "enum",
        enum: QUALITIES,
        get: () => recordingConfig.quality,
        set: v => recordingConfig.setQuality(v as RecordQuality),
    })
    registerConfig("recording.framerate", {
        desc: "Recording frame rate. 0 = follow the compositor (a frame only when the screen changes — variable rate, smallest file); otherwise a constant rate.",
        type: "number",
        min: 0,
        max: 120,
        get: () => recordingConfig.framerate,
        set: v => recordingConfig.setFramerate(v as number),
    })
    registerConfig("recording.hardware", {
        desc: "Encode screen recordings on the GPU (VAAPI). Applies to the H.264 formats (mp4/mkv) only — webm always encodes in software, and the setting is ignored without a /dev/dri render node.",
        type: "boolean",
        get: () => recordingConfig.hardware,
        set: v => recordingConfig.setHardware(v as boolean),
    })
    registerConfig("recording.format", {
        desc: "Container for screen recordings. mp4/mkv record H.264, webm records VP9.",
        type: "enum",
        enum: FORMATS,
        get: () => recordingConfig.format,
        set: v => recordingConfig.setFormat(v as RecordFormat),
    })
    registerConfig("recording.saveDir", {
        desc: "Directory screen recordings are written to (created if missing).",
        type: "string",
        get: () => recordingConfig.saveDir,
        set: v => recordingConfig.setSaveDir(v as string),
    })

    // ── Gaming ────────────────────────────────────────────────────────────
    registerConfig("gaming.performanceProfile", {
        desc: "Switch the power profile to performance while a game runs.",
        type: "boolean",
        get: () => Gaming.performanceProfile,
        set: v => Gaming.setPerformanceProfile(v as boolean),
    })
    registerConfig("gaming.wallpaperMode", {
        desc: "Wallpaper while gaming: Steam hero artwork, a custom image, or unchanged.",
        type: "enum",
        enum: ["artwork", "custom", "none"],
        get: () => Gaming.wallpaperMode,
        set: v => Gaming.setWallpaperMode(v as WallpaperMode),
    })

    // ── AI governance ─────────────────────────────────────────────────────
    // Visible so agents can SEE the gate, but not writable through the gate it
    // controls — flipping it is reserved to the Settings → AI page.
    registerConfig("ai.allowConfigWrite", {
        desc: "Whether agents may change settings via setConfig. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowConfigWrite,
    })
    registerConfig("ai.allowScreenshot", {
        desc: "Whether agents may capture the screen via the screenshot IPC. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowScreenshot,
    })
    registerConfig("ai.allowWindowClose", {
        desc: "Whether agents may close windows via the closeWindow IPC. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowWindowClose,
    })
    registerConfig("ai.allowMcp", {
        desc: "Whether nidara-mcp serves tools to MCP clients. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowMcp,
    })
    // The computer-use and file gates were added later (2026-07-27) and were the
    // only ones missing here, which made `describeConfig` a HALF-TRUTH: asked what
    // permissions were on, the Assistant answered with the four above and no way to
    // know it was answering four of eight. Same read-only rule as the rest — these
    // are the most sensitive gates in the product, so `setConfig` must keep
    // refusing them; the Settings → AI page is the only door that flips them.
    // A `desc` does NOT restate the default: `value` is in the same JSON object, so
    // a default is a second answer to the question the reader came with. (The first
    // draft said "Off by default"; removing it did NOT fix the misread it was
    // suspected of — that turned out to be the UI tree carrying no switch state,
    // see UITree.activeOf — but a desc that answers a question the value already
    // answers is worth avoiding on its own.) What belongs here is what the value
    // cannot say: what the gate opens, which gate it implies, where it is flipped.
    registerConfig("ai.allowComputerUse", {
        desc: "Whether agents may PERCEIVE other apps via the accessibility tree (nidara-a11y, query_app). Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowComputerUse,
    })
    registerConfig("ai.allowComputerControl", {
        desc: "Whether agents may ACT in other apps — accessibility actions, synthetic keyboard and pointer (nidara-act/type/click). Implies allowComputerUse. Toggle it in Settings → AI, or revoke it instantly with the kill switch (disableComputerControl).",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowComputerControl,
    })
    registerConfig("ai.allowFileRead", {
        desc: "Whether the built-in Assistant may READ Nidara's own config, the shipped assets and the shell log (read_file/list_dir/search_files, prefix-limited). Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowFileRead,
    })
    registerConfig("ai.allowFileWrite", {
        desc: "Whether the built-in Assistant may WRITE the three user-owned config files it is allowed to edit (edit_file/write_file, exact allowlist, every write committed to git). Implies allowFileRead. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowFileWrite,
    })
    // The one ai.* entry that IS writable, because it is the one that is not a
    // gate: it turns a visual signal on and off and grants nothing. Writable also
    // makes it answerable — "stop glowing my windows" is a reasonable thing to ask
    // the Assistant, and it can do it about itself.
    registerConfig("ai.assistantGlow", {
        desc: "Glow the border of the window the built-in Assistant is working in, for as long as a turn runs. Requires Hyprland 0.56+; makes Nidara the owner of decoration:glow.",
        type: "boolean",
        writable: true,
        get: () => agentConfig.assistantGlow,
        set: v => agentConfig.setAssistantGlow(v as boolean),
    })
    // The built-in Assistant's brain (BYOK). Visible so agents can see how the
    // native assistant is configured; set it in Settings → AI (the API key lives
    // in the keyring and is deliberately NOT exposed here).
    registerConfig("ai.brainProvider", {
        desc: "Which provider the built-in Assistant talks to: '' (off) or a provider id (anthropic, openai, google, mistral, groq, openrouter, ollama, custom). Set it in Settings → AI.",
        type: "enum",
        enum: ["", ...AGENT_PROVIDERS.map(p => p.id)],
        writable: false,
        get: () => agentConfig.brainProvider,
    })
    registerConfig("ai.brainBackend", {
        desc: "Wire protocol derived from the provider: '' (off), 'anthropic' (Messages API), or 'openai' (OpenAI-compatible). Read-only — pick a provider instead.",
        type: "enum",
        enum: ["", "anthropic", "openai"],
        writable: false,
        get: () => agentConfig.brainBackend,
    })
    registerConfig("ai.brainModel", {
        desc: "Model id the built-in Assistant talks to (e.g. claude-opus-4-8, or a local model name). Set it in Settings → AI.",
        type: "string",
        writable: false,
        get: () => agentConfig.brainModel,
    })
}
