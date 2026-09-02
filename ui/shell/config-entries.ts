// Registers the agent-facing config surface (core/ConfigRegistry) against the
// real services. Lives at the app level — NOT in core/ — because some settings
// (dock) are owned by widget-layer state; core must never import widget code.
// Called once from app.ts main().
//
// Adding a setting here is ALL it takes for agents to see it in
// `describeConfig` and use it via `getConfig`/`setConfig`. Keep descriptions
// real — they are the documentation agents read. First wave is a representative
// subset; grow it opportunistically as services gain setters.

import Gtk from "gi://Gtk?version=4.0"
import { registerConfig } from "./core/ConfigRegistry"
import { AGENT_PROVIDERS } from "./core/AgentProviders"
import Theme, { TEXT_SCALE_MIN, TEXT_SCALE_MAX } from "./core/ThemeManager"
import { ACCENT_PALETTE, GLASS_RANGE, type AccentKey, type ShellAppearance } from "./core/NidaraTheme"
import NightLight from "./core/NightLightManager"
import Wallpaper, { TRANSITION_LABELS, TRANSITIONS, type TransitionType } from "./core/WallpaperManager"
import notifConfig from "./core/NotifConfig"
import { dontDisturb, setDontDisturb } from "./core/NotifService"
import { reduceMotion, setReduceMotion, onReduceMotionChange } from "./core/ReduceMotion"
import recordingConfig, {
    FORMATS, QUALITIES, type RecordFormat, type RecordQuality,
} from "./core/RecordingConfig"
import Gaming, { WALLPAPER_MODES, type WallpaperMode } from "./core/GamingManager"
import agentConfig from "./core/AgentConfig"
import { dockSettings, updateDockSettings, onDockSettingChanged, type DockPosition } from "./surfaces/dock/state"
import { barConfig } from "./surfaces/bar/barState"
import regionConfig from "./core/RegionConfig"
import { getIdleConfig, updateIdleConfig, onHypridleChanged } from "./core/PowerConfig"
import inputConfig from "./core/InputConfig"
import Icons from "./core/Icons"
import { safeDisconnect } from "./core/signals"
import { t } from "./core/i18n"

const KEYBOARD_LAYOUTS: [string, string, string, string][] = [
    ["us",           "English (US)",              "us",    ""],
    ["gb",           "English (UK)",              "gb",    ""],
    ["es",           "Español (ES)",              "es",    ""],
    ["latam",        "Español (Latinoamérica)",   "latam", ""],
    ["fr",           "Français",                  "fr",    ""],
    ["de",           "Deutsch",                   "de",    ""],
    ["it",           "Italiano",                  "it",    ""],
    ["br",           "Português (Brasil)",        "br",    ""],
    ["pt",           "Português (Portugal)",      "pt",    ""],
    ["nl",           "Nederlands",                "nl",    ""],
    ["pl",           "Polski",                    "pl",    ""],
    ["ru",           "Русский",                   "ru",    ""],
    ["ua",           "Українська",                "ua",    ""],
    ["jp",           "日本語 (Romaji)",            "jp",    ""],
    ["cn",           "中文 (Pinyin)",              "cn",    ""],
    ["kr",           "한국어",                     "kr",    ""],
    ["ara",          "العربية",                    "ara",   ""],
    ["se",           "Svenska",                   "se",    ""],
    ["no",           "Norsk",                     "no",    ""],
    ["dk",           "Dansk",                     "dk",    ""],
    ["fi",           "Suomi",                     "fi",    ""],
    ["cz",           "Čeština",                   "cz",    ""],
    ["sk",           "Slovenčina",                "sk",    ""],
    ["hu",           "Magyar",                    "hu",    ""],
    ["ro",           "Română",                    "ro",    ""],
    ["tr",           "Türkçe",                    "tr",    ""],
    ["us-dvorak",    "English (Dvorak)",          "us",    "dvorak"],
    ["us-colemak",   "English (Colemak)",         "us",    "colemak"],
]

const currentKbLayoutId = (): string => {
    const cur = KEYBOARD_LAYOUTS.find(([, , l, v]) => l === inputConfig.kbLayout && v === inputConfig.kbVariant)
    if (cur) return cur[0]
    return inputConfig.kbVariant ? `${inputConfig.kbLayout} (${inputConfig.kbVariant})` : inputConfig.kbLayout
}

