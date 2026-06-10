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
import Theme from "./core/ThemeManager"
import { ACCENT_PALETTE, type AccentKey } from "./core/FluidCrystal"
import NightLight from "./core/NightLightManager"
import notifConfig from "./core/NotifConfig"
import Gaming, { type WallpaperMode } from "./core/GamingManager"
import agentConfig from "./core/AgentConfig"
import { dockSettings, updateDockSettings, type DockPosition } from "./widget/dock/state"

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
        desc: "macOS-style icon magnification on hover.",
        type: "boolean",
        get: () => dockSettings.magnification,
        set: v => updateDockSettings({ magnification: v as boolean }),
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
    registerConfig("notifications.dndDefault", {
        desc: "Start each session with Do Not Disturb active.",
        type: "boolean",
        get: () => notifConfig.dndDefault,
        set: v => notifConfig.setDndDefault(v as boolean),
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
}
