import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import { AtomicWidget, WidgetSize } from "./Types"
import { t } from "../../core/i18n"
import Gio from "gi://Gio"
import Icons from "../../core/Icons"

function setIcon(img: Gtk.Image, icon: Gio.FileIcon) {
    img.gicon = icon
}

// Shared capsule layout: icon circle + title/subtitle text stack
type SubscribeFn = (sync: () => void) => () => void

function buildCapsuleContent(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
    onClick: () => void,
    getActive?: () => boolean,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
        margin_start: 4,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon"] })
    setIcon(icon, getIcon())
    iconBox.append(icon)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    const label = new Gtk.Label({ label: getTitle(), css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })
    const subLabel = new Gtk.Label({ label: getSubTitle(), css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14 })

    textStack.append(label)
    textStack.append(subLabel)
    box.append(iconBox)
    box.append(textStack)
    btn.set_child(box)

    const update = () => {
        setIcon(icon, getIcon())
        label.label = getTitle()
        const sub = getSubTitle()
        subLabel.label = sub
        subLabel.visible = sub.length > 0
        if (getActive) {
            if (getActive()) btn.add_css_class("active")
            else btn.remove_css_class("active")
        }
    }

    btn.connect("clicked", () => { onClick(); update() })
    if (subscribe) {
        const cleanup = subscribe(update)
        btn.connect("unrealize", cleanup)
    }
    update()
    return btn
}

// Single (1×1) round button
function buildRoundContent(
    getIcon: () => Gio.FileIcon,
    getActive: () => boolean,
    onClick: () => void,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const syncClasses = () => {
        btn.set_css_classes(getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"])
        setIcon(icon, getIcon())
    }
    const btn = new Gtk.Button({
        css_classes: getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ pixel_size: 28, css_classes: ["cs-icon"] })
    setIcon(icon, getIcon())
    btn.set_child(icon)
    btn.connect("clicked", () => { onClick(); syncClasses() })
    if (subscribe) {
        const cleanup = subscribe(syncClasses)
        btn.connect("unrealize", cleanup)
    }
    return btn
}

export function EthernetWidget(): AtomicWidget {
    const network = AstalNetwork.get_default()
    const wired   = network?.wired

    const getIcon   = () => Icons.ethernet
    const getActive = () => !!(wired && (wired as any).internet === (AstalNetwork as any).Internet?.CONNECTED)
    const getSub = () => {
        if (!wired) return t("cc.ethernet.sub.no-cable")
        const connected = (wired as any).internet === (AstalNetwork as any).Internet?.CONNECTED
        if (!connected) return t("cc.ethernet.sub.disconnected")
        return (wired as any).device?.interface || t("cc.ethernet.sub.connected")
    }
    const subscribe: SubscribeFn = (sync) => {
        if (!wired) return () => {}
        const ids = [
            (wired as any).connect("notify::internet",    sync),
            (wired as any).connect("notify::ip4-address", sync),
        ]
        return () => ids.forEach(id => { try { (wired as any).disconnect(id) } catch {} })
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, () => {}, subscribe)
        return buildCapsuleContent(getIcon, () => t("cc.ethernet.name"), getSub, () => {}, getActive, subscribe)
    }

    return { id: "ethernet", name: t("cc.ethernet.name"), defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE], buildContent }
}

export function WifiWidget(): AtomicWidget {
    const wifi   = AstalNetwork.get_default()?.wifi
    const toggle = () => execAsync(["bash", "-c",
        "nmcli radio wifi | grep -q enabled && nmcli radio wifi off || nmcli radio wifi on"
    ]).catch(() => {})

    const getIcon   = () => (wifi as any)?.enabled === false ? Icons.wifiOff : Icons.wifi
    const getActive = () => !!((wifi as any)?.enabled !== false && (wifi as any)?.ssid)
    const getSub    = () => {
        if (!wifi) return t("cc.wifi.sub.off")
        return (wifi as any).ssid || ((wifi as any).enabled === false ? t("cc.wifi.sub.off") : t("cc.wifi.sub.connected"))
    }
    const subscribe: SubscribeFn = (sync) => {
        if (!wifi) return () => {}
        const id = (wifi as any).connect("notify", sync)
        return () => { try { (wifi as any).disconnect(id) } catch {} }
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, toggle, subscribe)
        return buildCapsuleContent(getIcon, () => t("cc.wifi.name"), getSub, toggle, getActive, subscribe)
    }

    return { id: "wifi", name: t("cc.wifi.name"), defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE], buildContent }
}

export function FocusWidget(): AtomicWidget {
    const notifd  = AstalNotifd.get_default()
    const toggle  = () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb }
    const getIcon = () => notifd?.dont_disturb ? Icons.bellOff : Icons.bell
    const getActive = () => !!notifd?.dont_disturb
    const subscribe: SubscribeFn = (sync) => {
        if (!notifd) return () => {}
        const id = (notifd as any).connect("notify", sync)
        return () => { try { (notifd as any).disconnect(id) } catch {} }
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, toggle, subscribe)
        return buildCapsuleContent(
            getIcon,
            () => notifd?.dont_disturb ? t("cc.focus.title.on") : t("cc.focus.title.off"),
            () => notifd?.dont_disturb ? t("cc.focus.sub.on") : "",
            toggle, getActive, subscribe,
        )
    }

    return { id: "focus", name: t("cc.focus.name"), defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE], buildContent }
}

export function RoundToggle(
    id: string,
    name: string,
    iconName: Gio.FileIcon | (() => Gio.FileIcon),
    active: boolean | (() => boolean),
    onClick: () => void,
    wideSubtitle?: () => string,
    subscribe?: SubscribeFn,
): AtomicWidget {
    const getActive = typeof active === "function" ? active : () => active
    const getIcon   = typeof iconName === "function" ? iconName : () => iconName
    const getSub    = wideSubtitle ?? (() => "")

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, onClick, subscribe)
        return buildCapsuleContent(getIcon, () => name, getSub, onClick, getActive, subscribe)
    }

    return {
        id, name,
        defaultSize: WidgetSize.SINGLE,
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
        buildContent,
    }
}
