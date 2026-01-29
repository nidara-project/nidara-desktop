import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"

// --- CONFIGURACIÓN & PERSISTENCIA ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"
const DEFAULT_PINNED: string[] = []

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
    const rawId = (app.get_id ? app.get_id() : (app.id || app.icon_name || app.name || "")).replace(".desktop", "")
    const appId = rawId || "unknown-app"

    const iconSize = 64
    const button = new Gtk.Button({
        css_classes: ["dock-item"],
        valign: Gtk.Align.FILL, // Take full 84px height
    })

    const image = new Gtk.Image({
        icon_name: app.icon_name || "preferences-system-windows",
        pixel_size: iconSize,
        css_classes: ["dock-icon"],
        valign: Gtk.Align.CENTER, // Centered in the 84px space
        halign: Gtk.Align.CENTER,
    })

    const dot = new Gtk.Box({ css_classes: ["indicator-dot"] })
    const indicator = new Gtk.Box({
        css_classes: ["indicator"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END, // Fixed at bottom edge
        margin_bottom: 2 // Closer to edge for maximum separation from icon
    })
    indicator.append(dot)

    const overlay = new Gtk.Overlay({
        css_classes: ["dock-item-overlay"],
        valign: Gtk.Align.FILL, // Stretch to full height
    })

    overlay.set_child(image)
    overlay.add_overlay(indicator)

    button.set_child(overlay)

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

    const isPinned = pinnedList.some(p => {
        if (!p || !appId) return false
        const lp = p.toLowerCase()
        const lid = appId.toLowerCase()
        return lp === lid || lp.includes(lid) || lid.includes(lp)
    })

    const actions = [
        { label: "Lanzar", action: () => app.launch() },
        {
            label: isPinned ? "Desanclar del Dock" : "Anclar al Dock",
            action: () => {
                if (isPinned) {
                    pinnedList = pinnedList.filter(p => {
                        const lp = p.toLowerCase()
                        const lid = appId.toLowerCase()
                        return !(lp === lid || lp.includes(lid) || lid.includes(lp))
                    })
                } else {
                    if (appId !== "unknown-app") pinnedList.push(appId)
                }
                savePinned()
                updateDock()
            }
        }
    ]

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

    // --- DRAG AND DROP REORDERING ---
    if (isPinned) {
        const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
        dragSource.connect("prepare", (source, x, y) => {
            source.set_icon(Gtk.WidgetPaintable.new(image), x, y)
            return Gdk.ContentProvider.new_for_value(appId)
        })
        button.add_controller(dragSource)

        const dropTarget = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
        })
        dropTarget.set_gtypes([GObject.TYPE_STRING])

        dropTarget.connect("drop", (target, value) => {
            const draggedId = value as unknown as string
            const targetId = appId

            const fromIdx = pinnedList.findIndex(p => p === draggedId)
            const toIdx = pinnedList.findIndex(p => p === targetId)

            if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                const [item] = pinnedList.splice(fromIdx, 1)
                pinnedList.splice(toIdx, 0, item)
                savePinned()
                updateDock()
                return true
            }
            return false
        })
        button.add_controller(dropTarget)
    }

    const checkMatch = (c: any) => {
        const currentId = appId.toLowerCase()
        const currentName = (app.name || "").toLowerCase()
        const currentIcon = (app.icon_name || "").toLowerCase()
        const cClass = (c.class || "").toLowerCase()
        const cTitle = (c.title || "").toLowerCase()

        if (!currentId || currentId === "unknown-app") return false

        return (cClass.includes(currentId) || currentId.includes(cClass)) ||
            (currentName !== "" && (cClass.includes(currentName) || currentName.includes(cClass))) ||
            (currentIcon !== "" && (cClass.includes(currentIcon) || currentIcon.includes(cClass))) ||
            (currentIcon.includes("chrome") && (cClass.includes("chrome") || cTitle.includes("chrome"))) ||
            (currentIcon.includes("terminal") && cClass.includes("kitty")) ||
            (currentIcon.includes("kitty") && cClass.includes("kitty"))
    }

    const updateState = () => {
        const clients = hypr.clients
        const focused = hypr.focusedClient

        let isOpen = false
        let isActive = false

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
            const client = hypr.clients.find(checkMatch)
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

const drawSquircle = (cr: any, width: number, height: number) => {
    if (width <= 0 || height <= 0) return;

    // Architectural Squircle (macOS Authentic)
    // Rectangular base with independent G2 corners.
    const r = height * 0.45; // 45% of height for the corners
    const n = 3.8;           // Balanced superellipse exponent
    const steps = 64;

    // Enable high-quality antialiasing
    // @ts-ignore
    if (cr.setAntialias) {
        // @ts-ignore
        cr.setAntialias(3); // Antialias.BEST is usually 3 in Cairo
    }

    // Frosted Glass (Apple Style)
    // Light white with low opacity allows the background blur to shine through.
    cr.setSourceRGBA(1, 1, 1, 0.15);

    // Helper for superellipse plotting relative to an origin
    const getPoint = (t: number) => {
        return {
            x: r * Math.pow(Math.abs(Math.cos(t)), 2 / n),
            y: r * Math.pow(Math.abs(Math.sin(t)), 2 / n)
        };
    };

    // 1. Top Edge (Straight)
    cr.moveTo(r, 0);
    cr.lineTo(width - r, 0);

    // 2. Top-Right Corner
    for (let i = steps; i >= 0; i--) {
        const t = (i / steps) * (Math.PI / 2);
        const p = getPoint(t);
        cr.lineTo(width - r + p.x, r - p.y);
    }

    // 3. Right Edge (Straight)
    cr.lineTo(width, height - r);

    // 4. Bottom-Right Corner
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * (Math.PI / 2);
        const p = getPoint(t);
        cr.lineTo(width - r + p.x, height - r + p.y);
    }

    // 5. Bottom Edge (Straight)
    cr.lineTo(r, height);

    // 6. Bottom-Left Corner
    for (let i = steps; i >= 0; i--) {
        const t = (i / steps) * (Math.PI / 2);
        const p = getPoint(t);
        cr.lineTo(r - p.x, height - r + p.y);
    }

    // 7. Left Edge (Straight)
    cr.lineTo(0, r);

    // 8. Top-Left Corner
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * (Math.PI / 2);
        const p = getPoint(t);
        cr.lineTo(r - p.x, r - p.y);
    }

    cr.closePath();
    cr.fillPreserve();

    // Subtle Rim Light (Separator Edge)
    cr.setSourceRGBA(1, 1, 1, 0.12);
    cr.setLineWidth(1.0);
    cr.stroke();
}

