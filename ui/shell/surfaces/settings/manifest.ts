// Pure data manifest of settings pages, groups and declared items.
// ⚠️ NO imports from "gi://", and all type imports must use `import type`.
// This allows CI to directly import this file via node --experimental-strip-types.

export type ItemDecl =
    | string                                   // clave registrada → settingRow(clave)
    | { custom: string; i18n: string; key?: string; note?: string; visibleWhen?: WhenDecl }
    | { decoration: string; note?: string; visibleWhen?: WhenDecl }

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

export interface PageDecl {
    id: string
    note?: string
    header?: { custom: string; note?: string }   // widget antes del primer grupo (Region)
    groups: readonly GroupDecl[]
}

export const manifest = [
    {
        id: "accessibility",
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
        id: "notifications",
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
        id: "input",
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
        id: "dock",
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
        id: "bar",
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
        id: "gaming",
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
        id: "power",
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
] as const satisfies readonly PageDecl[]

export default manifest
