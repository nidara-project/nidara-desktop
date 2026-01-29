import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"

// --- CONFIGURACIÓN & PERSISTENCIA ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"
const DEFAULT_PINNED = ["google-chrome", "kitty", "org.gnome.Nautilus"]

const hypr = AstalHyprland.get_default()
const appsService = new AstalApps.Apps()

const loadPinned = () => {
    try {
        return JSON.parse(readFile(PINNED_FILE)) as string[]
    } catch {
        return DEFAULT_PINNED
    }
}

let pinnedList = loadPinned()

const savePinned = () => {
    writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))
}

function DockItem(app: AstalApps.Application, updateDock: () => void, address?: string) {
    // @ts-ignore
    const currentId = (app.get_id ? app.get_id() : (app.id || "")).toLowerCase().replace(".desktop", "")
    const appId = (app.get_id ? app.get_id() : (app.id || "")).replace(".desktop", "")

    const iconSize = 64
    const button = new Gtk.Button({
        css_classes: ["dock-item"],
        valign: Gtk.Align.CENTER,
    })

    const image = new Gtk.Image({
        icon_name: app.icon_name || "preferences-system-windows",
        pixel_size: iconSize,
        css_classes: ["dock-icon"]
    })

    const dot = new Gtk.Box({ css_classes: ["indicator-dot"] })
    const indicator = new Gtk.Box({
        css_classes: ["indicator"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END
    })
    indicator.append(dot)

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4
    })
    content.append(image)
    content.append(indicator)
    button.set_child(content)

    // --- PRECISE DELAYED TOOLTIP (POPOVER) ---
    const tooltipPopover = new Gtk.Popover({
        css_classes: ["dock-tooltip"],
        position: Gtk.PositionType.TOP,
        autohide: false,
        has_arrow: false,
    })

    const tooltipContent = new Gtk.Box({
        css_classes: ["tooltip-content"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    })
    tooltipContent.append(new Gtk.Label({
        label: app.name || "App",
        css_classes: ["tooltip-label"]
    }))

    tooltipPopover.set_child(tooltipContent)
    tooltipPopover.set_parent(button)

    let hoverTimeout: any = null
    const hoverCtrl = new Gtk.EventControllerMotion()
    hoverCtrl.connect("enter", () => {
        if (hoverTimeout) GLib.source_remove(hoverTimeout)
        hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            tooltipPopover.popup()
            hoverTimeout = null
            return false
        })
    })
    hoverCtrl.connect("leave", () => {
        if (hoverTimeout) {
            GLib.source_remove(hoverTimeout)
            hoverTimeout = null
        }
        tooltipPopover.popdown()
    })
    button.add_controller(hoverCtrl)

    // --- CONTEXT MENU POPUP ---
    const popover = new Gtk.Popover({ css_classes: ["dock-popover"] })
    const popoverBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })

    const isPinned = pinnedList.includes(appId)

    const actions = [
        { label: "Lanzar", action: () => app.launch() },
        {
            label: isPinned ? "Desanclar del Dock" : "Anclar al Dock",
            action: () => {
                if (isPinned) pinnedList = pinnedList.filter(p => p !== appId)
                else pinnedList.push(appId)
                savePinned()
                updateDock()
            }
        }
    ]

    if (isPinned) {
        actions.push(
            {
                label: "Mover a la Izquierda", action: () => {
                    const idx = pinnedList.indexOf(appId)
                    if (idx > 0) {
                        const temp = pinnedList[idx - 1]
                        pinnedList[idx - 1] = pinnedList[idx]
                        pinnedList[idx] = temp
                        savePinned()
                        updateDock()
                    }
                }
            },
            {
                label: "Mover a la Derecha", action: () => {
                    const idx = pinnedList.indexOf(appId)
                    if (idx < pinnedList.length - 1) {
                        const temp = pinnedList[idx + 1]
                        pinnedList[idx + 1] = pinnedList[idx]
                        pinnedList[idx] = temp
                        savePinned()
                        updateDock()
                    }
                }
            }
        )
    }

    if (address) {
        actions.push(
            {
                label: "Cerrar Ventana", action: () => {
                    execAsync(`hyprctl dispatch closewindow address:${address}`)
                }
            },
            {
                label: "Forzar Cierre", action: () => {
                    execAsync(`hyprctl dispatch kill address:${address}`)
                }
            }
        )
    }

    actions.forEach(a => {
        const btn = new Gtk.Button({
            child: new Gtk.Label({ label: a.label }),
            css_classes: ["menu-action"]
        })
        btn.connect("clicked", () => {
            a.action()
            popover.popdown()
        })
        popoverBox.append(btn)
    })
    popover.set_child(popoverBox)
    popover.set_parent(button)

    const clickGesture = new Gtk.GestureClick({ button: 3 })
    clickGesture.connect("released", () => popover.popup())
    button.add_controller(clickGesture)

    const updateState = () => {
        const clients = hypr.clients
        const focused = hypr.focusedClient

        let isOpen = false
        let isActive = false

        const checkMatch = (c: any) => {
            const currentName = (app.name || "").toLowerCase()
            const currentIcon = (app.icon_name || "").toLowerCase()
            const cClass = (c.class || "").toLowerCase()
            const cTitle = (c.title || "").toLowerCase()
            return (currentId !== "" && (cClass.includes(currentId) || currentId.includes(cClass))) ||
                (currentName !== "" && (cClass.includes(currentName) || currentName.includes(cClass))) ||
                (currentIcon !== "" && (cClass.includes(currentIcon) || currentIcon.includes(cClass))) ||
                (currentIcon.includes("chrome") && (cClass.includes("chrome") || cTitle.includes("chrome"))) ||
                (currentIcon.includes("terminal") && cClass.includes("kitty")) ||
                (currentIcon.includes("kitty") && cClass.includes("kitty"))
        }

        if (address) {
            isOpen = clients.some(c => c.address === address)
            isActive = focused?.address === address || (focused && checkMatch(focused))
        } else {
            const client = clients.find(checkMatch)
            isOpen = !!client
            isActive = focused ? checkMatch(focused) : false
        }

        if (isOpen) indicator.add_css_class("open")
        else indicator.remove_css_class("open")

        if (isActive) button.add_css_class("active")
        else button.remove_css_class("active")
    }

    const c1 = hypr.connect("notify::clients", updateState)
    const c2 = hypr.connect("notify::focused-client", updateState)
    button.connect("destroy", () => {
        hypr.disconnect(c1)
        hypr.disconnect(c2)
    })

    button.connect("clicked", () => {
        if (address) {
            execAsync(`hyprctl dispatch focuswindow address:${address}`)
        } else {
            const client = hypr.clients.find(c => {
                const currentName = (app.name || "").toLowerCase()
                const currentIcon = (app.icon_name || "").toLowerCase()
                const cClass = (c.class || "").toLowerCase()
                return (currentId !== "" && (cClass.includes(currentId) || currentId.includes(cClass))) ||
                    (currentName !== "" && (cClass.includes(currentName) || currentName.includes(cClass))) ||
                    (currentIcon !== "" && (cClass.includes(currentIcon) || currentIcon.includes(cClass))) ||
                    (currentIcon.includes("chrome") && cClass.includes("chrome")) ||
                    (currentIcon.includes("terminal") && cClass.includes("kitty"))
            })

            if (client) {
                execAsync(`hyprctl dispatch focuswindow address:${client.address}`)
            } else {
                app.launch()
            }
        }
    })

    updateState()
    return button
}

