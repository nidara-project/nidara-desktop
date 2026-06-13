import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { NotificationCapsule } from "./NotificationCenter"
import { GRID_WIDTH } from "./CCLayoutManager"
import { ScaleRevealer } from "../../common/ScaleRevealer"
import { dockSideState } from "../dock/state"
import notifConfig from "../../core/NotifConfig"
import status from "../../core/Status"

const MAX_VISIBLE = 4       // cap stacked banners; oldest gets retired first
const SWIPE_THRESHOLD = 90  // px of horizontal drag to dismiss the banner
const ANIM_MS = 300         // grow/shrink in+out duration

export function NotificationPopupsWidget() {
    const notifd = AstalNotifd.get_default()

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["notif-popup-container"],
        valign: Gtk.Align.START,
        halign: Gtk.Align.END,
        // Same width as the NC cards (one NotificationCapsule, one size).
        width_request: GRID_WIDTH,
        margin_end: dockSideState.position === 'right' ? dockSideState.width : 0,
    })

    dockSideState.subscribe(() => {
        box.margin_end = dockSideState.position === 'right' ? dockSideState.width : 0
    })

    interface Entry { revealer: ScaleRevealer, capsule: Gtk.Widget, order: number }
    const entries = new Map<number, Entry>()
    const timerMap = new Map<number, number>()
    let orderSeq = 0

    const clearTimer = (id: number) => {
        const timer = timerMap.get(id)
        if (timer) { GLib.source_remove(timer); timerMap.delete(id) }
    }

    // Auto-dismiss countdown; restarted on hover-leave so a banner can't vanish
    // while the pointer is on it.
    const startTimer = (id: number) => {
        clearTimer(id)
        timerMap.set(id, GLib.timeout_add(GLib.PRIORITY_DEFAULT, notifConfig.popupTimeoutMs, () => {
            timerMap.delete(id)
            animateOut(id)
            return GLib.SOURCE_REMOVE
        }))
    }

    // Hard remove — collapse done, drop from the tree.
    const hardRemove = (id: number) => {
        clearTimer(id)
        const entry = entries.get(id)
        if (entry) {
            if (entry.revealer.get_parent() === box) box.remove(entry.revealer)
            entry.revealer.dismantle()
            entries.delete(id)
        }
    }

    // Animated dismiss: shrink back under the clock capsule, then drop the widget.
    const animateOut = (id: number) => {
        clearTimer(id)
        const entry = entries.get(id)
        if (!entry) return
        entry.revealer.reveal(false, () => hardRemove(id))
    }

    const onNotified = (_: any, id: number) => {
        const n = notifd.get_notification(id)
        if (!n || notifd.dont_disturb || status.cc_open || status.nc_open) return

        hardRemove(id)

        const capsule = NotificationCapsule({ n, isPopup: true, onClose: () => animateOut(id) })

        // Grow-from-small entry pivoted top-right, i.e. from just below the
        // bar's clock capsule (the window is anchored TOP+RIGHT under it).
        const revealer = new ScaleRevealer(capsule, { duration: ANIM_MS })

        // Hover pauses the auto-dismiss; leaving restarts it.
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => clearTimer(id))
        motion.connect("leave", () => { if (entries.has(id)) startTimer(id) })
        capsule.add_controller(motion)

        // Horizontal swipe to dismiss the banner (the notification stays in the NC).
        const drag = new Gtk.GestureDrag()
        drag.connect("drag-update", (_g, ox) => {
            const dx = ox || 0
            capsule.set_opacity(Math.max(0.15, 1 - Math.abs(dx) / 320))
            capsule.set_margin_start(Math.max(0, dx))
            capsule.set_margin_end(Math.max(0, -dx))
        })
        drag.connect("drag-end", (_g, ox) => {
            const dx = ox || 0
            if (Math.abs(dx) >= SWIPE_THRESHOLD) { animateOut(id); return }
            capsule.set_opacity(1); capsule.set_margin_start(0); capsule.set_margin_end(0)
            if (entries.has(id) && !timerMap.has(id)) startTimer(id)
        })
        capsule.add_controller(drag)

        box.append(revealer)
        entries.set(id, { revealer, capsule, order: orderSeq++ })

        // Retire the oldest banners past the cap.
        if (entries.size > MAX_VISIBLE) {
            const sorted = Array.from(entries.entries()).sort((a, b) => a[1].order - b[1].order)
            for (let i = 0; i < sorted.length - MAX_VISIBLE; i++) animateOut(sorted[i][0])
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { entries.get(id)?.revealer.reveal(true); return GLib.SOURCE_REMOVE })
        startTimer(id)
    }

    const onResolved = (_: any, id: number) => animateOut(id)

    notifd.connect("notified", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onNotified(s, id); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onResolved(s, id); return GLib.SOURCE_REMOVE }))

    return box
}

export default function NotificationPopups(gdkmonitor: Gdk.Monitor) {
    const box = NotificationPopupsWidget()
    const win = new Gtk.Window({
        name: "notif-win",
        application: app,
        css_classes: ["notif-win", "fc-ignore"],
        child: box
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "notif-win")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 54)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 12)
        Gtk4LayerShell.set_exclusive_zone(win, 0)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) { }

    return win
}

