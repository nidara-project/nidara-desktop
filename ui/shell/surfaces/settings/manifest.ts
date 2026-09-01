// Pure data manifest of settings pages, groups and declared items.
// ⚠️ NO imports from "gi://", and all type imports must use `import type`.
// This allows CI to directly import this file via node --experimental-strip-types.

import type { IconName } from "../../core/Icons"

export type ItemDecl =
    | string                                   // clave registrada → settingRow(clave)
    | { key: string; note?: string; visibleWhen?: WhenDecl; sensitiveWhen?: WhenDecl }
    | { custom: string; i18n: string; key?: string; note?: string; visibleWhen?: WhenDecl; sensitiveWhen?: WhenDecl }
    | { decoration: string; note?: string; visibleWhen?: WhenDecl; sensitiveWhen?: WhenDecl }
    | { disclosure: string; note?: string; items: readonly ItemDecl[] }

export interface WhenDecl {
    key: string
    in: readonly string[]
}

export type FooterWhenDecl = WhenDecl

export interface GroupDecl {
    i18n?: string
    note?: string
    footer?: string
    footerWhen?: WhenDecl
    items?: readonly ItemDecl[]      // exclusivo con `custom`
    custom?: string                  // el CUERPO del grupo lo construye un builder (Power)
}

export type PageKind = "preference" | "browser" | "info"

export interface PageDecl {
    id: string
    kind: PageKind
    label: string                 // clave i18n del título
    icon?: IconName               // nombre, no el icono: el manifiesto sigue sin `gi://`
    groupStart?: boolean          // divisor de la barra lateral
    parent?: string               // subpágina: no va en la barra lateral
    builder?: string              // browser/info: nombre del constructor
    reason?: string               // browser/info: POR QUÉ no es declarable. Obligatorio.
    note?: string
    header?: { custom: string; note?: string }   // widget antes del primer grupo (Region)
    groups?: readonly GroupDecl[] // preference
}

