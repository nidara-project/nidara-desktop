import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import status, { ISLAND_OVERVIEW } from "../../core/Status"
import SquircleContainer from "../../common/SquircleContainer"
import { RADIUS } from "../../../lib/tokens"
import { t } from "../../core/i18n"
import { createSchematicMap } from "../../common/WorkspaceSchematic"
import hs, { type ClientGeometry } from "../../core/HyprlandState"
import { safeDisconnect } from "../../core/signals"
import { makeWorkspaceDot, WS_COUNT } from "../../common/WorkspaceDot"
import { warmUp as warmUpCapture } from "../../core/WindowCapture"

/**
 * How close the panel comes to the screen edge. The overview stays a floating
 * glass panel — this is NOT a full-bleed Mission Control mode — but it is the one
 * surface whose whole job is to show you every window at once, so it takes
 * essentially the whole width and leaves a hairline of wallpaper on each side.
 */
const WO_EDGE_MARGIN = 8

/**
 * Chrome around the previews, in px — and 🔑 **the only definition of these
 * numbers anywhere**. They are applied as GTK margins from right here, not
 * declared as CSS padding, precisely because the panel's width is *solved* from
 * them: a layout computed in JS cannot read a CSS padding, so a padding in
 * `_workspace.scss` would have to be mirrored here, and a mirror drifts silently.
 *
 * The tempting alternative was to ASK GTK (`get_style_context().get_padding()`
 * resolves correctly even on an unrooted widget — verified 2026-08-06, it returns
 * 16/1). It was rejected: it only works because `_workspace.scss` is currently
 * UNSCOPED. Scope it under `window#…` — which commandment 2 says it should be —
 * and a not-yet-rooted probe stops matching the selector, the read comes back 0,
 * and the layout silently falls back to a stale constant. Replicating the real
 * ancestry in the probe just trades a mirror of numbers for a mirror of
 * structure. Owning the number outright has no such failure mode.
 *
 * `WO_CARD_BORDER` is the one thing still declared in CSS (`.wo-item`'s
 * `border: 1px`) — a border is not a spacing token and does not move; if it ever
 * did, the cost is 2px of edge margin, not a broken layout.
 */
const WO_PANEL_PAD   = 32  // inset from the glass panel's edge to the card grid
const WO_GRID_GAP    = 16  // between cards
const WO_CARD_PAD    = 16  // inset from a card's border to its content
const WO_CARD_BORDER = 1   // .wo-item border-width — mirrors CSS, see above
const WO_CARD_CHROME = 2 * WO_CARD_PAD + 2 * WO_CARD_BORDER

/** Below this a card is unreadable whatever the screen — a floor, not a target.
 *  Reaching it needs a monitor under ~900px wide, where the panel is the least
 *  of anyone's problems. */
const WO_PREVIEW_MIN = 120

/**
 * Card size comes FROM THE MONITOR, never from a constant.
 *
 * The previews used to be a hardcoded 300px, which made the panel a hardcoded
 * 1798px: 70% of a 2560 screen (so the thumbnails were smaller than they needed
 * to be), and WIDER THAN a 1600px laptop, where it would simply have overflowed.
 * A capture you cannot read is a render pass spent for nothing, so the size is
 * the feature — but the right size is a fraction of the screen, not a number.
 *
 * Solving `2·margin + 2·pad + (n−1)·gap + n·(preview + chrome) = monitorWidth`
 * for `preview`. Measured against the real widget tree (offscreen GTK probe,
 * 2026-08-06): 2560 → 449, panel 2543, 8px of wallpaper each side.
 *
 * ⚠️ The gain is NOT uniform: on a 1920 laptop the same formula gives 321, barely
 * above the old 300. Wide screens are where this pays.
 */