const kbLayoutLabel = (id: string): string => {
    const entry = KEYBOARD_LAYOUTS.find(([k]) => k === id)
    return entry ? entry[1] : id
}

const PROVIDER_NAMES: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google (Gemini)",
    spacexai: "SpaceXAI (Grok)",
}

function brainProviderLabel(id: string): string {
    if (!id) return t("settings.ai.brain.provider.off")
    if (id === "custom") return t("settings.ai.brain.provider.custom")
    if (id === "localhost") return t("settings.ai.brain.provider.localhost")
    if (id === "ollama") return t("settings.ai.brain.provider.ollama")
    return PROVIDER_NAMES[id] ?? id
}

const powerScreenOffLabel = (s: string): string => {
    if (s === "0") return t("settings.power.opt.never")
    const mins = Math.round(Number(s) / 60)
    return `${mins} ${t("settings.power.time.min")}`
}

const powerLockLabel = (s: string): string => {
    if (s === "0") return t("settings.power.opt.never")
    const secs = Number(s)
    if (secs < 3600) {
        return `${Math.round(secs / 60)} ${t("settings.power.time.min")}`
    }
    const hours = Math.round(secs / 3600)
    return `${hours} ${hours === 1 ? t("settings.power.time.hour") : t("settings.power.time.hours")}`
}

const powerSuspendLabel = (s: string): string => {
    if (s === "0") return t("settings.power.opt.never")
    const secs = Number(s)
    if (secs < 3600) {
        return `${Math.round(secs / 60)} ${t("settings.power.time.min")}`
    }
    const hours = Math.round(secs / 3600)
    return `${hours} ${hours === 1 ? t("settings.power.time.hour") : t("settings.power.time.hours")}`
}

const onInputCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    const id = inputConfig.connect("changed", () => apply(read()))
    return () => safeDisconnect(inputConfig, id)
}

const onThemeCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    const id = Theme.connect("changed", () => apply(read()))
    return () => safeDisconnect(Theme, id)
}

const onWallpaperCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    const id = Wallpaper.connect("changed", () => apply(read()))
    return () => safeDisconnect(Wallpaper, id)
}

const onAiCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    return agentConfig.onChange(() => apply(read()))
}

const onPowerCfg = (read: () => any) => (apply: (v: any) => void) => {
    apply(read())
    return onHypridleChanged(() => apply(read()))
}

