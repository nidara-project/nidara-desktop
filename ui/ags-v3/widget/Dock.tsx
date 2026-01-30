import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import { execAsync } from "ags/process"
import * as astal from "ags/gtk4/jsx-runtime"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import GObject from "gi://GObject"
import Gtk4LayerShell from "gi://Gtk4LayerShell"

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
    const itemBox = new Gtk.Box({
        name: "dock-item",
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        can_focus: false,
        cursor: Gdk.Cursor.new_from_name("pointer", null),
        spacing: 0,
    })

    const image = new Gtk.Image({
        icon_name: app.icon_name || "preferences-system-windows",
        pixel_size: iconSize * 1.0,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })

    const dot = new Gtk.Box({ name: "dock-dot" })
    const indicator = new Gtk.Box({
        name: "dock-indicator",
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 2,
        spacing: 0,
    })
    indicator.append(dot)

    itemBox.append(image)
    itemBox.append(indicator)

    // --- INTERACTION: CLICK TO LAUNCH ---
    const click = new Gtk.GestureClick()
    click.connect("released", () => {
        app.launch()
    })
    itemBox.add_controller(click)

    // --- INTERACTION: RIGHT CLICK FOR MENU ---
    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", (g, n, x, y) => {
        popover.set_pointing_to(new Gdk.Rectangle({ x, y, width: 0, height: 0 }))
        popover.popup()
    })
    itemBox.add_controller(rightClick)

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

    tooltipPopover.set_parent(itemBox)
    const popover = new Gtk.Popover({ css_classes: ["dock-popover"] })
    popover.set_parent(itemBox)
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
            label: a.label,
            css_classes: ["menu-action"]
        })
        btn.connect("clicked", () => {
            a.action()
            popover.popdown()
        })
        popoverBox.append(btn)
    })
    popover.set_child(popoverBox)

    const clickGesture = new Gtk.GestureClick({ button: 3 })
    clickGesture.connect("released", () => popover.popup())
    itemBox.add_controller(clickGesture)

    // --- DRAG AND DROP REORDERING ---
    if (isPinned) {
        const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
        dragSource.connect("prepare", (source, x, y) => {
            source.set_icon(Gtk.WidgetPaintable.new(image), x, y)
            return Gdk.ContentProvider.new_for_value(appId)
        })
        itemBox.add_controller(dragSource)

        const dropTarget = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
            formats: Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING),
        })
        dropTarget.connect("drop", (target, value, x, y) => {
            const dragId = (value as unknown as GObject.Value).get_string()
            if (dragId && dragId !== appId) {
                const oldIdx = pinnedList.indexOf(dragId)
                const newIdx = pinnedList.indexOf(appId)
                if (oldIdx !== -1 && newIdx !== -1) {
                    pinnedList.splice(oldIdx, 1)
                    pinnedList.splice(newIdx, 0, dragId)
                    savePinned()
                    updateDock()
                    return true
                }
            }
            return false
        })
        itemBox.add_controller(dropTarget)
    }

    const checkMatch = (c: any) => {
        if (!app.get_id) return false
        const appId = app.get_id().toLowerCase()
        const clientClass = (c.class || "").toLowerCase()
        const clientTitle = (c.title || "").toLowerCase()
        return clientClass.includes(appId) || clientTitle.includes(appId) || appId.includes(clientClass)
    }

    const updateState = () => {
        const clients = hypr.get_clients()
        const focused = hypr.get_focused_client()
        let isOpen = false
        let isActive = false

        if (address) {
            isOpen = clients.some(c => c.address === address)
            isActive = focused?.address === address
        } else {
            const match = clients.find(checkMatch)
            isOpen = match !== undefined
            isActive = match?.address === focused?.address
        }

        if (isOpen) indicator.add_css_class("open")
        else indicator.remove_css_class("open")

        if (isActive) itemBox.add_css_class("is-focused")
        else itemBox.remove_css_class("is-focused")
    }

    const c1 = hypr.connect("notify::clients", updateState)
    const launchAction = new Gtk.GestureClick({ button: 1 })
    launchAction.connect("released", () => {
        if (address) {
            execAsync(`hyprctl dispatch focuswindow address:${address}`)
        } else {
            const clients = hypr.get_clients()
            const match = clients.find(checkMatch)
            if (match) {
                execAsync(`hyprctl dispatch focuswindow address:${match.address}`)
            } else {
                app.launch()
            }
        }
    })
    itemBox.add_controller(launchAction)

    const c2 = hypr.connect("notify::active-window", updateState)
    itemBox.connect("destroy", () => {
        hypr.disconnect(c1)
        hypr.disconnect(c2)
    })

    updateState()
    return itemBox
}