export default function Dock(gdkmonitor: Gdk.Monitor) {
    const bar = new Gtk.Box({
        css_classes: ["dock-bar"],
        valign: Gtk.Align.FILL,
        halign: Gtk.Align.CENTER,
    })

    const drawingArea = new Gtk.DrawingArea({
        height_request: 92,
    })

    drawingArea.set_draw_func((da, cr, width, height) => {
        drawSquircle(cr, width, height)
    })

    const dockLayout = new Gtk.Overlay()
    dockLayout.set_child(drawingArea) // DrawingArea as base
    dockLayout.add_overlay(bar)      // Icons on top

    const update = () => {
        const children: Gtk.Widget[] = []

        pinnedList.forEach(id => {
            let app = appsService.list.find(a => a.id === id)
            if (!app) app = appsService.fuzzy_query(id)?.[0]
            if (app) children.push(DockItem(app, update))
        })

        const running = hypr.clients.filter(c => {
            const cClass = c.class.toLowerCase()
            const isAgs = cClass.includes("ags")
            if (isAgs) return false

            const inPinned = pinnedList.some(p => {
                const lp = p.toLowerCase()
                return (lp === cClass || lp.includes(cClass) || cClass.includes(lp))
            })
            return !inPinned
        })

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

        // Sync background size
        const [min, nat] = bar.get_preferred_size()
        if (nat) {
            // Add 64px (32px per side) of horizontal "breathing room" 
            // so icons don't hit the curved Squircle ends.
            drawingArea.set_size_request(nat.width + 64, 92)
        }
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
                halign={Gtk.Align.CENTER}
            >
                {dockLayout}
            </box>
        </window>
    )
}