export function registerConfigEntries() {
    // ── Appearance ────────────────────────────────────────────────────────
    registerConfig("appearance.darkMode", {
        desc: "Dark mode (false = light). Propagates to GTK apps and the portal.",
        type: "boolean",
        get: () => Theme.isDark,
        set: v => Theme.setDarkMode(v as boolean),
        subscribe: onThemeCfg(() => Theme.isDark),
        ui: {
            i18n: "settings.appearance.dark-mode",
        },
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
        subscribe: onThemeCfg(() => Theme.shellAppearance),
        ui: {
            i18n: "settings.appearance.shell-appearance",
            optI18n: k => t(`settings.appearance.shell-appearance.${k}` as any),
        },
    })
    registerConfig("appearance.barOpacity", {
        desc: "Bar glass opacity (0.24 to 0.80).",
        type: "number",
        min: GLASS_RANGE.min,
        max: GLASS_RANGE.max,
        get: () => Theme.barOpacity,
        set: v => void Theme.setBarOpacity(Number(v)),
        subscribe: onThemeCfg(() => Theme.barOpacity),
        ui: {
            i18n: "settings.appearance.bar-opacity",
            slider: { pct: true },
        },
    })
    registerConfig("appearance.overlayOpacity", {
        desc: "Glass opacity for menus, the dock, popups, and the alert dialog (0.24 to 0.80).",
        type: "number",
        min: GLASS_RANGE.min,
        max: GLASS_RANGE.max,
        get: () => Theme.overlayOpacity,
        set: v => void Theme.setOverlayOpacity(Number(v)),
        subscribe: onThemeCfg(() => Theme.overlayOpacity),
        ui: {
            i18n: "settings.appearance.overlay-opacity",
            slider: { pct: true },
        },
    })
    registerConfig("appearance.dockOpacity", {
        desc: "Dock glass opacity (0.24 to 0.80).",
        type: "number",
        min: GLASS_RANGE.min,
        max: GLASS_RANGE.max,
        get: () => Theme.dockOpacity,
        set: v => void Theme.setDockOpacity(Number(v)),
        subscribe: onThemeCfg(() => Theme.dockOpacity),
        ui: {
            i18n: "settings.appearance.dock-opacity",
            slider: { pct: true },
        },
    })
    registerConfig("appearance.windowOpacity", {
        desc: "Window glass opacity (0.24 to 0.80).",
        type: "number",
        min: GLASS_RANGE.min,
        max: GLASS_RANGE.max,
        get: () => Theme.windowOpacity,
        set: v => void Theme.setWindowOpacity(Number(v)),
        subscribe: onThemeCfg(() => Theme.windowOpacity),
        ui: {
            i18n: "settings.appearance.window-glass",
            slider: { pct: true, icons: [Icons.minus, Icons.plus] },
        },
    })
    registerConfig("appearance.gtkTheme", {
        desc: "System GTK theme.",
        type: "enum",
        enum: Theme.getAvailableGtkThemes(),
        get: () => Theme.themeFamily,
        set: v => Theme.setGtkTheme(v as string),
        subscribe: onThemeCfg(() => Theme.themeFamily),
        ui: {
            i18n: "settings.appearance.gtk-theme",
            optI18n: v => v,
        },
    })
    registerConfig("appearance.iconTheme", {
        desc: "System icon theme.",
        type: "enum",
        enum: Theme.getAvailableIconThemes(),
        get: () => Theme.iconTheme,
        set: v => Theme.setIconTheme(v as string),
        subscribe: onThemeCfg(() => Theme.iconTheme),
        ui: {
            i18n: "settings.appearance.icons",
            optI18n: v => v,
        },
    })
    registerConfig("appearance.cursorTheme", {
        desc: "System cursor theme.",
        type: "enum",
        enum: Theme.getAvailableCursorThemes(),
        get: () => Theme.cursorTheme,
        set: v => Theme.setCursorTheme(v as string),
        subscribe: onThemeCfg(() => Theme.cursorTheme),
        ui: {
            i18n: "settings.appearance.cursor",
            optI18n: v => v,
        },
    })
    registerConfig("wallpaper.transition", {
        desc: "Wallpaper transition animation style.",
        type: "enum",
        enum: TRANSITIONS,
        get: () => Wallpaper.transition,
        set: v => Wallpaper.setTransition(v as TransitionType),
        subscribe: onWallpaperCfg(() => Wallpaper.transition),
        ui: {
            i18n: "settings.appearance.transition",
            optI18n: k => TRANSITION_LABELS[k as TransitionType] ?? k,
        },
    })

    // ── Dock ──────────────────────────────────────────────────────────────
    registerConfig("dock.position", {
        desc: "Dock screen position.",
        type: "enum",
        enum: ["bottom", "left", "right"],
        get: () => dockSettings.position,
        set: v => updateDockSettings({ position: v as DockPosition }),
        subscribe: (apply) => {
            apply(dockSettings.position)
            return onDockSettingChanged("position", apply)
        },
        ui: {
            i18n: "settings.dock.position",
            optI18n: v => t(`settings.dock.opt.${v}` as any),
        },
    })
    registerConfig("dock.iconSize", {
        desc: "Dock icon size in pixels (32, 48, 64, 80, 96).",
        type: "number",
        min: 32,
        max: 96,
        get: () => dockSettings.iconSize,
        set: v => updateDockSettings({ iconSize: v as number }),
        subscribe: (apply) => {
            apply(dockSettings.iconSize)
            return onDockSettingChanged("iconSize", apply)
        },
        ui: {
            i18n: "settings.dock.icon-size",
            control: "preset",
            presets: [32, 48, 64, 80, 96],
            presetUnit: "px",
        },
    })
    registerConfig("dock.screenGap", {
        desc: "Dock margin from screen edge in pixels.",
        type: "number",
        min: 4,
        max: 32,
        get: () => dockSettings.screenGap,
        set: v => updateDockSettings({ screenGap: v as number }),
        subscribe: (apply) => {
            apply(dockSettings.screenGap)
            return onDockSettingChanged("screenGap", apply)
        },
        ui: {
            i18n: "settings.dock.bottom-margin",
            slider: { unit: "px" },
        },
    })
    registerConfig("dock.magnification", {
        desc: "Magnify dock icons on hover.",
        type: "boolean",
        get: () => dockSettings.magnification,
        set: v => updateDockSettings({ magnification: v as boolean }),
        subscribe: (apply) => {
            apply(dockSettings.magnification)
            return onDockSettingChanged("magnification", apply)
        },
        ui: {
            i18n: "settings.dock.magnification",
        },
    })
    registerConfig("dock.maxIconSize", {
        desc: "Maximum icon size on hover when magnification is enabled.",
        type: "number",
        min: 64,
        max: 128,
        get: () => dockSettings.maxIconSize,
        set: v => updateDockSettings({ maxIconSize: v as number }),
        subscribe: (apply) => {
            apply(dockSettings.maxIconSize)
            return onDockSettingChanged("maxIconSize", apply)
        },
        ui: {
            i18n: "settings.dock.max-size",
            slider: { unit: "px" },
        },
    })
    registerConfig("dock.autoHide", {
        desc: "Automatically hide the dock when windows overlap it.",
        type: "boolean",
        get: () => dockSettings.autoHide,
        set: v => updateDockSettings({ autoHide: v as boolean }),
        subscribe: (apply) => {
            apply(dockSettings.autoHide)
            return onDockSettingChanged("autoHide", apply)
        },
        ui: {
            i18n: "settings.dock.autohide",
        },
    })
    registerConfig("dock.indicators", {
        desc: "Show running-application indicator dots under dock icons.",
        type: "boolean",
        get: () => dockSettings.showIndicators,
        set: v => updateDockSettings({ showIndicators: v as boolean }),
        subscribe: (apply) => {
            apply(dockSettings.showIndicators)
            return onDockSettingChanged("showIndicators", apply)
        },
        ui: {
            i18n: "settings.dock.indicators",
        },
    })
    registerConfig("dock.hideDelay", {
        desc: "Delay in milliseconds before hiding the dock.",
        type: "number",
        min: 0,
        max: 2000,
        get: () => dockSettings.hideDelay,
        set: v => updateDockSettings({ hideDelay: Math.round(Number(v)) }),
        subscribe: (apply) => {
            apply(dockSettings.hideDelay)
            return onDockSettingChanged("hideDelay", apply)
        },
        ui: {
            i18n: "settings.dock.hide-delay",
            slider: { unit: "ms" },
        },
    })

    // ── Bar ───────────────────────────────────────────────────────────────
    registerConfig("bar.appTitle", {
        desc: "Show the active window title in the top bar.",
        type: "boolean",
        get: () => barConfig.get("showAppTitle"),
        set: v => barConfig.set("showAppTitle", v as boolean),
        subscribe: (apply) => {
            apply(barConfig.get("showAppTitle"))
            return barConfig.subscribe("showAppTitle", apply)
        },
        ui: {
            i18n: "settings.bar.app-title",
        },
    })

    // ── Input: Mouse ──────────────────────────────────────────────────────
    registerConfig("input.mouse.speed", {
        desc: "Pointer sensitivity (-1.0 to 1.0).",
        type: "number",
        min: -1.0,
        max: 1.0,
        get: () => inputConfig.pointerSpeed,
        set: v => inputConfig.setPointerSpeed(v as number),
        subscribe: onInputCfg(() => inputConfig.pointerSpeed),
        ui: {
            i18n: "settings.input.mouse.speed",
            slider: {
                // Sink caro: `inputConfig` ejecuta Lua en el compositor Y reescribe
                // `nidara-settings.lua` entero en cada confirmación. Con los 32 ms
                // de debounce del kit, arrastrar el pulgar son ~30 de esas por
                // segundo. `commitOnRelease` confirma UNA vez, al soltar; el valor
                // se sigue viendo moverse porque la etiqueta la pinta
                // `onValueChanged`, que no es la que escribe.
                commitOnRelease: true,
                icons: [Icons.mousePointer, Icons.mousePointer],
                pct: true,
            },
        },
    })
    registerConfig("input.mouse.accel", {
        desc: "Pointer acceleration profile: 'adaptive' or 'flat'.",
        type: "enum",
        enum: ["adaptive", "flat"],
        get: () => inputConfig.accelProfile,
        set: v => inputConfig.setAccelProfile(v as string),
        subscribe: onInputCfg(() => inputConfig.accelProfile),
        ui: {
            i18n: "settings.input.mouse.accel",
            optI18n: (v) => v,
        },
    })
    registerConfig("input.mouse.natural", {
        desc: "Invert mouse scroll direction (natural scrolling).",
        type: "boolean",
        get: () => inputConfig.mouseNaturalScroll,
        set: v => inputConfig.setMouseNaturalScroll(v as boolean),
        subscribe: onInputCfg(() => inputConfig.mouseNaturalScroll),
        ui: {
            i18n: "settings.input.mouse.natural",
        },
    })

    // ── Input: Touchpad ───────────────────────────────────────────────────
    registerConfig("input.touchpad.natural", {
        desc: "Invert touchpad scroll direction (natural scrolling).",
        type: "boolean",
        get: () => inputConfig.touchpadNaturalScroll,
        set: v => inputConfig.setTouchpadNaturalScroll(v as boolean),
        subscribe: onInputCfg(() => inputConfig.touchpadNaturalScroll),
        ui: {
            i18n: "settings.input.touchpad.natural",
        },
    })
    registerConfig("input.touchpad.tap", {
        desc: "Tap touchpad to click.",
        type: "boolean",
        get: () => inputConfig.touchpadTap,
        set: v => inputConfig.setTouchpadTap(v as boolean),
        subscribe: onInputCfg(() => inputConfig.touchpadTap),
        ui: {
            i18n: "settings.input.touchpad.tap",
        },
    })

    // ── Input: Keyboard ───────────────────────────────────────────────────
    registerConfig("input.keyboard.layout", {
        desc: "Keyboard layout code (e.g. 'us', 'es', 'us-dvorak').",
        type: "enum",
        enum: KEYBOARD_LAYOUTS.map(([id]) => id),
        get: () => currentKbLayoutId(),
        set: v => {
            const entry = KEYBOARD_LAYOUTS.find(([id]) => id === v)
            if (entry) {
                return inputConfig.setKbLayout(entry[2], entry[3])
            } else {
                const raw = String(v)
                const parts = raw.split("-")
                return inputConfig.setKbLayout(parts[0], parts.slice(1).join("-"))
            }
        },
        subscribe: onInputCfg(() => currentKbLayoutId()),
        ui: {
            i18n: "settings.input.keyboard.layout",
            optI18n: kbLayoutLabel,
        },
    })
    registerConfig("input.keyboard.numlock", {
        desc: "Enable NumLock on boot.",
        type: "boolean",
        get: () => inputConfig.numlockOnBoot,
        set: v => inputConfig.setNumlockOnBoot(v as boolean),
        subscribe: onInputCfg(() => inputConfig.numlockOnBoot),
        ui: {
            i18n: "settings.input.keyboard.numlock",
        },
    })
    registerConfig("input.keyboard.repeatDelay", {
        desc: "Keyboard repeat delay in milliseconds before repeating keys.",
        type: "number",
        min: 100,
        max: 2000,
        get: () => inputConfig.kbRepeatDelay,
        set: v => inputConfig.setKbRepeatDelay(v as number),
        subscribe: onInputCfg(() => inputConfig.kbRepeatDelay),
        ui: {
            i18n: "settings.input.keyboard.repeat-delay",
            // Sink caro: `inputConfig` ejecuta Lua en el compositor Y reescribe
            // `nidara-settings.lua` entero en cada confirmación. Con los 32 ms de
            // debounce del kit, arrastrar el pulgar son ~30 de esas por segundo.
            // `commitOnRelease` confirma UNA vez, al soltar; el valor sigue
            // viéndose moverse porque la etiqueta la pinta `onValueChanged`, que
            // no es la que escribe.
            slider: { unit: "ms", commitOnRelease: true },
        },
    })
    registerConfig("input.keyboard.repeatRate", {
        desc: "Keyboard repeat rate in characters per second.",
        type: "number",
        min: 1,
        max: 100,
        get: () => inputConfig.kbRepeatRate,
        set: v => inputConfig.setKbRepeatRate(v as number),
        subscribe: onInputCfg(() => inputConfig.kbRepeatRate),
        ui: {
            i18n: "settings.input.keyboard.repeat-rate",
            // Sink caro: `inputConfig` ejecuta Lua en el compositor Y reescribe
            // `nidara-settings.lua` entero en cada confirmación. Con los 32 ms de
            // debounce del kit, arrastrar el pulgar son ~30 de esas por segundo.
            // `commitOnRelease` confirma UNA vez, al soltar; el valor sigue
            // viéndose moverse porque la etiqueta la pinta `onValueChanged`, que
            // no es la que escribe.
            slider: { unit: "/s", commitOnRelease: true },
        },
    })

    // ── Night light ───────────────────────────────────────────────────────
    registerConfig("nightlight.enabled", {
        desc: "Blue-light filter (hyprsunset).",
        type: "boolean",
        get: () => NightLight.enabled,
        set: v => NightLight.setEnabled(v as boolean),
        subscribe: (apply) => {
            apply(NightLight.enabled)
            return NightLight.subscribe("enabled", apply)
        },
        ui: {
            i18n: "settings.appearance.night-light",
        },
    })
    registerConfig("nightlight.temperature", {
        desc: "Night light color temperature in Kelvin (lower = warmer).",
        type: "number",
        min: 2700,
        max: 6500,
        get: () => NightLight.temperature,
        set: v => NightLight.setTemperature(v as number),
        subscribe: (apply) => {
            apply(NightLight.temperature)
            return NightLight.subscribe("temperature", apply)
        },
        ui: {
            i18n: "settings.appearance.night-light-temp",
            slider: { unit: "K", icons: [Icons.minus, Icons.plus] },
        },
    })
    registerConfig("nightlight.scheduleEnabled", {
        desc: "Enable automatic night light schedule by time.",
        type: "boolean",
        get: () => NightLight.scheduleEnabled,
        set: v => NightLight.setScheduleEnabled(v as boolean),
        subscribe: (apply) => {
            apply(NightLight.scheduleEnabled)
            return NightLight.subscribe("scheduleEnabled", apply)
        },
        ui: {
            i18n: "settings.appearance.night-light-schedule",
        },
    })

    // ── Notifications ─────────────────────────────────────────────────────
    registerConfig("notifications.popupTimeout", {
        desc: "Seconds a notification popup stays on screen.",
        type: "number",
        min: 2,
        max: 15,
        get: () => notifConfig.popupTimeout,
        set: v => notifConfig.setPopupTimeout(v as number),
        subscribe: (apply) => {
            apply(notifConfig.popupTimeout)
            return notifConfig.subscribe("popupTimeout", apply)
        },
        ui: {
            i18n: "settings.notif.timeout",
            slider: { unit: "s" },
        },
    })
    registerConfig("notifications.doNotDisturb", {
        desc: "Do Not Disturb: suppress notification popups (critical ones still show). Persists across sessions until turned off.",
        type: "boolean",
        get: dontDisturb,
        set: v => setDontDisturb(v as boolean),
        subscribe: (apply) => {
            apply(dontDisturb())
            return notifConfig.subscribe("doNotDisturb", apply)
        },
        ui: {
            i18n: "settings.notif.dnd",
        },
    })

    // ── Accessibility ─────────────────────────────────────────────────────
    registerConfig("accessibility.textScale", {
        desc: "Text scale factor (0.75 to 1.50).",
        type: "number",
        min: TEXT_SCALE_MIN,
        max: TEXT_SCALE_MAX,
        get: () => Theme.textScaling,
        set: v => void Theme.setTextScaling(Number(v)),
        subscribe: onThemeCfg(() => Theme.textScaling),
        ui: {
            i18n: "settings.accessibility.text-scale",
            slider: {
                decimals: 2,
                step: 0.05,
                commitOnRelease: false,
                endpoints: [
                    new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-sm"], valign: Gtk.Align.CENTER }),
                    new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-lg"], valign: Gtk.Align.CENTER }),
                ],
            },
        },
    })
    registerConfig("accessibility.cursorSize", {
        desc: "Cursor size in pixels (16 to 96).",
        type: "number",
        min: 16,
        max: 96,
        get: () => Theme.cursorSize,
        set: v => Theme.setCursorSize(Math.round(Number(v))),
        subscribe: onThemeCfg(() => Theme.cursorSize),
        ui: {
            i18n: "settings.accessibility.cursor-size",
            slider: {
                unit: "px",
                icons: [Icons.mousePointer, Icons.mousePointer],
                commitOnRelease: true,
            },
        },
    })
    registerConfig("accessibility.reduceMotion", {
        desc: "Reduce motion: overlays appear without their pop, dock icons snap instead of springing, and Hyprland's window/workspace animations are switched off.",
        type: "boolean",
        get: () => reduceMotion(),
        set: v => setReduceMotion(v as boolean),
        subscribe: (apply) => {
            apply(reduceMotion())
            return onReduceMotionChange(apply)
        },
        ui: {
            i18n: "settings.accessibility.reduce-motion",
        },
    })

    // ── Power / Idle ──────────────────────────────────────────────────────
    registerConfig("power.screenOff", {
        desc: "Screen off timeout in seconds (0 = never).",
        type: "enum",
        enum: ["0", "120", "300", "600", "1200", "1800"],
        get: () => String(getIdleConfig().screenOff),
        set: v => updateIdleConfig({ screenOff: Number(v) }),
        subscribe: onPowerCfg(() => String(getIdleConfig().screenOff)),
        ui: {
            i18n: "settings.power.screen-off",
            optI18n: powerScreenOffLabel,
        },
    })
    registerConfig("power.lock", {
        desc: "Lock session timeout in seconds (0 = never).",
        type: "enum",
        enum: ["0", "300", "600", "1800", "3600", "7200"],
        get: () => String(getIdleConfig().lock),
        set: v => updateIdleConfig({ lock: Number(v) }),
        subscribe: onPowerCfg(() => String(getIdleConfig().lock)),
        ui: {
            i18n: "settings.power.lock",
            optI18n: powerLockLabel,
        },
    })
    registerConfig("power.suspend", {
        desc: "Suspend system timeout in seconds (0 = never).",
        type: "enum",
        enum: ["0", "900", "1800", "3600", "7200", "10800"],
        get: () => String(getIdleConfig().suspend),
        set: v => updateIdleConfig({ suspend: Number(v) }),
        subscribe: onPowerCfg(() => String(getIdleConfig().suspend)),
        ui: {
            i18n: "settings.power.suspend",
            optI18n: powerSuspendLabel,
        },
    })

    // ── Region ────────────────────────────────────────────────────────────
    registerConfig("region.showSeconds", {
        desc: "Show seconds in the clock display.",
        type: "boolean",
        get: () => regionConfig.showSeconds,
        set: v => regionConfig.setShowSeconds(v as boolean),
        subscribe: (apply) => {
            apply(regionConfig.showSeconds)
            const id = regionConfig.connect("changed", () => apply(regionConfig.showSeconds))
            return () => safeDisconnect(regionConfig, id)
        },
        ui: {
            i18n: "settings.region.time.seconds",
        },
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
    registerConfig("gaming.transition", {
        desc: "Wallpaper transition animation style when launching a game.",
        type: "enum",
        enum: TRANSITIONS,
        get: () => Gaming.transition,
        set: v => Gaming.setTransition(v as TransitionType),
        subscribe: (apply) => {
            apply(Gaming.transition)
            return Gaming.subscribe("transition", apply)
        },
        ui: {
            i18n: "settings.gaming.transition",
            optI18n: k => TRANSITION_LABELS[k as TransitionType] ?? k,
        },
    })
    registerConfig("gaming.performanceProfile", {
        desc: "Switch the power profile to performance while a game runs.",
        type: "boolean",
        get: () => Gaming.performanceProfile,
        set: v => Gaming.setPerformanceProfile(v as boolean),
        subscribe: (apply) => {
            apply(Gaming.performanceProfile)
            return Gaming.subscribe("performanceProfile", apply)
        },
        ui: {
            i18n: "settings.gaming.performance-profile",
        },
    })
    // Mode selector — the shared segmented control. It used to be a hand-rolled
    // group of Gtk.ToggleButtons, and a ToggleButton that is already active turns
    // OFF when clicked: the handler bailed on `!btn.active`, so clicking the
    // selected mode left the control showing NOTHING selected while that mode was
    // still in force. `segmentedGroup` has no empty state to fall into.
    registerConfig("gaming.wallpaperMode", {
        desc: "Wallpaper while gaming: Steam hero artwork, a custom image, or unchanged.",
        type: "enum",
        enum: WALLPAPER_MODES,
        get: () => Gaming.wallpaperMode,
        set: v => Gaming.setWallpaperMode(v as WallpaperMode),
        subscribe: (apply) => {
            apply(Gaming.wallpaperMode)
            return Gaming.subscribe("wallpaperMode", apply)
        },
        ui: {
            i18n: "settings.gaming.wallpaper-mode",
            control: "segmented",
            optI18n: (v: string) => t(`settings.gaming.mode.${v}` as any),
        },
    })

    // ── AI governance ─────────────────────────────────────────────────────
    // Visible so agents can SEE the gate, but not writable through the gate it
    // controls — flipping it is reserved to the Settings → AI page.
    registerConfig("ai.allowConfigWrite", {
        desc: "Whether agents may change settings via setConfig. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowConfigWrite,
        set: v => agentConfig.setAllowConfigWrite(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowConfigWrite),
        ui: {
            i18n: "settings.ai.allow-config-write",
        },
    })
    registerConfig("ai.allowScreenshot", {
        desc: "Whether agents may capture the screen via the screenshot IPC. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowScreenshot,
        set: v => agentConfig.setAllowScreenshot(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowScreenshot),
        ui: {
            i18n: "settings.ai.allow-screenshot",
        },
    })
    registerConfig("ai.allowWindowClose", {
        desc: "Whether agents may close windows via the closeWindow IPC. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowWindowClose,
        set: v => agentConfig.setAllowWindowClose(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowWindowClose),
        ui: {
            i18n: "settings.ai.allow-window-close",
        },
    })
    registerConfig("ai.allowMcp", {
        desc: "Whether nidara-mcp serves tools to MCP clients. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowMcp,
        set: v => agentConfig.setAllowMcp(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowMcp),
        ui: {
            i18n: "settings.ai.allow-mcp",
        },
    })
    registerConfig("ai.allowComputerUse", {
        desc: "Whether agents may PERCEIVE other apps via the accessibility tree (nidara-a11y, query_app). Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowComputerUse,
        set: v => agentConfig.setAllowComputerUse(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowComputerUse),
        ui: {
            i18n: "settings.ai.allow-computer-use",
        },
    })
    registerConfig("ai.allowComputerControl", {
        desc: "Whether agents may ACT in other apps — accessibility actions, synthetic keyboard and pointer (nidara-act/type/click). Implies allowComputerUse. Toggle it in Settings → AI, or revoke it instantly with the kill switch (disableComputerControl).",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowComputerControl,
        set: v => agentConfig.setAllowComputerControl(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowComputerControl),
        ui: {
            i18n: "settings.ai.allow-computer-control",
        },
    })
    registerConfig("ai.allowFileRead", {
        desc: "Whether the built-in Assistant may READ Nidara's own config, the shipped assets and the shell log (read_file/list_dir/search_files, prefix-limited). Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowFileRead,
        set: v => agentConfig.setAllowFileRead(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowFileRead),
        ui: {
            i18n: "settings.ai.allow-file-read",
        },
    })
    registerConfig("ai.allowFileWrite", {
        desc: "Whether the built-in Assistant may WRITE the three user-owned config files it is allowed to edit (edit_file/write_file, exact allowlist, every write committed to git). Implies allowFileRead. Toggle it in Settings → AI.",
        type: "boolean",
        writable: false,
        get: () => agentConfig.allowFileWrite,
        set: v => agentConfig.setAllowFileWrite(v as boolean),
        subscribe: onAiCfg(() => agentConfig.allowFileWrite),
        ui: {
            i18n: "settings.ai.allow-file-write",
        },
    })
    registerConfig("ai.assistantGlow", {
        desc: "Glow the border of the window the built-in Assistant is working in, for as long as a turn runs. Requires Hyprland 0.56+; makes Nidara the owner of decoration:glow.",
        type: "boolean",
        writable: true,
        get: () => agentConfig.assistantGlow,
        set: v => agentConfig.setAssistantGlow(v as boolean),
        subscribe: onAiCfg(() => agentConfig.assistantGlow),
        ui: {
            i18n: "settings.ai.assistant-glow",
        },
    })
    registerConfig("ai.brainProvider", {
        desc: "Which provider the built-in Assistant talks to: '' (off) or a provider id (anthropic, openai, google, mistral, groq, openrouter, ollama, custom). Set it in Settings → AI.",
        type: "enum",
        enum: ["", ...AGENT_PROVIDERS.map(p => p.id)],
        writable: false,
        get: () => agentConfig.brainProvider,
        set: v => agentConfig.setBrainProvider(v as string),
        subscribe: onAiCfg(() => agentConfig.brainProvider),
        ui: {
            i18n: "settings.ai.brain.provider",
            optI18n: brainProviderLabel,
        },
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