function previewWidthFor(gdkmonitor: Gdk.Monitor): number {
    // Logical pixels — GTK has already divided by the scale factor, which is the
    // same space the panel is laid out in.
    const monW = gdkmonitor.get_geometry().width
    const chrome = 2 * WO_EDGE_MARGIN + 2 * WO_PANEL_PAD
        + (WS_COUNT - 1) * WO_GRID_GAP + WS_COUNT * WO_CARD_CHROME
    return Math.max(WO_PREVIEW_MIN, Math.floor((monW - chrome) / WS_COUNT))
}

// Glass recipe for the island container — exported so the bar's MorphRevealer
// paints its interpolated Cairo clone with the exact same params and the
// handoff at the morph's endpoints is pixel-perfect (see MorphRevealer.ts).
export const WO_GLASS = { radius: RADIUS.xl, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

export default function WorkspaceOverview(gdkmonitor: Gdk.Monitor) {
    let previewWidth = previewWidthFor(gdkmonitor)

    // The panel's inset is a MARGIN here, not a padding in `_workspace.scss`, so
    // `previewWidthFor` and the layout are reading the same number rather than two
    // copies of it. `.workspace-overview` paints nothing (the glass is the
    // SquircleContainer wrapping it), so margin and padding are interchangeable
    // for it: the squircle's DrawingArea fills the whole grid either way.
    const overview = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["workspace-overview"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        margin_top: WO_PANEL_PAD,
        margin_bottom: WO_PANEL_PAD,
        margin_start: WO_PANEL_PAD,
        margin_end: WO_PANEL_PAD,
    })

    const windowContent = new Gtk.Box({
        css_classes: ["cockpit-window-content"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true
    })

    // SquircleContainer wraps the entire overview, providing a unified glass background
    const overviewSquircle = SquircleContainer({
        child: overview,
        n: WO_GLASS.n,
        radius: WO_GLASS.radius,
        useShellOpacity: true,
        gloss: true,
        borderColor: WO_GLASS.border
    })

    windowContent.append(overviewSquircle)

    const list = new Gtk.Grid({
        column_spacing: WO_GRID_GAP,
        row_spacing: WO_GRID_GAP,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER
    })

    const slots = new Map<number, { itemBox: Gtk.Box, label: Gtk.Label, count: Gtk.Label, schematic: (geom?: ClientGeometry) => void, refreshThumbs: () => void, setWidth: (px: number) => void }>()

    // Keyboard-focused slot (1..WS_COUNT), -1 = keyboard nav idle. Set on open to
    // the active workspace; moved by ←/→; committed by Enter. Purely a visual
    // cursor (the `keyboard-focus` class) — we never grab GTK focus, so the bar's
    // CAPTURE-phase key controller owns navigation the same way Prism does.
    let navIdx = -1

    // Close first, THEN switch — the same order the app grid now follows, through the
    // same entry point (`focusWorkspaceFromShell`), so the two workspace switchers
    // cannot drift apart again. No grab is lent: closing the island releases a
    // COMPOSITOR focus grab, and unlike layer-shell EXCLUSIVE that one never made
    // Hyprland refuse to move window focus, so there is nothing to wait for here.
    const switchToWorkspace = (id: number) => {
        status.island_mode = ""
        hs.focusWorkspaceFromShell(id)
    }

    // Each card carries the SAME state dot as the bar capsule (shared
    // makeWorkspaceDot, identical CSS): the morph's traveling ghosts land
    // exactly on these — the capsule's dot row fans out into the card headers.
    const cardDots: Gtk.Widget[] = []

    for (let i = 1; i <= WS_COUNT; i++) {
        const schematic = createSchematicMap(i, previewWidth, { thumbnails: true })
        const dot = makeWorkspaceDot(i)
        dot.halign = Gtk.Align.CENTER
        dot.margin_bottom = 2
        cardDots.push(dot)
        const label = new Gtk.Label({ label: `${t("overview.workspace")} ${i}`, css_classes: ["wo-label"] })
        const count = new Gtk.Label({ css_classes: ["wo-count"] })
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            halign: Gtk.Align.CENTER,
            margin_bottom: 4
        })
        header.append(dot); header.append(label); header.append(count)

        // `.wo-item` is the PAINTED box (fill, border, radius, hover/active
        // states) and holds no spacing of its own. Its inset is the inner box's
        // margin, set from WO_CARD_PAD — same number `previewWidthFor` solved
        // with. Visually identical to the CSS padding it replaced: a margin
        // inside a styled parent is a padding.
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: WO_CARD_PAD,
            margin_bottom: WO_CARD_PAD,
            margin_start: WO_CARD_PAD,
            margin_end: WO_CARD_PAD,
        })
        content.append(header); content.append(schematic.wrapper)

        const itemBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: ["wo-item"],
            // The card's own chrome, not a guess: this used to ask for +24 while
            // the real figure is 34, so the request was dead — the natural width
            // always won. Asking for the true figure keeps the request and the
            // layout describing the same card.
            width_request: previewWidth + WO_CARD_CHROME,
            hexpand: false
        })
        itemBox.append(content)

        const btn = new Gtk.Button({ child: itemBox, css_classes: ["wo-btn"] })
        btn.set_focus_on_click(false)
        btn.connect("clicked", () => switchToWorkspace(i))

        slots.set(i, { itemBox, label, count, schematic: schematic.sync, refreshThumbs: schematic.refresh, setWidth: schematic.setWidth })
        const col = (i - 1) % WS_COUNT
        const row = Math.floor((i - 1) / WS_COUNT)
        list.attach(btn, col, row, 1, 1)
    }

    const syncAll = (geom?: ClientGeometry) => {
        try {
            const focusedId = hs.focusedWorkspace?.id || 1
            // One pass over the client list instead of a filter per slot.
            const countByWs = new Map<number, number>()
            for (const c of hs.clients) {
                const id = c?.workspace?.id
                if (typeof id === "number") countByWs.set(id, (countByWs.get(id) ?? 0) + 1)
            }

            slots.forEach((ctx, i) => {
                const isActive = focusedId === i
                ctx.itemBox.set_css_classes(["wo-item", isActive ? "active" : "", navIdx === i ? "keyboard-focus" : ""])
                ctx.label.set_css_classes(["wo-label", isActive ? "active" : ""])

                const n = countByWs.get(i) ?? 0
                ctx.count.label = n === 0 ? t("overview.empty") : (n === 1 ? `1 ${t("overview.window")}` : `${n} ${t("overview.windows")}`)

                ctx.schematic(geom)
            })
        } catch (e) {
            console.error(`[WO-Error] syncAll failed: ${e}`)
        }
    }

    /**
     * The overview is the one surface whose tiles are big enough to be caught out
     * by geometry that is a few events old — and, since the tiles now hold real
     * captures, the one where being caught out means a squashed picture rather than
     * a rectangle nobody could measure by eye. Hyprland announces no resize and no
     * in-workspace move (`hs.readGeometry` has the full reasoning), so the layout is
     * re-asked for here, on every pass, instead of trusted from the cached list.
     *
     * It has to land BEFORE the captures are requested, not alongside them: the tile
     * size is what the capture is sized to, and a capture is taken once per open.
     * One hyprctl per pass, only while the overview is open.
     */
    const syncAllFresh = () => {
        hs.readGeometry().then(geom => { if (isOpen()) syncAll(geom) })
    }


    // Only re-sync while the overview is actually open. syncAll churns per-window
    // icon widgets and queue_draw()s every workspace schematic; running it on every
    // HyprlandState "changed" while the overview is CLOSED needlessly repaints the bar
    // window each event (a real cost when "changed" storms — see tech-debt #11). The
    // overview is re-synced on open via notify::island-mode below.
    const isOpen = () => status.island_mode === ISLAND_OVERVIEW
    const changedId = hs.connect("changed", () => { if (isOpen()) syncAllFresh() })

    status.connect("notify::island-mode", () => {
        if (!isOpen()) return
        // Thumbnails are captured once per open, never refreshed while the surface
        // sits there: each capture is a compositor render pass, and re-running them
        // on a timer is exactly the continuous GPU draw the animation budget bans.
        slots.forEach(ctx => ctx.refreshThumbs())
        syncAllFresh()
    })

    windowContent.connect("unrealize", () => {
        safeDisconnect(hs, changedId)
    })

    overview.append(list)

    // Lightweight repaint for arrow-key moves: only toggles the cursor class, no
    // schematic rebuild (unlike syncAll). add/remove so it never wipes `active`.
    const refreshKbFocus = () => {
        slots.forEach((ctx, i) => {
            if (navIdx === i) ctx.itemBox.add_css_class("keyboard-focus")
            else ctx.itemBox.remove_css_class("keyboard-focus")
        })
    }

    // Nav API consumed by the bar's key controller (see Bar.tsx). onOpen seeds the
    // cursor on the active workspace each time the overview is shown.
    ;(windowContent as any).onOpen = () => {
        navIdx = hs.focusedWorkspace?.id || 1
        refreshKbFocus()
    }
    // The monitor changed shape, so the equation `previewWidthFor` solved has a
    // different answer — and this panel is sized to land 8px from each screen
    // edge, so a stale card width is a panel WIDER THAN THE SCREEN it is centred
    // on (2560's 449px cards make a 2543px panel; on a 1920 display that is
    // 600px of overflow). Called by the bar through ActivityIsland.onMonitorResized;
    // this widget deliberately does not watch the monitor itself.
    ;(windowContent as any).onMonitorResized = () => {
        const w = previewWidthFor(gdkmonitor)
        if (w === previewWidth) return
        previewWidth = w
        slots.forEach(ctx => {
            ctx.itemBox.width_request = previewWidth + WO_CARD_CHROME
            ctx.setWidth(previewWidth)
        })
    }
    ;(windowContent as any).handleKey = (keyval: number): boolean => {
        if (keyval === Gdk.KEY_Escape) { status.island_mode = ""; return true }
        if (keyval === Gdk.KEY_Left)  { if (navIdx > 1)        { navIdx--; refreshKbFocus() } return true }
        if (keyval === Gdk.KEY_Right) { if (navIdx < WS_COUNT) { navIdx++; refreshKbFocus() } return true }
        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (navIdx >= 1) switchToWorkspace(navIdx)
            return true
        }
        // 1..5 (top row or keypad) jump straight to that workspace — same muscle
        // memory as the Super+N binds, no cursor dance.
        const digit = keyval >= Gdk.KEY_1 && keyval < Gdk.KEY_1 + WS_COUNT ? keyval - Gdk.KEY_0
                    : keyval >= Gdk.KEY_KP_1 && keyval < Gdk.KEY_KP_1 + WS_COUNT ? keyval - Gdk.KEY_KP_0
                    : 0
        if (digit) { switchToWorkspace(digit); return true }
        return false
    }

    // Morph handles for the bar's MorphRevealer (see common/MorphRevealer.ts):
    // - morphContent: the content layer (labels + schematics) that fades in
    //   over the last stretch of the capsule→island morph;
    // - morphGlass: the glass container — final rect of the interpolated
    //   squircle, and its `.glassArea` is suppressed mid-morph so the painted
    //   clone owns the shape;
    // - morphDots: the card dots the traveling ghosts land on.
    ;(windowContent as any).morphContent = overview
    ;(windowContent as any).morphGlass = overviewSquircle
    ;(windowContent as any).morphDots = cardDots

    // Load the capture shim now, while the shell is idle, so the first Super+Tab
    // does not pay the dynamic import on top of its captures.
    warmUpCapture()

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        syncAll()
        return GLib.SOURCE_REMOVE
    })

    return windowContent
}
