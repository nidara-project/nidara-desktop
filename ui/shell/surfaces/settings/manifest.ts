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
    reaches?: readonly string[]      // claves de ajuste que el grupo `custom` dibuja en una SUBPÁGINA
                                     // («Configurar»): cuentan como declaradas aquí, se ubican en esta
                                     // página y entran en la búsqueda, que no recorre subpáginas
}

export type PageKind = "preference" | "browser" | "info"

export interface PageDecl {
    id: string
    kind: PageKind
    label: string                 // clave i18n del título
    icon?: IconName               // el NOMBRE estándar, no el icono: el manifiesto sigue sin `gi://`
    groupStart?: boolean          // divisor de la barra lateral
    parent?: string               // subpágina: no va en la barra lateral
    subtitle?: string             // subpágina: la segunda línea de la fila con que su padre la lista
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
        icon: "nd-preferences-system-network",
        builder: "network",
        reason: "Object browser for physical network interfaces, Wi-Fi access points, and VPN connections.",
    },
    {
        id: "bluetooth",
        kind: "browser",
        label: "settings.bluetooth.title",
        icon: "nd-bluetooth-active",
        builder: "bluetooth",
        reason: "Object browser for dynamic Bluetooth adapter state and device discovery/pairing lifecycles.",
    },
    // ── Look, shell & behaviour ─────────────────────────────────────────────
    {
        id: "appearance",
        kind: "preference",
        label: "settings.appearance.title",
        icon: "nd-preferences-desktop-theme",
        groupStart: true,
        groups: [
            {
                i18n: "settings.appearance.group.base-style",
                items: [
                    "appearance.darkMode",
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
                        key: "appearance.glassMaterial",
                        note: "Glass model (#674): ONE choice of three — clear / regular / frosted — each a table of per-surface floors plus the compositor blur (GLASS_FLOORS / GLASS_BLUR in the kit). It replaced a master opacity slider and four per-surface sliders under 'Advanced'. Greyed out while Accessibility → Reduce transparency is on, which makes every surface solid.",
                        sensitiveWhen: { key: "accessibility.reduceTransparency", in: ["false"] },
                    },
                ],
            },
            {
                i18n: "settings.appearance.group.windows",
                items: [
                    {
                        key: "appearance.windowTransparency",
                        note: "Windows are NOT part of the glass material (owner, 2026-09-30): the material above is for the interface's surfaces; Nidara's windows are only translucent or solid. Named transparency, not 'tinting': the blur behind them is Hyprland's one blur, which the material sets, so a tint of our own cannot be promised. On = WINDOW_GLASS_OPACITY, off = solid.",
                        sensitiveWhen: { key: "accessibility.reduceTransparency", in: ["false"] },
                    },
                    {
                        key: "appearance.windowBlur",
                        note: "The blur behind EVERY translucent window, ours and other apps' (#708 point 1, 'A, automatic'): the window material, on a switch of its own, apart from the glass material (owner's condition: windows and layers independent). Only where the compositor has the switch (Hyalo, `caps.windowBackdrop`): its entry's `available` hides the row elsewhere.",
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
                    "appearance.interfaceIconTheme",
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
        icon: "nd-video-display",
        builder: "display",
        reason: "Object browser for dynamically connected physical monitors, layouts, and mode enumeration.",
    },
    {
        id: "audio",
        kind: "browser",
        label: "settings.audio.title",
        icon: "nd-audio-speakers",
        builder: "audio",
        reason: "Object browser for dynamic PipeWire audio endpoints and per-application volume streams.",
    },
    {
        id: "bar",
        kind: "preference",
        label: "settings.bar.title",
        icon: "nd-bar",
        groups: [
            // One list of what the bar holds, right to left (custom/bar.ts, 2026-09-27): checks, "Always / When active", the window title
            // and the system menu's icon all in the same row format — then the apps' icons.
            // The order itself is edited in the bar (Status.bar_edit_mode), not here.
            // `reaches`: the clock's Configure subpage (custom/clock.ts). A subpage is not
            // indexed, so a search for "date format" lands here, on the row that opens it.
            {
                i18n: "settings.bar.group.items", custom: "barItems",
                reaches: ["region.timeFormat", "region.dateFormat", "region.showSeconds"],
            },
            { i18n: "settings.bar.group.apps", custom: "barApps" },
        ],
    },
    {
        id: "dock",
        kind: "preference",
        label: "settings.dock.title",
        icon: "nd-dock",
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
        id: "desktop",
        kind: "preference",
        label: "settings.desktop.title",
        icon: "nd-window-floating",
        groups: [
            {
                i18n: "settings.desktop.group.default",
                items: [
                    "workspaces.defaultMode",
                ],
            },
            {
                i18n: "settings.desktop.group.workspaces",
                items: [
                    "workspaces.workspace1Mode",
                    "workspaces.workspace2Mode",
                    "workspaces.workspace3Mode",
                    "workspaces.workspace4Mode",
                    "workspaces.workspace5Mode",
                ],
            },
        ],
    },
    {
        id: "widgets",
        kind: "browser",
        label: "settings.widgets.title",
        icon: "nd-preferences-system",
        builder: "widgets",
        reason: "Object browser for dynamic widget registry placement (bar vs control center) and subpage settings.",
    },
    {
        id: "gaming",
        kind: "preference",
        label: "settings.gaming.title",
        icon: "nd-input-gaming",
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
                ],
            },
            {
                i18n: "settings.gaming.group.performance",
                items: [
                    "gaming.performanceProfile",
                ],
            },
            {
                i18n: "settings.gaming.group.notifications",
                items: [
                    "gaming.silenceNotifications",
                ],
            },
        ],
    },
    {
        id: "notifications",
        kind: "preference",
        label: "settings.notif.title",
        icon: "nd-preferences-system-notifications",
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
        icon: "nd-preferences-desktop-accessibility",
        groups: [
            {
                i18n: "settings.accessibility.group.vision",
                items: [
                    "accessibility.textScale",
                    "accessibility.cursorSize",
                    "accessibility.reduceTransparency",
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
        icon: "nd-view-grid",
        builder: "apps",
        reason: "Navigation hub for app management subpages (default apps, icon associations, autostart).",
    },
    // ── System & devices ────────────────────────────────────────────────────
    {
        id: "input",
        kind: "preference",
        label: "settings.input.title",
        icon: "nd-input-keyboard",
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
        icon: "nd-battery",
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
        icon: "nd-preferences-system-time",
        groups: [
            // Language, region and formats. Everything about how the clock reads (24/12
            // hours, the date, seconds) is Top bar → Clock → Configure (owner, 2026-09-29).
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
        icon: "nd-avatar-default",
        builder: "users",
        reason: "Object browser for system user accounts via AccountsService D-Bus and administration actions.",
    },
    {
        id: "ai",
        kind: "preference",
        label: "settings.ai.title",
        icon: "nd-ai",
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
        icon: "nd-dialog-information",
        builder: "about",
        reason: "System diagnostics and hardware information display with live updates trigger.",
    },
    // ── Subpáginas de Aplicaciones ───────────────────────────────────────────
    // No están en la barra lateral: `Apps.tsx` las empuja con `nav.pushSubpage`, y
    // ahora las LISTA desde aquí — id, título y subtítulo salen de esta declaración,
    // así que dejan de estar escritos dos veces. Su contenido sigue SIN indexarse en
    // la búsqueda a propósito (se reconstruyen en cada visita); lo que se indexa son
    // las tres filas del hub, que es donde una búsqueda de «autostart» aterriza.
    {
        id: "apps/default",
        kind: "browser",
        parent: "apps",
        label: "settings.defaultapps.title",
        subtitle: "settings.defaultapps.subtitle",
        builder: "defaultApps",
        reason: "Object browser for the installed applications that can claim each default handler.",
    },
    {
        id: "apps/icons",
        kind: "browser",
        parent: "apps",
        label: "settings.apps.title",
        subtitle: "settings.apps.subtitle",
        builder: "appIcons",
        reason: "Object browser for every installed application, each drilling into its own icon override.",
    },
    {
        id: "apps/autostart",
        kind: "browser",
        parent: "apps",
        label: "settings.autostart.title",
        subtitle: "settings.autostart.subtitle",
        builder: "autostart",
        reason: "Object browser for the user's autostart entries, which are files on disk rather than settings.",
    },
] as const satisfies readonly PageDecl[]

export default manifest