function Separator() {
    return new Gtk.Box({
        css_classes: ["separator"],
        valign: Gtk.Align.CENTER
    })
}

export default function Dock(gdkmonitor: Gdk.Monitor) {
    const bar = new Gtk.Box({ css_classes: ["dock-bar"] })

    const update = () => {
        const children: Gtk.Widget[] = []

        pinnedList.forEach(id => {
            let app = appsService.list.find(a => a.id === id)
            if (!app) app = appsService.fuzzy_query(id)?.[0]
            if (app) children.push(DockItem(app, update))
        })

        const running = hypr.clients.filter(c =>
            !pinnedList.some(p => {
                const lp = p.toLowerCase()
                const lc = c.class.toLowerCase()
                return lp === lc || lp.includes(lc) || lc.includes(lp)
            }) && c.class && !c.class.includes("ags")
        )

        if (running.length > 0) {
            children.push(Separator())
            running.forEach(c => {
                let app = appsService.fuzzy_query(c.class)?.[0]
                if (!app) {
                    // @ts-ignore
                    app = {
                        name: c.title || c.class,
                        icon_name: (c.class === "kitty" ? "terminal" : c.class),
                        launch: () => execAsync(`hyprctl dispatch focuswindow address:${c.address}`)
                    }
                }
                children.push(DockItem(app, update, c.address))
            })
        }

        let child = bar.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            bar.remove(child)
            child = next
        }
        children.forEach(c => bar.append(c))
    }

    const conn = hypr.connect("notify::clients", update)
    bar.connect("destroy", () => hypr.disconnect(conn))
    update()

    return (
        <window
            name="crystal-dock"
            namespace="crystal-dock"
            css_classes={["dock-window"]}
            gdkmonitor={gdkmonitor}
            exclusivity={Astal.Exclusivity.EXCLUSIVE}
            anchor={Astal.WindowAnchor.BOTTOM}
            layer={Astal.Layer.TOP}
            application={app}
            visible
            css="background: transparent;"
        >
            <box
                css_classes={["dock-bar-container"]}
                marginBottom={10}
                css="background: transparent;"
            >
                {bar}
            </box>
        </window>
    )
}
