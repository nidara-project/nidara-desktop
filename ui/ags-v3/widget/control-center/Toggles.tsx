import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import { AtomicWidget, WidgetSize } from "./Types"

function createCapsuleButton(
    id: string,
    name: string,
    iconSignal: { connect: (signal: string, callback: () => void) => number },
    getIconName: () => string,
    getTitle: () => string,
    getSubTitle: () => string,
    onClick: () => void
): AtomicWidget {
    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
        margin_start: 4
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48
    })

    const icon = new Gtk.Image({
        icon_name: getIconName(),
        pixel_size: 28,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true
    })
    iconBox.append(icon)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    const label = new Gtk.Label({
        label: getTitle(),
        css_classes: ["cc-atomic-label-bold"],
        halign: Gtk.Align.START,
        ellipsize: 3,
        max_width_chars: 14
    })
    const subLabel = new Gtk.Label({
        label: getSubTitle(),
        css_classes: ["cc-atomic-label-dim"],
        halign: Gtk.Align.START,
        ellipsize: 3,
        max_width_chars: 14
    })

    textStack.append(label)
    textStack.append(subLabel)
    box.append(iconBox)
    box.append(textStack)
    btn.set_child(box)
    btn.connect("clicked", onClick)

    const update = () => {
        icon.icon_name = getIconName()
        label.label = getTitle()
        const sub = getSubTitle()
        subLabel.label = sub
        subLabel.visible = sub.length > 0
    }

    if (iconSignal && typeof (iconSignal as any).connect === "function") {
        iconSignal.connect("notify", update)
    }
    update()

    return { id, name, size: WidgetSize.WIDE, child: btn }
}

export function WifiWidget(): AtomicWidget {
    const network = AstalNetwork.get_default()
    const wifi = network?.wifi

    return createCapsuleButton(
        "wifi",
        "Wi-Fi",
        wifi as any,
        () => wifi?.icon_name || "network-wireless-offline-symbolic",
        () => "Wi-Fi",
        () => {
            if (!wifi) return "Off"
            return (wifi as any).ssid || ((wifi as any).enabled === false ? "Off" : "Connected")
        },
        () => {
            execAsync(["bash", "-c",
                "nmcli radio wifi | grep -q enabled && nmcli radio wifi off || nmcli radio wifi on"
            ]).catch(() => {})
        }
    )
}

/**
 * Round toggle button with reactive active state.
 * `active` and `iconName` can be a static value or a getter function —
 * if a getter is passed, the visual state updates on every click.
 */
export function RoundToggle(
    id: string,
    name: string,
    iconName: string | (() => string),
    active: boolean | (() => boolean),
    onClick: () => void
): AtomicWidget {
    const getActive = typeof active === "function" ? active : () => active as boolean
    const getIcon = typeof iconName === "function" ? iconName : () => iconName as string

    const syncClasses = () => {
        btn.set_css_classes(getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"])
        icon.icon_name = getIcon()
    }

    const btn = new Gtk.Button({
        css_classes: getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48
    })
    const icon = new Gtk.Image({ icon_name: getIcon(), pixel_size: 28 })
    btn.set_child(icon)
    btn.connect("clicked", () => {
        onClick()
        syncClasses()
    })

    return { id, name, size: WidgetSize.SINGLE, child: btn }
}

export function FocusWidget(): AtomicWidget {
    const notifd = AstalNotifd.get_default()

    return createCapsuleButton(
        "focus",
        "Focus",
        notifd as any,
        () => notifd?.dont_disturb ? "notifications-disabled-symbolic" : "notifications-symbolic",
        () => notifd?.dont_disturb ? "DnD On" : "DnD",
        () => notifd?.dont_disturb ? "Modo silencio" : "",
        () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb }
    )
}
