import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import { AtomicWidget, WidgetSize } from "./Types"

/**
 * Creates a standard 2x1 Capsule button layout (like Wi-Fi and DnD)
 */
function createCapsuleButton(
    id: string,
    name: string,
    iconSignal: { connect: (signal: string, callback: () => void) => number, disconnect?: (id: number) => void },
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
        margin_start: 4 // Exactly 4px to align with the 48x48 RoundToggles (which have 4px centering margin)
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48
    })

    // The issue with bleeding icons is sometimes Gtk.Image expands. Setting halign/valign CENTER fixes it.
    const icon = new Gtk.Image({
        icon_name: getIconName(),
        pixel_size: 28, // Using 28px for uniformity
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true // Forces the image to sit mathematically within the 48x48 box
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

    if (iconSignal) {
        // Just bind to the update function
        if (typeof (iconSignal as any).connect === "function") {
            // we re-run update on commonly changed properties
            iconSignal.connect("notify", update)
        }
    }
    update() // Init

    return { id, name, size: WidgetSize.WIDE, child: btn }
}

export function WifiWidget(): AtomicWidget {
    const network = AstalNetwork.get_default()
    const wifi = network?.wifi

    return createCapsuleButton(
        "wifi",
        "Wi-Fi",
        wifi as any,
        () => wifi ? wifi.icon_name || "network-wireless-offline-symbolic" : "network-wireless-offline-symbolic",
        () => "Wi-Fi",
        () => wifi ? (wifi.ssid || "Connected") : "Disconnected",
        () => {
            // Wifi toggle logic here
        }
    )
}

export function RoundToggle(id: string, name: string, iconName: string, active: boolean, onClick: () => void): AtomicWidget {
    const btn = new Gtk.Button({
        css_classes: ["cc-atomic-round-btn", active ? "active" : ""],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48
    })
    const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 28 })
    btn.set_child(icon)
    btn.connect("clicked", onClick)

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
        () => "", // No subtitle for Focus usually, or we can use state
        () => {
            if (notifd) notifd.dont_disturb = !notifd.dont_disturb
        }
    )
}