// --- REPLACED SEPARATOR WITH CRYSTAL CLEAR SPACE ---

const drawSquircle = (cr: any, width: number, height: number, targetW?: number) => {
    if (width <= 0 || height <= 0) return;

    const w = targetW || width;
    const xOffset = (width - w) / 2;
    const r = height * 0.45;
    const n = 3.8;
    const steps = 64;

    cr.setAntialias(3);

    const getPoint = (t: number) => ({
        x: r * Math.pow(Math.abs(Math.cos(t)), 2 / n),
        y: r * Math.pow(Math.abs(Math.sin(t)), 2 / n)
    });

    const definePath = () => {
        cr.newPath();
        cr.moveTo(xOffset + r, 0);
        cr.lineTo(xOffset + w - r, 0);
        for (let i = steps; i >= 0; i--) {
            const p = getPoint((i / steps) * (Math.PI / 2));
            cr.lineTo(xOffset + w - r + p.x, r - p.y);
        }
        cr.lineTo(xOffset + w, height - r);
        for (let i = 0; i <= steps; i++) {
            const p = getPoint((i / steps) * (Math.PI / 2));
            cr.lineTo(xOffset + w - r + p.x, height - r + p.y);
        }
        cr.lineTo(xOffset + r, height);
        for (let i = steps; i >= 0; i--) {
            const p = getPoint((i / steps) * (Math.PI / 2));
            cr.lineTo(xOffset + r - p.x, height - r + p.y);
        }
        cr.lineTo(xOffset, r);
        for (let i = 0; i <= steps; i++) {
            const p = getPoint((i / steps) * (Math.PI / 2));
            cr.lineTo(xOffset + r - p.x, r - p.y);
        }
        cr.closePath();
    };

    // 1. CLEANING
    cr.setOperator(0);
    cr.paint();
    cr.setOperator(2);

    // 2. THE GLASS (FILL)
    definePath();
    cr.setSourceRGBA(1, 1, 1, 0.12);
    cr.fill();

    // 3. THE RIM (STROKE)
    definePath();
    cr.setSourceRGBA(1, 1, 1, 0.1);
    cr.setLineWidth(0.5);
    cr.stroke();
}

export default function Dock(gdkmonitor: Gdk.Monitor) {
    const bar = new Gtk.Box({
        name: "the-dock-bar",
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        height_request: 92,
        spacing: 0,
        hexpand: false,
    })

    const drawingArea = new Gtk.DrawingArea({
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        height_request: 92,
        overflow: Gtk.Overflow.VISIBLE,
        hexpand: false,
    })

    drawingArea.set_draw_func((da, cr, width, height) => {
        const [_, nat] = bar.get_preferred_size()
        drawSquircle(cr, width, height, nat?.width)
    })

    const dockLayout = new Gtk.Overlay({
        name: "dock-overlay",
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        overflow: Gtk.Overflow.VISIBLE,
        hexpand: false,
    })
    dockLayout.set_child(drawingArea)
    dockLayout.add_overlay(bar)

    const update = () => {
        const children: Gtk.Widget[] = []

        // Nuclear filter to avoid ghost items
        pinnedList.filter(id => !!id && id !== "").forEach(id => {
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

        // Precise sync: Background = Bar Width Exactly (No buffers)
        const [min, nat] = bar.get_preferred_size()
        if (nat) {
            const w = Math.ceil(nat.width)
            const h = 92
            drawingArea.set_size_request(w, h)

            // SYNCHRONIZE WINDOW SIZE TO DOCK SIZE
            if (win) {
                win.set_default_size(w, h)
                win.set_size_request(w, h)
            }
        }
    }

    const conn = hypr.connect("notify::clients", update)
    bar.connect("destroy", () => hypr.disconnect(conn))
    const win = (
        <window
            name="crystal-dock"
            namespace="crystal-dock"
            gdkmonitor={gdkmonitor}
            anchor={Astal.WindowAnchor.BOTTOM}
            layer={Astal.Layer.TOP}
            application={app}
            visible
            heightRequest={92}
        >
            {dockLayout}
        </window>
    ) as any as Gtk.Window
    win.add_css_class("crystal-dock")
    win.set_decorated(false)

    // Apply manual layer shell configuration for the Glass Overlay
    try {
        Gtk4LayerShell.init_for_window(win);
        Gtk4LayerShell.set_namespace(win, "crystal-dock");
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true);
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 10);
        Gtk4LayerShell.set_exclusive_zone(win, 112); // Mathematically Perfect: 10 + 92 + 10 = 112px
    } catch (e) {
        console.error("Failed to initialize Gtk4LayerShell:", e);
    }

    update() // Reference works now that 'win' is hoisted/initialized

    return win
}
