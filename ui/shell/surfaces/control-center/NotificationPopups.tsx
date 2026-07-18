import { Gtk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { NotificationCapsule } from "./NotificationCenter"
import { GRID_WIDTH } from "./CCLayoutManager"
import { ScaleRevealer, attachSwipeDismiss } from "../../common/ScaleRevealer"
import notifConfig from "../../core/NotifConfig"
import status from "../../core/Status"

const MAX_VISIBLE = 4       // cap stacked banners; oldest gets retired first
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
        // Position (top margin, side gap, right-dock dodge) is owned by Bar.tsx
        // (syncPanelMargins), same as CC/NC.
        width_request: GRID_WIDTH,
    })

    interface Entry { revealer: ScaleRevealer, capsule: Gtk.Widget, order: number }
    const entries = new Map<number, Entry>()
    const timerMap = new Map<number, number>()
    let orderSeq = 0

    // Bar owns the layer-shell input region and only re-stamps it on overlay
    // open/close — so a banner appearing with no panel open sits OUTSIDE the
    // region (just the 40px bar strip) and the pointer passes through it: no
    // close, no swipe, no actions. Bar wires (box as any).onStackChanged to its
    // updateInputRegion; we fire it whenever the stack settles at a new size.
    // Deferred a frame (and coalesced) so it reads the settled allocation, not
    // the mid-animation one — the banner is only clickable once fully grown in
    // anyway, and a burst of banners re-stamps once.
    let stampPending = false
    const notifyStackChanged = () => {
        if (stampPending) return
        stampPending = true
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            stampPending = false
            ;(box as any).onStackChanged?.()
            return GLib.SOURCE_REMOVE
        })
    }

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
            notifyStackChanged()   // stack shrank — re-stamp the input region
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

        // Horizontal swipe to dismiss the banner (the notification stays in the
        // NC). The capsule also carries a release-phase tap-to-open; the swipe
        // claims the sequence to cancel it, and pauses the auto-dismiss for the
        // whole gesture. GRID_WIDTH + slop clears the card's box + the gap to the
        // screen edge on the fling.
        attachSwipeDismiss(capsule, revealer, {
            onSwipeStart: () => clearTimer(id),
            onDismiss: () => hardRemove(id),
            onRest: () => { if (entries.has(id) && !timerMap.has(id)) startTimer(id) },
            flingTo: GRID_WIDTH + 200,
        })

        box.append(revealer)
        entries.set(id, { revealer, capsule, order: orderSeq++ })

        // Retire the oldest banners past the cap.
        if (entries.size > MAX_VISIBLE) {
            const sorted = Array.from(entries.entries()).sort((a, b) => a[1].order - b[1].order)
            for (let i = 0; i < sorted.length - MAX_VISIBLE; i++) animateOut(sorted[i][0])
        }

        // Re-stamp once the banner has fully grown in (its allocation is final
        // then, so the input region covers the whole capsule — close button,
        // actions, swipe area).
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { entries.get(id)?.revealer.reveal(true, notifyStackChanged); return GLib.SOURCE_REMOVE })
        startTimer(id)
    }

    const onResolved = (_: any, id: number) => animateOut(id)

    // New banners are already suppressed while the CC/NC is open (see onNotified),
    // but a banner ALREADY on screen would sit on top of the opening panel — the
    // popups overlay stacks above CC/NC in the same corner. Retire live ones too.
    // (animateOut defers the map deletion to the reveal callback, so iterating here is safe.)
    const retireForPanel = () => { if (status.cc_open || status.nc_open) entries.forEach((_e, id) => animateOut(id)) }
    status.connect("notify::cc-open", retireForPanel)
    status.connect("notify::nc-open", retireForPanel)

    notifd.connect("notified", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onNotified(s, id); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onResolved(s, id); return GLib.SOURCE_REMOVE }))

    return box
}