export const manifest = [
    // ── Connectivity ────────────────────────────────────────────────────────
    {
        id: "network",
        kind: "browser",
        label: "settings.network.title",
        icon: "globe",
        builder: "network",
        reason: "Object browser for physical network interfaces, Wi-Fi access points, and VPN connections.",
    },
    {
        id: "bluetooth",
        kind: "browser",
        label: "settings.bluetooth.title",
        icon: "bluetooth",
        builder: "bluetooth",
        reason: "Object browser for dynamic Bluetooth adapter state and device discovery/pairing lifecycles.",
    },
    // ── Look, shell & behaviour ─────────────────────────────────────────────
    {
        id: "appearance",
        kind: "preference",
        label: "settings.appearance.title",
        icon: "palette",
        groupStart: true,
        groups: [
            {
                i18n: "settings.appearance.group.base-style",
                items: [
                    "appearance.darkMode",
                    "appearance.shellAppearance",
                ],
            },
            {
                i18n: "settings.appearance.group.wallpaper",
                items: [
                    { decoration: "wallpaperPreview" },
                    {
                        decoration: "wallpaperGallery",
                        note: "Bundled wallpapers gallery. Only rendered if getBundledWallpapers() returns items; when empty, row is hidden (visible = false). Wallpaper.connect('changed') subscription is unconditional outside this check.",
                    },
                    "wallpaper.transition",
                    { custom: "wallpaperPicker", i18n: "settings.appearance.image" },
                ],
            },
            {
                i18n: "settings.appearance.group.theme",
                items: [
                    { custom: "accentPicker", i18n: "settings.appearance.accent", key: "appearance.accent" },
                    {
                        custom: "glassMaster",
                        i18n: "settings.appearance.glass",
                        note: "Opacity model: ONE master 'Glass' slider governs bar + overlays + dock + window together; an 'Advanced' disclosure breaks them apart. All are plain opacities over ONE GLASS_RANGE, imported rather than retyped — the bounds used to be five literals here plus a sixth in clampOpacity, which is five chances to offer a value the clamp refuses.",
                    },
                    {
                        disclosure: "settings.appearance.advanced",
                        note: "Advanced — per-surface glass opacities. Header row toggles a Gtk.Revealer with the 4 surface opacity sliders.",
                        items: [
                            "appearance.barOpacity",
                            "appearance.overlayOpacity",
                            "appearance.dockOpacity",
                            "appearance.windowOpacity",
                        ],
                    },
                ],
            },
            {
                i18n: "settings.appearance.group.night-light",
                items: [
                    {
                        key: "nightlight.enabled",
                        sensitiveWhen: { key: "nightlight.scheduleEnabled", in: ["false"] },
                    },
                    "nightlight.temperature",
                    "nightlight.scheduleEnabled",
                    {
                        decoration: "nightScheduleTimes",
                        visibleWhen: { key: "nightlight.scheduleEnabled", in: ["true"] },
                    },
                ],
            },
            {
                i18n: "settings.appearance.group.resources",
                items: [
                    "appearance.gtkTheme",
                    "appearance.iconTheme",
                    "appearance.cursorTheme",
                ],
            },
            {
                i18n: "settings.appearance.group.fonts",
                items: [
                    { custom: "interfaceFont", i18n: "settings.appearance.interface-font" },
                    { custom: "monoFont", i18n: "settings.appearance.mono-font" },
                ],
            },
        ],
    },
    {
        id: "display",
        kind: "browser",
        label: "settings.display.title",
        icon: "monitor",
        builder: "display",
        reason: "Object browser for dynamically connected physical monitors, layouts, and mode enumeration.",
    },
    {
        id: "audio",
        kind: "browser",
        label: "settings.audio.title",
        icon: "speaker",
        builder: "audio",
        reason: "Object browser for dynamic PipeWire audio endpoints and per-application volume streams.",
    },
    {
        id: "bar",
        kind: "preference",
        label: "settings.bar.title",
        icon: "panelTop",
        groups: [
            {
                i18n: "settings.bar.group.layout",
                // The only layout toggle left, and the only one of the original three that
                // was ever a preference rather than a footgun: the system-menu capsule and
                // the Activity Island are both permanent now, each because hiding it removed
                // the sole route to a capability. Reasoning lives in `bar/barState.ts`.
                note: "The only layout toggle left, and the only one of the original three that was ever a preference rather than a footgun: the system-menu capsule and the Activity Island are both permanent now, each because hiding it removed the sole route to a capability. Reasoning lives in bar/barState.ts.",
                items: [
                    "bar.appTitle",
                ],
            },
            {
                i18n: "settings.bar.group.icon",
                items: [
                    {
                        custom: "launcherIcon",
                        i18n: "settings.bar.icon-custom",
                        // A launcherIcon is 'custom' only when it points at an image file that
                        // still exists. A preset key ('nidara') — or a stale value from before the
                        // rebrand ('arch') — is treated as the default: the bar falls back to the
                        // built-in mark, so the page must show the same, not the raw string.
                        note: "A launcherIcon is 'custom' only when it points at an image file that still exists. A preset key ('nidara') — or a stale value from before the rebrand ('arch') — is treated as the default: the bar falls back to the built-in mark, so the page must show the same, not the raw string.",
                    },
                ],
            },
        ],
    },
    {
        id: "dock",
        kind: "preference",
        label: "settings.dock.title",
        icon: "dock",
        groups: [
            {
                i18n: "settings.dock.group.position",
                footer: "settings.dock.side-autohide-note",
                footerWhen: { key: "dock.position", in: ["left", "right"] },
                items: [
                    "dock.position",
                ],
            },
            {
                i18n: "settings.dock.group.geometry",
                items: [
                    "dock.iconSize",
                    "dock.screenGap",
                ],
            },
            {
                i18n: "settings.dock.group.effects",
                items: [
                    "dock.magnification",
                    "dock.maxIconSize",
                ],
            },
            {
                i18n: "settings.dock.group.behavior",
                items: [
                    "dock.indicators",
                    "dock.autoHide",
                    "dock.hideDelay",
                ],
            },
        ],
    },
    {
        id: "widgets",
        kind: "browser",
        label: "settings.widgets.title",
        icon: "settings2",
        builder: "widgets",
        reason: "Object browser for dynamic widget registry placement (bar vs control center) and subpage settings.",
    },
    {
        id: "gaming",
        kind: "preference",
        label: "settings.gaming.title",
        icon: "gamepad",
        groups: [
            {
                i18n: "settings.gaming.group.wallpaper",
                items: [
                    "gaming.wallpaperMode",
                    {
                        decoration: "customWallpaperPreview",
                        visibleWhen: { key: "gaming.wallpaperMode", in: ["custom"] },
                    },
                    {
                        custom: "customWallpaperPicker",
                        i18n: "settings.gaming.custom-wallpaper",
                        visibleWhen: { key: "gaming.wallpaperMode", in: ["custom"] },
                    },
                    "gaming.transition",
                ],
            },
            {
                i18n: "settings.gaming.group.performance",
                items: [
                    "gaming.performanceProfile",
                ],
            },
        ],
    },
    {
        id: "notifications",
        kind: "preference",
        label: "settings.notif.title",
        icon: "bell",
        groups: [
            {
                i18n: "",
                note: "Headerless group, first on the page: this is the same bit the Control Center's focus tile flips. Popup behaviour follows below.",
                items: [
                    "notifications.doNotDisturb",
                ],
            },
            {
                i18n: "settings.notif.group.popups",
                items: [
                    "notifications.popupTimeout",
                ],
            },
        ],
    },
    {
        id: "accessibility",
        kind: "preference",
        label: "settings.accessibility.title",
        icon: "accessibility",
        groups: [
            {
                i18n: "settings.accessibility.group.vision",
                items: [
                    "accessibility.textScale",
                    "accessibility.cursorSize",
                ],
            },
            {
                i18n: "settings.accessibility.group.motion",
                items: [
                    "accessibility.reduceMotion",
                ],
            },
        ],
    },
    {
        id: "apps",
        kind: "browser",
        label: "settings.apps.section",
        icon: "grid",
        builder: "apps",
        reason: "Navigation hub for app management subpages (default apps, icon associations, autostart).",
    },
    // ── System & devices ────────────────────────────────────────────────────
    {
        id: "input",
        kind: "preference",
        label: "settings.input.title",
        icon: "keyboard",
        groupStart: true,
        groups: [
            {
                i18n: "settings.input.mouse.group",
                items: [
                    "input.mouse.speed",
                    "input.mouse.accel",
                    "input.mouse.natural",
                ],
            },
            {
                i18n: "settings.input.touchpad.group",
                items: [
                    "input.touchpad.natural",
                    "input.touchpad.tap",
                ],
            },
            {
                i18n: "settings.input.keyboard.group",
                items: [
                    "input.keyboard.layout",
                    "input.keyboard.numlock",
                    "input.keyboard.repeatDelay",
                    "input.keyboard.repeatRate",
                ],
            },
        ],
    },
    {
        id: "power",
        kind: "preference",
        label: "settings.power.title",
        icon: "battery",
        groups: [
            {
                i18n: "settings.power.group.profile",
                // The profile group is an entire custom group: selection_mode = SINGLE,
                // rows use NidaraRow directly and are NOT indexed in search, and updates
                // follow onPageShown with a syncing flag to avoid spurious daemon writes.
                note: "The profile group is an entire custom group: selection_mode = SINGLE, rows use NidaraRow directly and are NOT indexed in search, and updates follow onPageShown with a syncing flag to avoid spurious daemon writes.",
                custom: "performanceProfiles",
            },
            {
                i18n: "settings.power.group.idle",
                footer: "settings.power.lock-note",
                items: [
                    "power.screenOff",
                    "power.lock",
                    "power.suspend",
                ],
            },
        ],
    },
    {
        id: "region",
        kind: "preference",
        label: "settings.region.title",
        icon: "clock",
        header: {
            custom: "clockPreview",
            note: "Live clock preview before the first group. 1s tick armed in bindWhileRealized on pageBox.",
        },
        groups: [
            {
                i18n: "settings.region.time.group",
                items: [
                    { custom: "timeFormat", i18n: "settings.region.time.format" },
                    "region.showSeconds",
                ],
            },
            {
                i18n: "settings.region.date.group",
                items: [
                    { custom: "dateFormat", i18n: "settings.region.date.format" },
                ],
            },
            {
                i18n: "settings.region.tz.group",
                items: [
                    { custom: "timezoneActive", i18n: "settings.region.tz.active" },
                    { custom: "timezoneChange", i18n: "settings.region.tz.change" },
                ],
            },
            {
                i18n: "settings.region.locale.group",
                // ⚠️ This group holds TWO DIFFERENT SCOPES, which is why its title is neutral
                // ("Language & formats") and each row states its own reach in the subtitle:
                // Language writes /etc/locale.conf (system-wide), Regional format writes
                // ~/.config/environment.d/nidara-locale.conf (THIS user only, re-read by the
                // systemd user manager at each login). A group title that named either scope
                // would be a lie about the other row.
                //
                // 🔑 "System-wide" deliberately does NOT promise the login screen. The greeter
                // has its OWN language picker (ui/greeter/widget/LocaleBar.ts -> greeter-prefs.json),
                // and detectLocale() in ui/greeter/lib/i18n.ts reads that FIRST.
                note: "This group holds TWO DIFFERENT SCOPES: Language writes /etc/locale.conf (system-wide), Regional format writes ~/.config/environment.d/nidara-locale.conf (user only). Greeter has its own picker; /etc/locale.conf is only its fallback.",
                items: [
                    { custom: "systemLanguage", i18n: "settings.region.locale.lang" },
                    { custom: "regionalFormat", i18n: "settings.region.locale.regional" },
                ],
            },
        ],
    },
    {
        id: "users",
        kind: "browser",
        label: "settings.users.title",
        icon: "userRound",
        builder: "users",
        reason: "Object browser for system user accounts via AccountsService D-Bus and administration actions.",
    },
    {
        id: "ai",
        kind: "preference",
        label: "settings.ai.title",
        icon: "sparkles",
        groups: [
            {
                i18n: "settings.ai.brain.group",
                footer: "settings.ai.brain.group.scope",
                note: "Assistant — the built-in conversational agent's brain (BYOK). Order of groups follows risk escalation (desktop, files, other apps). Footers name the audience/scope.",
                items: [
                    "ai.brainProvider",
                    {
                        custom: "brainModel",
                        i18n: "settings.ai.brain.model",
                        key: "ai.brainModel",
                        note: "Model row: free text + an optional catalog fetched from the provider. The entry stays the source of truth; dropdown fills it. Index 0 is a placeholder that rests on choose-model.",
                    },
                    {
                        custom: "brainEndpoint",
                        i18n: "settings.ai.brain.endpoint",
                        note: "Custom endpoint entry for providers with editableEndpoint. Visibility is controlled dynamically in builder by provider capabilities.",
                    },
                    {
                        custom: "apiKey",
                        i18n: "settings.ai.brain.key",
                        note: "API key stored in DE keyring (libsecret) keyed by provider. Writes are async so password dialog doesn't freeze the GTK main loop. Status reported in UI.",
                    },
                ],
            },
            {
                i18n: "settings.ai.group.signal",
                footer: "settings.ai.group.signal.scope",
                note: "While it works — the signal, not a permission. Reaches outside the shell (Hyprland decoration:glow).",
                items: [
                    "ai.assistantGlow",
                ],
            },
            {
                i18n: "settings.ai.group.access",
                footer: "settings.ai.group.access.scope",
                items: [
                    "ai.allowConfigWrite",
                    "ai.allowScreenshot",
                    "ai.allowWindowClose",
                ],
            },
            {
                i18n: "settings.ai.group.files",
                footer: "settings.ai.group.files.scope",
                note: "Daemon-local (bin/nidara-agent), not an IPC action: external MCP clients bring their own file tools.",
                items: [
                    "ai.allowFileRead",
                    "ai.allowFileWrite",
                ],
            },
            {
                i18n: "settings.ai.group.other-apps",
                footer: "settings.ai.group.other-apps.scope",
                note: "Other apps — the computer-use layer (reaches OUTSIDE the shell).",
                items: [
                    "ai.allowComputerUse",
                    "ai.allowComputerControl",
                ],
            },
            {
                i18n: "settings.ai.group.mcp",
                footer: "settings.ai.group.mcp.scope",
                items: [
                    "ai.allowMcp",
                    { custom: "mcpConnectPath", i18n: "settings.ai.connect-agent" },
                ],
            },
            {
                i18n: "settings.ai.group.surface",
                items: [
                    { custom: "exposedSettings", i18n: "settings.ai.exposed-settings" },
                    {
                        custom: "stateRead",
                        i18n: "settings.ai.state-read",
                        note: "The value is 'always', and it has to be said. Read-only fact about the agent surface.",
                    },
                ],
            },
        ],
    },
    {
        id: "about",
        kind: "info",
        label: "settings.about.title",
        icon: "info",
        builder: "about",
        reason: "System diagnostics and hardware information display with live updates trigger.",
    },
] as const satisfies readonly PageDecl[]

export default manifest
