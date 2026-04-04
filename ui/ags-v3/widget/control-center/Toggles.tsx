import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import { AtomicWidget, WidgetSize } from "./Types"

// Shared capsule layout: icon circle + title/subtitle text stack
function buildCapsuleContent(
    getIcon: () => string,
    getTitle: () => string,
    getSubTitle: () => string,
    onClick: () => void,
    getActive?: () => boolean,
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
    const icon = new Gtk.Image({ icon_name: getIcon(), pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true })
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
        icon.icon_name = getIcon()
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
    update()
    return btn
}

// Single (1×1) round button
function buildRoundContent(
    getIcon: () => string,
    getActive: () => boolean,
    onClick: () => void,
): Gtk.Widget {
    const syncClasses = () => {
        btn.set_css_classes(getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"])
        icon.icon_name = getIcon()
    }
    const btn = new Gtk.Button({
        css_classes: getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ icon_name: getIcon(), pixel_size: 28 })
    btn.set_child(icon)
    btn.connect("clicked", () => { onClick(); syncClasses() })
    return btn
}

export function EthernetWidget(): AtomicWidget {
    const network = AstalNetwork.get_default()
    const wired   = network?.wired

    const getIcon = () => {
        if (!wired) return "network-wired-disconnected-symbolic"
        return wired.icon_name || (
            (wired as any).internet === (AstalNetwork as any).Internet?.CONNECTED
                ? "network-wired-symbolic"
                : "network-wired-disconnected-symbolic"
        )
    }
    const getSub = () => {
        if (!wired) return "Sin cable"
        const connected = (wired as any).internet === (AstalNetwork as any).Internet?.CONNECTED
        if (!connected) return "Desconectada"
        return (wired as any).device?.interface || "Conectada"
    }

    const buildContent = (_size: WidgetSize): Gtk.Widget => {
        const content = buildCapsuleContent(
            getIcon,
            () => "Ethernet",
            getSub,
            () => {},  // no toggle — solo indicador
        )
        if (wired) {
            const ids = [
                (wired as any).connect("notify::internet",    () => {}),
                (wired as any).connect("notify::ip4-address", () => {}),
            ]
            content.connect("unrealize", () => ids.forEach(id => { try { (wired as any).disconnect(id) } catch {} }))
        }
        return content
    }

    return { id: "ethernet", name: "Ethernet", defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.WIDE], buildContent }
}

export function WifiWidget(): AtomicWidget {
    const wifi = AstalNetwork.get_default()?.wifi

    const buildContent = (_size: WidgetSize) => {
        const content = buildCapsuleContent(
            () => wifi?.icon_name || "network-wireless-offline-symbolic",
            () => "Wi-Fi",
            () => {
                if (!wifi) return "Off"
                return (wifi as any).ssid || ((wifi as any).enabled === false ? "Off" : "Connected")
            },
            () => execAsync(["bash", "-c",
                "nmcli radio wifi | grep -q enabled && nmcli radio wifi off || nmcli radio wifi on"
            ]).catch(() => {}),
        )
        if (wifi) {
            const sigId = (wifi as any).connect("notify", () => {
                // Trigger re-render via button label update — we rely on reactive state
                // The button itself re-reads getters on each notify
            })
            content.connect("unrealize", () => { try { (wifi as any).disconnect(sigId) } catch {} })
        }
        return content
    }

    return { id: "wifi", name: "Wi-Fi", defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.WIDE], buildContent }
}

export function FocusWidget(): AtomicWidget {
    const notifd = AstalNotifd.get_default()

    const buildContent = (_size: WidgetSize) => {
        const content = buildCapsuleContent(
            () => notifd?.dont_disturb ? "notifications-disabled-symbolic" : "notifications-symbolic",
            () => notifd?.dont_disturb ? "DnD On" : "DnD",
            () => notifd?.dont_disturb ? "Modo silencio" : "",
            () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb },
        )
        if (notifd) {
            const sigId = (notifd as any).connect("notify", () => {})
            content.connect("unrealize", () => { try { (notifd as any).disconnect(sigId) } catch {} })
        }
        return content
    }

    return { id: "focus", name: "Focus", defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.WIDE], buildContent }
}

export function RoundToggle(
    id: string,
    name: string,
    iconName: string | (() => string),
    active: boolean | (() => boolean),
    onClick: () => void,
    wideSubtitle?: () => string,
): AtomicWidget {
    const getActive = typeof active === "function" ? active : () => active
    const getIcon   = typeof iconName === "function" ? iconName : () => iconName
    const getSub    = wideSubtitle ?? (() => "")

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.WIDE) {
            return buildCapsuleContent(getIcon, () => name, getSub, onClick, getActive)
        }
        return buildRoundContent(getIcon, getActive, onClick)
    }

    return {
        id, name,
        defaultSize: WidgetSize.SINGLE,
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
        buildContent,
    }
}
