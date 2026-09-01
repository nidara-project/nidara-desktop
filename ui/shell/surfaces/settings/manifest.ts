// Pure data manifest of settings pages, groups and declared items.
// ⚠️ NO imports from "gi://", and all type imports must use `import type`.
// This allows CI to directly import this file via node --experimental-strip-types.

export type ItemDecl = string

export interface FooterWhenDecl {
    key: string
    in: string[]
}

export interface GroupDecl {
    i18n?: string
    footer?: string
    footerWhen?: FooterWhenDecl
    items: ItemDecl[]
}

export interface PageDecl {
    id: string
    groups: GroupDecl[]
}

export const manifest: PageDecl[] = [
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
]

export default manifest
