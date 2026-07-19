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

    interface Entry { revealer: ScaleRevealer, capsule: Gtk.Widget, order: number, n: AstalNotifd.Notification }
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
    // while the pointer is on it. freedesktop expiry semantics: CRITICAL never
    // auto-expires (it stays until acted on — macOS alerts, GNOME does the same),
    // expire_timeout 0 = never, >0 = app-requested ms, -1 = our default.
    const startTimer = (id: number, n: AstalNotifd.Notification) => {
        clearTimer(id)
        if (n.urgency === AstalNotifd.Urgency.CRITICAL || n.expire_timeout === 0) return
        const ms = n.expire_timeout > 0 ? n.expire_timeout : notifConfig.popupTimeoutMs
        timerMap.set(id, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
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

    // Terminal retire: the banner leaves the screen for good. A `transient`
    // notification lives only as long as its banner (freedesktop: excluded from
    // persistence — the NC filters them out too), so drop it from notifd here;
    // get_notification is null when it was already dismissed (resolved path).
    const retireEntry = (id: number) => {
        const entry = entries.get(id)
        hardRemove(id)
        if (entry?.n.transient && notifd.get_notification(id)) entry.n.dismiss()
    }

    // Animated dismiss: shrink back under the clock capsule, then drop the widget.
    const animateOut = (id: number) => {
        clearTimer(id)
        const entry = entries.get(id)
        if (!entry) return
        entry.revealer.reveal(false, () => retireEntry(id))
    }

    // Capsule + its banner behaviours (hover pause, swipe). Factored out because
    // a replacement builds a fresh capsule into the EXISTING revealer.
    const buildCapsule = (n: AstalNotifd.Notification, id: number, revealer: ScaleRevealer) => {
        const capsule = NotificationCapsule({ n, isPopup: true, onClose: () => animateOut(id) })

        // Hover pauses the auto-dismiss; leaving restarts it.
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => clearTimer(id))
        motion.connect("leave", () => { const e = entries.get(id); if (e) startTimer(id, e.n) })
        capsule.add_controller(motion)

        // Horizontal swipe to dismiss the banner (a non-transient notification
        // stays in the NC). The capsule also carries a release-phase tap-to-open;
        // the swipe claims the sequence to cancel it, and pauses the auto-dismiss
        // for the whole gesture. GRID_WIDTH + slop clears the card's box + the gap
        // to the screen edge on the fling.
        attachSwipeDismiss(capsule, revealer, {
            onSwipeStart: () => clearTimer(id),
            onDismiss: () => retireEntry(id),
            onRest: () => { const e = entries.get(id); if (e && !timerMap.has(id)) startTimer(id, e.n) },
            flingTo: GRID_WIDTH + 200,
        })
        return capsule
    }

    const onNotified = (_: any, id: number, replaced: boolean) => {
        const n = notifd.get_notification(id)
        if (!n) return
        // CRITICAL cuts through DND (that's what critical is for — battery dying);
        // an open CC/NC still suppresses banners (the user is looking right there).
        const dndSuppressed = notifd.dont_disturb && n.urgency !== AstalNotifd.Urgency.CRITICAL
        if (dndSuppressed || status.cc_open || status.nc_open) {
            // A transient that never gets its banner has nowhere else to live (the
            // NC excludes it) — drop it so it doesn't linger invisible in notifd.
            if (n.transient) n.dismiss()
            return
        }

        // Replacement with a live banner (progress updates): swap the capsule
        // inside the existing revealer — the banner keeps its slot in the stack
        // and doesn't replay the grow-in — and restart the countdown.
        const live = entries.get(id)
        if (replaced && live) {
            const capsule = buildCapsule(n, id, live.revealer)
            live.revealer.setChild(capsule)
            live.capsule = capsule; live.n = n
            notifyStackChanged()   // new content may change the height
            startTimer(id, n)
            return
        }

        hardRemove(id)

        // Grow-from-small entry pivoted top-right, i.e. from just below the
        // bar's clock capsule (the window is anchored TOP+RIGHT under it).
        // Chicken-and-egg: the swipe wiring needs the revealer, the revealer
        // needs a child — born with a stub, real capsule swapped in.
        const revealer = new ScaleRevealer(new Gtk.Box(), { duration: ANIM_MS })
        const capsule = buildCapsule(n, id, revealer)
        revealer.setChild(capsule)

        box.append(revealer)
        entries.set(id, { revealer, capsule, order: orderSeq++, n })

        // Retire the oldest banners past the cap.
        if (entries.size > MAX_VISIBLE) {
            const sorted = Array.from(entries.entries()).sort((a, b) => a[1].order - b[1].order)
            for (let i = 0; i < sorted.length - MAX_VISIBLE; i++) animateOut(sorted[i][0])
        }

        // Re-stamp once the banner has fully grown in (its allocation is final
        // then, so the input region covers the whole capsule — close button,
        // actions, swipe area).
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { entries.get(id)?.revealer.reveal(true, notifyStackChanged); return GLib.SOURCE_REMOVE })
        startTimer(id, n)
    }

    const onResolved = (_: any, id: number) => animateOut(id)

    // New banners are already suppressed while the CC/NC is open (see onNotified),
    // but a banner ALREADY on screen would sit on top of the opening panel — the
    // popups overlay stacks above CC/NC in the same corner. Retire live ones too.
    // (animateOut defers the map deletion to the reveal callback, so iterating here is safe.)
    const retireForPanel = () => { if (status.cc_open || status.nc_open) entries.forEach((_e, id) => animateOut(id)) }
    status.connect("notify::cc-open", retireForPanel)
    status.connect("notify::nc-open", retireForPanel)

    notifd.connect("notified", (s, id, replaced) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onNotified(s, id, replaced); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", (s, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { onResolved(s, id); return GLib.SOURCE_REMOVE }))

    return box
}


