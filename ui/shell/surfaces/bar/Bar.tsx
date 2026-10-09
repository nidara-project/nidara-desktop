import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import app from "../../../lib/nidara-kit/platform/host"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { ScaleRevealer, OVERLAY_POP, fadeFloor } from "../../common/ScaleRevealer"
import { MorphRevealer } from "../../common/MorphRevealer"
import { createRegionStamper } from "../../common/VisibleRegion"
import { acquireFocusGrab, releaseFocusGrab } from "../../common/FocusGrab"
import Cairo from "gi://cairo"
import Gio from "gi://Gio"

import SquircleContainer, { GLASS_INSET, GLASS_SHADOW } from "../../common/SquircleContainer"
import { RADIUS, rowInsetFor } from "../../../lib/nidara-kit/platform/tokens"
import { BAR_GROUP_PAD, BAR_H, BAR_ITEM_GAP, BAR_MARGIN, CUSTOM_EXPANSION_ID, barEditSelected, barGroup, barItem, barOpen, barTooltip, setBarCustomAnchor, setBarEditSelected } from "./capsule"
import Theme from "../../core/ThemeManager"
import appService from "../../core/AppService"
import status from "../../core/Status"
import inputYield from "../../core/InputYield"
import widgetConfig from "../../core/WidgetConfig"
import regionConfig from "../../core/RegionConfig"
import { notifications } from "../../core/NotifService"
import registry, { widgetAvailable, watchWidgetAvailability } from "../../widgets/index"
import Tray from "./Tray"
import { SEARCH_KEY, defaultOrder, isBarHidden, knownTrayItems, moveBefore, parseBarKey, resolveOrder, savedBarOrder, setSavedBarOrder, trayKey, watchBarOrder, widgetKey } from "../../core/BarOrder"
import { SystemMenuOverlay } from "./SystemMenu"
import { AppTitle } from "./AppTitle"
import { statefulIcon } from "../../common/StatefulIcon"

// Overlay panels mounted on the bar window (avoids separate layer-shell surfaces)
import { ControlCenterWidget } from "../control-center/ControlCenter"
import NotificationCenter from "../control-center/NotificationCenter"
import Prism from "../prism/Prism"
import { NotificationPopupsWidget } from "../control-center/NotificationPopups"
import { ActivityIsland } from "../island/ActivityIsland"
import AppGridPanel from "../app-grid/AppGrid"
import { execAsync } from "../../../lib/process"
import { trackModeInk, trackNoInk, trackNoScrim, trackScrimRegion } from "../../../lib/nidara-kit/platform/material"
import { t } from "../../core/i18n"
import { formatFullDate } from "../../../lib/date-names"
import { barSettings, onBarSettingsChanged, resolveLauncherIcon, LAUNCHER_ICON_PRESETS, DEFAULT_LAUNCHER_ICON } from "./barState"
import { dockSideState, dockSettings, onDockSettingsChanged } from "../dock/state"
import { uiIcon } from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import compositor from "../../core/CompositorState"
import { safeDisconnect } from "../../core/signals"
import { BAR_ICON_SIZE, BAR_ITEM_PAD, BAR_TEXT_PAD } from "../../common/widget-kit"
import { registerGlassSurface, type GlassSurfaceHandle } from "../../common/AdaptiveGlass"

function SystemMenuIcon(): Gtk.Widget {
  // The same size and air as every other bar icon (it was 2px larger, with 1px less
  // air a side, until 2026-10-06: one icon size across the bar and the island).
  const img = new Gtk.Image({ pixel_size: BAR_ICON_SIZE, css_classes: ["bar-distro-icon"], margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD })

  const applyIcon = () => {
    // Fall back to the built-in mark for unknown presets (e.g. a stale "arch"
    // from before the rebrand) or a custom path that no longer exists.
    const path = resolveLauncherIcon(barSettings.launcherIcon || DEFAULT_LAUNCHER_ICON)
      ?? LAUNCHER_ICON_PRESETS[DEFAULT_LAUNCHER_ICON]
    img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path))
  }

  applyIcon()
  onBarSettingsChanged(applyIcon)

  const item = barItem({ child: img, ...barOpen(() => status.system_menu_open), onClick: () => status.toggleSystemMenu() })
  barTooltip(item, () => t("bar.tooltip.system-menu"))
  return item
}

/**
 * @param gridPeers windows that must stay clickable THROUGH the grab while the app
 *   grid is open — this monitor's dock, so its icons still launch with the grid up.
 *   A GETTER because the dock window is rebuilt on a position or auto-hide change.
 */
export default function Bar(gdkmonitor: Gdk.Monitor, gridPeers: () => Gtk.Window[] = () => []) {
  // The monitor's geometry is NOT captured here — it belongs to the stamper,
  // which re-reads it on `notify::geometry`. This surface was one of the two that
  // cached it and came out cut off on a live resolution change; the header of
  // common/VisibleRegion.ts has the 2x2 that proved it. `geo()` is live at every
  // use below, and this file must never hold on to the object it returns.
  const visibleRegion = createRegionStamper({
    monitor: gdkmonitor,
    tag: "bar",
    surface: () => win.get_native()?.get_surface() ?? null,
    rects: (box) => paintedRects(box),
    // The shim only applies a region on a real commit; every key change here
    // rides a geometry change that repaints anyway, so this just asks for the frame.
    onStamped: () => win.queue_draw(),
  })
  const geo = () => visibleRegion.geometry()
  const win = new Gtk.Window({
    name: "nidara-bar",
    application: app,
    css_classes: ["nidara-bar-window"],
    default_width: geo().width,
    default_height: geo().height, // Stay full height for CC/NC
    visible: false
  })
  win.set_opacity(0)

  const masterOverlay = new Gtk.Overlay({ valign: Gtk.Align.FILL, vexpand: true })
  const barBox = new Gtk.CenterBox({ css_classes: ["bar-centerbox"], height_request: BAR_H, valign: Gtk.Align.START, margin_start: BAR_MARGIN, margin_end: BAR_MARGIN })

  // ── Inline expansion panel ─────────────────────────────────────────────────
  const OVERFLOW_ID = "__overflow"
  // Transient expansion (tray context menus etc.): arbitrary content anchored to
  // an arbitrary bar widget, reusing the exact same capsule/fade/positioning.
  const CUSTOM_ID = CUSTOM_EXPANSION_ID
  let customContentBuilder: ((onClose: () => void) => Gtk.Widget) | null = null
  let customAnchor: Gtk.Widget | null = null
  // Horizontal anchoring of a custom expansion: "center" under the anchor (tray,
  // right side) vs "start" = panel's left edge flush with the anchor's left edge.
  // Start-align is for left-side capsules (AppTitle) whose centered panel would
  // otherwise overflow the left screen edge.
  let customAlign: "center" | "start" = "center"
  // How many ordered items fit, counted from the CLOCK side (see measureOverflow).
  // `null` = not measured yet, show them all.
  let fitFolded: number | null = null
  let fitUnfolded: number | null = null
  const capsuleRefs = new Map<string, Gtk.Widget>()
  // The halo of the row hover fill, from the GLASS, all four sides (the horizontal is
  // re-applied per panel below, since a flush panel takes it over). Default `n` — this
  // panel is a squircle like every other floating popup of the shell, so 6. See
  // rowInsetFor in tokens.ts.
  const expansionInner = new Gtk.Box({
      margin_top: rowInsetFor(RADIUS.lg) + GLASS_INSET, margin_bottom: rowInsetFor(RADIUS.lg) + GLASS_INSET,
      margin_start: rowInsetFor(RADIUS.lg) + GLASS_INSET, margin_end: rowInsetFor(RADIUS.lg) + GLASS_INSET,
  })
  // Pop animation (grow toward the anchor + fade) shared by every overlay —
  // the wrapper is the variable, so all the existing alignment/margin/region
  // code below operates on it transparently (animateLayout:false = Gtk.Bin).
  // NOT `perfect: true`, deliberately. Every other `perfect` in this file is a bar
  // CAPSULE — BAR_CAPSULE_H tall, where it is what clamps the corner to min(w,h)/2 and makes the
  // stadium. This panel is the only large surface that had inherited it, and at radius lg
  // it bought nothing but a circular corner: a different shape from the system menu, the
  // CC context menu and the CC detail island, which are the same family (`lg` = "any
  // floating popup of the shell"). A squircle also does not reach into its own corner, so
  // the halo above drops from 14 to 6 — the reason this panel read airy next to a menu
  // sitting right under it.
  const expansionCapsule = new ScaleRevealer(SquircleContainer({
      shadow: GLASS_SHADOW,
      child: expansionInner, gloss: true, useShellOpacity: true,
      borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, radius: RADIUS.lg,
      css_classes: ["bar-expansion-panel"],
  }), { ...OVERLAY_POP, pivot: "top-center" })   // grows down from its bar capsule
  expansionCapsule.valign = Gtk.Align.START
  expansionCapsule.halign = Gtk.Align.END
  // margin_top set below to PANEL_TOP.
  expansionCapsule.visible = false

  // unclipAtRest: the CC's tiles reach its edges, and their keyboard ring (GTK's,
  // an outline outside the tile) was cut there.
  const cc = new ScaleRevealer(ControlCenterWidget(gdkmonitor), { ...OVERLAY_POP, pivot: "top-right", unclipAtRest: true })
  const ncWidget = NotificationCenter()
  const nc = new ScaleRevealer(ncWidget, { ...OVERLAY_POP, pivot: "top-right" })
  // On Hyalo, the panes of both lie on ONE shadow under their glass, the size of the panel,
  // a little darker at its centre (owner, 2026-10-02): one per tile would show as patches
  // with and without shadow, a strip down to the bottom of the screen shaded what the panel
  // does not cover, and an even block looked like a dark panel. Hyalo lays it only where the
  // backdrop needs it; the sweep is the glass material's `scrimEdge` (nidara-kit glass-material.ts).
  // The bar's capsules cast none (owner, 2026-10-02: a halo, or a band hugging the bar, ran
  // over the windows). Declared FIRST: a capsule on the right also lies in the Control
  // Center's strip, and must not join it.
  trackNoScrim(barBox)
  trackScrimRegion(cc)
  trackScrimRegion(nc)
  const prism = Prism()
  const popups = NotificationPopupsWidget()
  // White text ALWAYS in the Control Center and the notifications, whatever is behind them
  // (owner, 2026-10-08): the reference's Control Center keeps white text in both modes and
  // over every wallpaper (glass-probe, `macos` set). Their legibility is the glass's tint and
  // the shadow under it.
  trackNoInk(cc)
  trackNoInk(nc)
  trackNoInk(popups)
  // The rest of this surface — the bar's capsules, the island, its menus — takes its ink from
  // the system MODE, like the dock (owner, 2026-10-09): by the backdrop each capsule turned on
  // its own, and over a wallpaper bright on one side only that end had dark text. Whether it
  // turns with the backdrop again — the whole bar at once, by majority, gradually — is for later.
  trackModeInk(barBox)
  const systemMenu = new ScaleRevealer(SystemMenuOverlay(), { ...OVERLAY_POP, pivot: "top-left" })
  // The Activity Island: the bar-center workspace capsule as a multi-purpose
  // morphing surface — capsule = compact state, expanded modes morph out of
  // it Dynamic-Island-style, one MorphRevealer per mode, all driven by
  // status.island_mode (see surfaces/island/ActivityIsland.tsx).
  //
  // The WHOLE island — the capsule, its chips and every mode — lives on THIS
  // surface, like every other panel (#708 point 3, owner 2026-10-06: the bar is
  // the one surface every panel hangs from). It had a layer of its own until then,
  // so that its modes could blur the bar's capsules under them; that is glass on
  // glass, which the reference material itself avoids. A mode that grows over the
  // bar's row takes the glass it covers out of the way instead (`coveredBy`
  // below, MorphRevealer's companions). One surface is also what lets the capsule
  // and a mode melt into one silhouette on Hyalo, which draws each surface's glass
  // on its own.
  const island = ActivityIsland(gdkmonitor)
  // The capsule's row. `center` holds the capsule and the indicator chips; the GROUP
  // centres on the monitor. It reuses `.bar-centerbox`, so the 4px top margin and the
  // BAR_H row height come from the same CSS rule as the bar's own row, and the capsule
  // lands exactly where the CenterBox would have put it.
  //
  // ⚠️ Centred, NOT a full-width row with the group centred inside it. This row sits
  // ABOVE barBox in masterOverlay, and GTK picks a Gtk.Box wherever its allocation is:
  // a full-width row would take every press meant for the left and right groups.
  //
  // NO spacing — the gap lives on each chip's own margin (see ActivityIsland). A
  // Gtk.Box reserves its spacing between every VISIBLE child, and a collapsed
  // Gtk.Revealer is still visible (it just measures 0), so spacing here would hold a
  // permanent 8px to the right of the capsule and leave it off-centre in an idle
  // session — the one state that must look exactly as it always has. A chip appearing
  // shifts the capsule off the monitor's axis, the cost of splitting the activities,
  // paid only while something is actually running.
  const center = new Gtk.Box({ css_classes: ["bar-center"], halign: Gtk.Align.CENTER })
  center.append(island.capsule)      // the island's compact state
  center.append(island.indicatorRow) // live activities that are NOT fronting it
  const islandRow = new Gtk.Box({ css_classes: ["bar-centerbox"], height_request: BAR_H, valign: Gtk.Align.START })
  islandRow.append(center)
  // The row RISES off the top of the screen while the bar's overflow is unfolded in
  // line (Status.bar_overflow_open), and comes back down when it folds. Paint-only:
  // the rise ends above the bar strip, which is always in both regions.
  const islandHost = new ScaleRevealer(islandRow, {
    durationIn: 220, durationOut: 150, scaleFrom: 1, animateLayout: false, pivot: "top-center",
    riseFrom: BAR_H + 8,
    opacityFloor: () => fadeFloor(Theme.barOpacity),
  })
  // ScaleRevealer clips to its box; the capsule's shadow spills below the row.
  islandHost.set_overflow(Gtk.Overflow.VISIBLE)
  islandHost.valign = Gtk.Align.START
  islandHost.halign = Gtk.Align.CENTER
  islandHost.showInstant()

  // The app grid — on this surface too since #708 point 3. It had a layer of its own
  // only because Hyprland charged a layer's blur by its BOX, and a grid inside a
  // monitor-sized host handed the whole box back while it was up. Hyalo charges per
  // declared shape. It opens centred on the monitor, never over the dock (the dock is
  // a surface of its own and stays clickable through the grab: `gridPeers`).
  //
  // Through CompositorState's `focusWorkspaceFromShell`, never `focusWorkspace`
  // directly — the switch has to happen with the grab already handed over.
  const grid = AppGridPanel(gdkmonitor, () => { status.app_grid_open = false },
                            (id) => compositor.focusWorkspaceFromShell(id))
  grid.widget.visible = false
  grid.widget.halign = Gtk.Align.CENTER
  grid.widget.valign = Gtk.Align.CENTER
  // Invisible below-bar button — dismisses any open overlay on outside click.
  // It deliberately does NOT cover the bar strip (margin_top set with the panel
  // geometry below): capsule clicks must reach the capsules so switching
  // surfaces is ONE click — Status's mutual exclusion closes whatever was open.
  // Shared by the compositor focus grab's `cleared` and by the bar-strip gesture —
  // the two mechanisms that mean "the user asked for this to go away". One body so
  // they cannot drift.
  const dismissOverlays = () => {
    if (status.cc_edit_mode) return   // don't close CC while in edit mode
    status.cc_open = false; status.nc_open = false; status.prism_open = false; status.system_menu_open = false
    status.island_mode = ""; status.bar_expanded_id = ""; status.bar_overflow_open = false
    // The app grid too, and it is NOT decoration: it lives on this surface, so a
    // press on the empty strip is INSIDE its grab, and the compositor will not
    // dismiss on it. Without this line the empty strip would be the one press on
    // screen that does nothing.
    status.app_grid_open = false
  }
  // An EMPTY stretch of the bar strip dismisses too, and only GTK can do it. The
  // compositor cannot: the strip belongs to the surface we whitelist, so a press
  // there is rightly "inside" the grab and accepted. (The catchers could not either,
  // for the opposite reason — one full-window button covering the strip would have
  // swallowed the capsule presses that make switching surfaces ONE click. Same dead
  // zone, unreachable by both mechanisms, which is why the gap existed at all.)
  // Every desktop's chrome dismisses on an empty click — menu bar, top bar, taskbar.
  //
  // ⚠️ It must NOT assume the capsule "claimed" the press. `SquircleContainer`'s
  // click gesture fires on PRESSED and deliberately does not claim the sequence — a
  // competing GestureDrag has to be able to cancel it (that is how banners swipe).
  // So this bubble-phase gesture runs IN ADDITION to the capsule's, not instead of
  // it, and dismissing unconditionally closed the panel the capsule had just opened
  // one event earlier: the CC, NC, system menu and search never appeared at all, and
  // a second press on a widget that toggles on RELEASE dismissed and then reopened.
  //
  // So it asks what it hit. Anything carrying a Gtk.Gesture is a control that owns
  // its own press; only the chrome between them dismisses. Asking the widget beats
  // keeping a list of "the bar's background" — a list rots silently every time the
  // bar grows one.
  //
  // On masterOverlay rather than barBox, because `.bar-centerbox` carries
  // `margin-top: 4px` and a CSS margin lies OUTSIDE the allocation: the band between
  // the capsules and the screen edge is not barBox at all, it is the overlay behind
  // it. Measured on the live shell (`query_ui`): the window is 40px tall and barBox
  // was y=8 h=32 x=8 (measured with the old 8px margin), so the same is true of the 8px at either
  // end. All of it is
  // inside the input region and all of it reads as bar.
  //
  // 🔑 It asks NO question about coordinates, deliberately. A `y < BAR_H` test would
  // have worked — GTK and layer-shell both speak logical pixels, so display scaling
  // does not move it — but it would have been the bar's height stated a fourth time,
  // and the one place that has no business knowing it. The overlay's own structure
  // already encodes what we mean: masterOverlay's child IS the bar, its overlays ARE
  // the panels. So walk up from what the press hit and read that off. A press is
  // ours to dismiss on when it reached this window and landed neither on a control
  // nor on a panel — true wherever the bar sits and whatever it measures.
  const handlesPresses = (w: Gtk.Widget) => {
    const cs = w.observe_controllers()
    for (let i = 0, n = cs.get_n_items(); i < n; i++)
      if (cs.get_item(i) instanceof Gtk.Gesture) return true
    return false
  }
  const barStripClick = new Gtk.GestureClick()
  barStripClick.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
  // On PRESS, not release: that is when the compositor dismisses on the outside
  // path, and the two gestures should not feel different.
  barStripClick.connect("pressed", (_g: any, _n: number, x: number, y: number) => {
    if (!status.isAnyOverlayOpen) return
    // ⚠️ BOUNDED TO THE BAR ROW — and not for layout reasons. Under a focus grab the
    // compositor CLAMPS pointer focus to the grabbed surface, so a press aimed at the
    // desktop is delivered to THIS window, at its real coordinates, BEFORE the grab is
    // cleared. Unbounded, "the press hit no control of ours" is true of every outside
    // click, and we would dismiss the panel ourselves. That looks identical — the panel
    // closes — but it robs the compositor of the dismissal and of the refocus that comes
    // with it, so the window under the pointer never gets the keyboard back (measured).
    // Taken from barBox rather than BAR_H so it tracks the row instead of restating its
    // height; unmeasurable means stand down.
    const [okBar, barRect] = barBox.compute_bounds(masterOverlay)
    if (!okBar || y >= barRect.get_y() + barRect.get_height()) return
    const hit = masterOverlay.pick(x, y, Gtk.PickFlags.DEFAULT)
    if (!hit) return
    // The island's chips while a mode is open: faded to nothing (MorphRevealer's
    // companions), but still laid out where they were. Nothing is there to press.
    if (island.indicatorRow.opacity === 0 && (hit === island.indicatorRow || hit.is_ancestor(island.indicatorRow))) {
      dismissOverlays(); return
    }
    // `owner` ends as the masterOverlay child the press belongs to, or null when it
    // landed on the overlay's own background (the bands around barBox).
    let owner: Gtk.Widget | null = null
    for (let w: Gtk.Widget | null = hit; w && w !== masterOverlay; w = w.get_parent()) {
      if (handlesPresses(w)) return    // a control owns this press
      owner = w
    }
    if (owner === null || owner === barBox || owner === islandHost) dismissOverlays()
  })
  masterOverlay.add_controller(barStripClick)

  masterOverlay.set_child(barBox)
  // Stacking is insertion order. The capsule's row is part of the bar, so it goes
  // first; the island's modes and the app grid last, above every other panel (they
  // were layers above this one until #708 point 3).
  masterOverlay.add_overlay(islandHost)
  masterOverlay.add_overlay(expansionCapsule)  // below the major overlays
  masterOverlay.add_overlay(cc); masterOverlay.add_overlay(nc); masterOverlay.add_overlay(prism); masterOverlay.add_overlay(popups); masterOverlay.add_overlay(systemMenu)
  for (const r of island.revealers) masterOverlay.add_overlay(r)
  masterOverlay.add_overlay(grid.widget)

  cc.valign = Gtk.Align.START; cc.halign = Gtk.Align.END
  nc.valign = Gtk.Align.START; nc.halign = Gtk.Align.END
  prism.valign = Gtk.Align.CENTER; prism.halign = Gtk.Align.CENTER
  popups.valign = Gtk.Align.START; popups.halign = Gtk.Align.END
  // (Island revealers set their own top-anchored/centered alignment — see
  // ActivityIsland's registerMode.)
  // The wrapper MUST be aligned (its root keeps top-left margins inside): an
  // unaligned overlay child FILLs the whole window, and since the input region is
  // unioned from these allocations that stamps a region covering the screen — the
  // compositor then reads every press as INSIDE the grab and never dismisses.
  systemMenu.valign = Gtk.Align.START; systemMenu.halign = Gtk.Align.START

  // ── Panel geometry ──────────────────────────────────────────────────────
  // Derived from the bar height and the dock's actual footprint (dock size is
  // user-configurable) instead of hardcoded magic numbers.

  const PANEL_TOP = BAR_H + 8   // gap below the bar (8: same rhythm as the side gap)
  const SAFETY = 28
  const DOCK_VPAD = 20           // dock padding around its icons

  // Vertical space the dock reserves at the bottom (0 when docked to a side —
  // there it consumes horizontal space, handled by syncPanelMargins instead).
  const dockBottomFootprint = () =>
    dockSettings.position === 'bottom'
      ? dockSettings.iconSize + dockSettings.screenGap + DOCK_VPAD
      : 0

  // Side gap: panels sit flush with the bar capsules (BAR_MARGIN from the screen
  // edge) instead of the old 16 — the capsule alignment is a stronger visual
  // reference than the tiling grid underneath (which is the same number anyway).
  const SIDE_GAP = BAR_MARGIN

  // The CC and the NC are panels with their own margin (ControlCenter.tsx, CC_PANEL_PAD):
  // the PANEL hangs `BAR_MARGIN` below the bar, as a window does, and its content lands
  // where the margin puts it. The other panels have no margin of their own yet, so
  // they keep 8.
  cc.margin_top = BAR_H + BAR_MARGIN
  nc.margin_top = BAR_H + BAR_MARGIN
  expansionCapsule.margin_top = PANEL_TOP   // 8 below the bar: its glass starts there, it has no panel margin
  systemMenu.margin_top = PANEL_TOP         // Bar owns the menu geometry (see syncPanelMargins)
  const syncPanelMargins = () => {
    const end = SIDE_GAP + (dockSideState.position === 'right' ? dockSideState.width : 0)
    cc.margin_end = end
    popups.margin_end = end
    // The NC's scrollbar lane lives inside its own right margin now (NotificationCenter,
    // LANE), so it hangs where the CC does and their cards line up. (Until 2026-09-30 it
    // was pulled right by the lane to reach the capsule's edge.)
    nc.margin_end = end
    // Mirror on the left for the system menu: the dock window stacks ABOVE the
    // bar window, so without this shift a left dock covers the menu.
    systemMenu.margin_start = SIDE_GAP + (dockSideState.position === 'left' ? dockSideState.width : 0)
  }
  syncPanelMargins()
  dockSideState.subscribe(syncPanelMargins)

  prism.margin_top = 0
  popups.margin_top = PANEL_TOP

  // Panels are CONTENT-sized, capped to the bar→dock budget — never forced
  // taller. The old approach (height_request on the wrappers) inflated the
  // panels' invisible bounds past their visible content, so that dead area went
  // into the input region and the compositor read presses there as inside the
  // grab — outside-clicks below the CC's Edit pill / the NC's last card didn't
  // dismiss. (In the catcher era the same inflation stole those clicks from the
  // catcher by sitting above it in the overlay stack: same bug, both mechanisms.
  // It never capped anything anyway: a size request can only RAISE a minimum.)
  // NC takes the budget via its scroller's max_content_height (content-sized
  // until the list overflows, then it scrolls); CC needs no cap — its content
  // maxes out at the fixed 8-row board. Reactive to dock size.
  const applyPanelHeights = () => {
    const maxH = geo().height - BAR_H - dockBottomFootprint() - SAFETY
    ;(ncWidget as any).setMaxHeight?.(maxH)
  }
  applyPanelHeights()
  onDockSettingsChanged(applyPanelHeights)

  // Our ownership token for the compositor focus grab that IS this window's
  // modality (0 when we hold none; see syncKeyboardMode). A token and not a boolean
  // because the ISLAND competes for the same single slot — see common/FocusGrab.ts.
  // Note what it buys the input region: the compositor dismisses on an outside press
  // by itself, so the region only ever describes what we PAINT. Covering the desktop
  // to notice that press is exactly the work the protocol deleted.
  let barGrabToken = 0
  let layerShellReady = false
  // The bar's row is out of sight while the app grid is up over a fullscreen window
  // (`liftForGrid`): the surface is on screen for the grid alone.
  let rowHidden = false

  const updateInputRegion = () => {
      const surface = win.get_native()?.get_surface()
      if (!surface) return
      const region = new Cairo.Region()

      // Yielded for an agent action: an EMPTY region, so a synthetic click lands on
      // the app under us instead of on Prism's backdrop. Dropping the grab alone is
      // not enough — that only stops Hyprland routing the pointer here regardless of
      // the region; the region itself still covers the screen while an overlay is up.
      if (inputYield.active) {
          if (surface.set_input_region) { surface.set_input_region(region); win.queue_draw() }
          // A yield changes who gets the CLICKS, not what is painted — the bar is
          // still on screen, so its blur region is computed exactly the same way.
          // (The island needed this same call on its own early-return branch.)
          updateVisibleRegion()
          return
      }


      // Bar strip (40px). It holds the island's capsule and chips too, which is why
      // they need no rects of their own: a constant cannot fail to measure. (On a
      // surface of their own they did, and a capsule that measured nothing for one
      // stamp took no input until something re-stamped — 33 minutes once.)
      // Not while the row is hidden for the app grid over a fullscreen window
      // (`liftForGrid`): the strip would take the top of that window's clicks.
      // @ts-ignore
      if (!rowHidden) region.unionRectangle({ x: 0, y: 0, width: Math.round(geo().width), height: BAR_H })

      // ⚠️ NOTHING below the bar strip goes into this region, and that is the
      // dismissal mechanism working, not a gap in it. While an overlay was open
      // this used to union the whole monitor below BAR_H — the catcher region,
      // there to be clicked so we could notice the press. Under the compositor
      // grab it would do the exact opposite of its old job: the press that
      // dismisses has to land OUTSIDE our surface, and a region covering the
      // desktop makes it land on us, where the grab accepts it and nothing
      // dismisses at all. Deleted 2026-08-16; it had been sitting behind an
      // `if (false)` since the grab landed (#94), long enough for a later change
      // to update the geometry inside a block that could not run (#140).
      const addWidgetToRegion = (widget: Gtk.Widget) => {
          if (!widget.get_visible()) return
          const alloc = widget.get_allocation()
          if (alloc.width <= 1 || alloc.height <= 1) return
          // @ts-ignore
          region.unionRectangle({ x: Math.round(alloc.x), y: Math.round(alloc.y), width: Math.round(alloc.width), height: Math.round(alloc.height) })
      }
      addWidgetToRegion(cc); addWidgetToRegion(nc); addWidgetToRegion(prism); addWidgetToRegion(systemMenu)
      addWidgetToRegion(expansionCapsule)
      // An island mode, from the layout pass that gives it an allocation (its
      // `onAllocated`, wired with every other panel's below). A closing one is still
      // visible until its last tick, like the panels above.
      for (const r of island.revealers) addWidgetToRegion(r)
      // The grid only while it is OPEN, not for the 150ms it takes to shrink away:
      // the click that closed it is the last one it takes.
      if (status.app_grid_open) addWidgetToRegion(grid.widget)

      // Every region here must match its panel EXACTLY: nothing backs it up, so a
      // rect that is short eats nothing and a rect that is long steals the press
      // the compositor needs to see outside us. CC edit mode is where that is
      // hardest — toggling it resizes the CC, and get_allocation() lags a
      // layout pass behind. measure() reflects the resize immediately
      // (IslandGrid flips cc_edit_mode AFTER its rebuild for exactly this),
      // so union the measured natural height too: the grown grid + Done pill
      // are clickable in this very frame, not one stamp later.
      if (status.cc_edit_mode && cc.get_visible()) {
          const alloc = cc.get_allocation()
          if (alloc.width > 1) {
              const [, natH] = cc.measure(Gtk.Orientation.VERTICAL, alloc.width)
              // @ts-ignore
              region.unionRectangle({ x: Math.round(alloc.x), y: Math.round(alloc.y), width: Math.round(alloc.width), height: Math.round(Math.max(alloc.height, natH)) })
          }
      }

      // Notification banners. `popups` is a direct overlay child (aligned
      // top-right, content-sized), so its allocation is already window-relative
      // and tightly wraps the whole live banner stack — one rect covers every
      // banner, and it self-skips when empty (natural height 0). Adding the box
      // rather than iterating its ScaleRevealer children also fixes a latent
      // coordinate bug: a child's get_allocation() is relative to the box, not
      // the window, so those rects landed in the wrong place. The stamp is
      // re-run on every stack change via popups.onStackChanged (wired below) —
      // without a panel open the region is otherwise just the 40px bar strip,
      // and clicks would pass straight through the banner.
      addWidgetToRegion(popups)

      if (surface.set_input_region) {
          surface.set_input_region(region)
          // Wayland input regions are double-buffered: they only take effect on
          // the surface's next commit. Stamps riding a visual change commit with
          // that frame, but a stamp between frames (the deferred edit-mode
          // re-stamp below) would otherwise sit pending until some incidental
          // repaint — queue one so the region applies now.
          win.queue_draw()
      }
      updateVisibleRegion()
  }

  // ── Blur cost: what this surface actually PAINTS ───────────────────────────
  //
  // The last of the three monitor-sized layers to declare its visible region
  // (`references/tech-debt.md` §46). Hyprland charges layer blur by the
  // surface's BOX, not by the pixels that end up visible, so this window — full
  // height because every overlay lives INSIDE it (commandment #5) — taxes every
  // repaint of every window on screen, all day, to show a 48px strip. The rect
  // it declares at rest is 2560x64 — 4% of its own box.
  //
  // It declares `strip + whatever else is painting`, one rect each. The first
  // version handed the WHOLE SURFACE back for any open panel, which was the
  // island's rule borrowed wholesale — and it meant the saving evaporated in
  // exactly the states that cost the most: five panels live here (CC, NC, Prism,
  // system menu, the expansion capsule) plus the banners, so "something is open"
  // is most of any interaction. These panels are `ScaleRevealer` + OVERLAY_POP
  // with `animateLayout: false`, so the allocation is the FINAL one from the first
  // laid-out frame and the 0.97→1.0 pop paints INSIDE it. The island's modes are
  // the same: the morph is snapshot-time only (opacity and a queued draw, never a
  // relayout), and the shape it paints travels between the capsule — inside the
  // strip — and the mode's own box, whose top is the capsule's. Every frame of it
  // lies inside the two rects already declared.
  //
  // 🔑 The audit that mattered was not "what paints below the strip" but "can
  // the stamp arrive LATE". An input region that lags by a frame costs a late
  // click; a visible region that lags by a frame is a frame NOT PAINTED. What
  // makes per-panel rects safe is `onAllocated`, which fires from inside
  // `size_allocate` — i.e. BEFORE the snapshot of the same frame — so a panel's
  // rect is always stamped by the very frame that first paints it, however stale
  // the bounds were when the open path stamped. The one exception is the
  // notification banners, whose stamp is deferred to an idle ON PURPOSE so it
  // reads a settled allocation — correct for input, fatal here. That path gets
  // its own immediate hook (`onContentAppeared` below) and is the only thing
  // that still clears the region outright, for as long as the stack is unsettled.
  //
  // ⚠️ Anything unmeasurable clears (whole surface), never a small rect: content
  // outside the region is NOT DRAWN (hard GL scissor), so the failure mode of
  // guessing is a panel that never appears.

  // How far a panel's glass can reach past its own allocation. Small on purpose
  // and NOT the app grid's 48: every panel here is wrapped in a ScaleRevealer,
  // which is `overflow: HIDDEN`, so whatever a panel paints outside its
  // allocation is already clipped by GTK before the compositor sees it — the pad
  // is for rounding and the squircle's soft edge (which lives INSIDE the rect,
  // GLASS_INSET), not for a shadow that escapes. The banners are the one
  // exception and are handled below.
  const PANEL_PAD = 16
  // Vertical is where the whole gain is (1440 → 64), so the pad only has to
  // cover the capsules' soft Cairo edge and any rounding, not a guess-margin.
  // Horizontally we keep the full monitor width: the bar spans it anyway, and
  // paying for pixels that are already the surface's own width buys immunity to
  // every capsule that changes size on its own (window title, clock, tray).
  const BLUR_PAD_Y = 16
  // The app grid's squircle has its soft edge and its drop shadow outside its
  // allocation — the pad it declared on its own surface, kept.
  const GRID_PAD = 48

  // The banner stack is settled (its box's allocation describes every banner in
  // it). False between a banner being appended and the deferred stamp that
  // follows its grow-in — the window in which the box's bounds are a lie.
  let popupsSettled = true
  // Adaptive glass (#673): one handle per registered surface, filled once they all
  // exist (below the island's mount); read by the reveal and settle hooks here.
  const glassHandles = new Map<Gtk.Widget, GlassSurfaceHandle>()

  type BlurRect = { x: number, y: number, width: number, height: number }

  // Every rectangle this window paints right now, or `null` when something is
  // painting that cannot be measured yet (→ the caller hands the surface back).
  //
  // `box` is the surface's own extent, handed in by the stamper — which is also
  // the only way this function can know the monitor's width, and deliberately so:
  // the numbers used to come from a `monGeo` captured at build time, and a bar
  // that kept declaring 2560 on a 1920 screen was half of the live-resolution bug
  // (common/VisibleRegion.ts). Rects go out UNCLIPPED; the stamper intersects.
  //
  // Walked off masterOverlay rather than hand-listed, so a panel mounted here
  // later is covered by construction instead of by someone remembering. Two
  // children are not panels:
  //  · barBox — the strip itself, i.e. the thing the first rect describes.
  //  · popups — a container, so it is `visible` whether or not it holds a
  //    banner. Its CHILDREN are the content, hence the emptiness test.
  // The island's row (`islandHost`) is a child like any other, and its rect lies
  // inside the strip's.
  // Everything else answers with `tickId` as well as `get_visible()`: a panel
  // closing is still visible until its final tick, and dropping its rect one
  // tick early would scissor away the tail of its own close animation.
  const paintedRects = (box: BlurRect): BlurRect[] | null => {
      // The strip's own extent. Measured rather than hardcoded (the 4px top
      // margin is CSS, `.bar-centerbox`), but floored at PANEL_TOP so this is
      // valid BEFORE the first layout pass too — that is what lets the very
      // first stamp declare a rect instead of giving up until an overlay opens.
      // PANEL_TOP is the right floor by construction: it is where every panel in
      // this window is positioned to start.
      let bottom = PANEL_TOP
      const [okBar, bar] = barBox.compute_bounds(masterOverlay)
      if (okBar) bottom = Math.max(bottom, bar.get_y() + bar.get_height())
      const rects: BlurRect[] = [
          { x: 0, y: 0, width: box.width, height: Math.round(bottom) + BLUR_PAD_Y },
      ]

      for (let c = masterOverlay.get_first_child(); c; c = c.get_next_sibling()) {
          if (c === barBox) continue
          // A banner's swipe-to-dismiss is the ONE thing in this window that
          // paints outside its own box on purpose: ScaleRevealer flips itself to
          // `overflow: VISIBLE` while swiping and flings the card clear off
          // screen, so GTK stops clipping for us exactly there. Full monitor
          // width for the band retires that whole class of bug for a strip of
          // pixels — the same trade the strip itself makes.
          const fullWidth = c === popups
          if (fullWidth) {
              if (!popups.get_first_child()) continue
              // Appended-but-not-grown-in: the box's bounds describe the previous
              // stack, and a banner outside the region is a banner that is never
              // drawn. Nothing to do but pay full price until it settles.
              if (!popupsSettled) return null
          } else if (!(c.get_visible() || ((c as any).tickId ?? null) !== null)) continue

          const [ok, b] = c.compute_bounds(masterOverlay)
          if (!ok) return null
          // Presented this frame, not laid out yet — the same "unmeasurable"
          // state `boundsOf` guards on the island, and the same answer: hand the
          // whole surface back rather than describe a panel that has no size.
          if (b.get_width() <= 1 || b.get_height() <= 1) return null
          let height = b.get_height()
          // CC edit mode is the one open state whose allocation is known to lag
          // (IslandGrid flips cc_edit_mode AFTER its rebuild — see the matching
          // union in updateInputRegion). Growing is the harmless direction here,
          // so take whichever is bigger rather than reasoning about which frame
          // this is.
          if (c === cc && status.cc_edit_mode && b.get_width() > 1) {
              const [, natH] = cc.measure(Gtk.Orientation.VERTICAL, Math.round(b.get_width()))
              height = Math.max(height, natH)
          }
          const pad = c === grid.widget ? GRID_PAD : PANEL_PAD
          rects.push(fullWidth
              ? { x: 0, y: Math.round(b.get_y()) - pad, width: box.width, height: Math.round(height) + pad * 2 }
              : { x: Math.round(b.get_x()) - pad, y: Math.round(b.get_y()) - pad,
                  width: Math.round(b.get_width()) + pad * 2, height: Math.round(height) + pad * 2 })
      }
      return rects
  }

  // At rest this is the single strip rect, measured on the real shell
  // (2560x1440@144, damage 1600x700 landing BELOW the strip, 3 shuffled rounds,
  // dock and island both declaring in either branch): 19.3% → 12.4% GPU, i.e.
  // −6.9 points for a 2560x64 rect. Same order as the dock (−7.0) and the
  // island (−7.2). Dedupe, clip and the Wayland call live in the stamper.
  const updateVisibleRegion = () => visibleRegion.stamp()

  // Banners appear/vanish independently of the overlay open/close events that
  // drive updateInputRegion, so the popups widget calls back here whenever its
  // stack settles (banner grown in, or dismissed) to re-stamp the region. It is
  // also what re-arms the blur region: settled means the box's bounds finally
  // describe every banner in it.
  // Settled is also when a banner can be measured for the adaptive glass (#673).
  ;(popups as any).onStackChanged = () => {
    popupsSettled = true; updateInputRegion()
    glassHandles.get(popups)?.remeasure()
  }
  // Every panel re-stamps from the layout pass that gave it an allocation. The
  // synchronous stamp in syncOverlays() cannot see a panel that was revealed in
  // the same turn — get_allocation() is a layout pass behind, and for a panel
  // opening for the FIRST time there is no previous allocation to be stale about,
  // so its rect is missing outright. Under the compositor focus grab that is not a
  // late click: the press misses our surface, the compositor sees a surface outside
  // the whitelist, and the panel dismisses as you click into it. (Before the grab
  // the full-screen catcher rect covered the panel by accident, which is why this
  // never showed.)
  //
  // Walked off masterOverlay for the same reason paintedRects() is: this hook is
  // now what keeps a panel's BLUR rect honest as well (it fires from inside
  // size_allocate, so the rect lands on the frame that paints the new geometry),
  // and a hand-list that misses a panel added later would not fail with a late
  // click any more — it would fail with a panel that is not drawn. `popups` is
  // excluded: it is a plain Gtk.Box with no such hook, and its stamps come from
  // the two callbacks around this one.
  for (let c = masterOverlay.get_first_child(); c; c = c.get_next_sibling())
    if (c !== barBox && c !== popups) (c as any).onAllocated = updateInputRegion
  // …and the visible region can NOT wait for that idle: a banner is appended in
  // one turn and painted in the next frame, so a region still describing the bar
  // strip (or the previous, shorter stack) would scissor it away entirely. This
  // hook fires synchronously on append — it only ever CLEARS, which is the safe
  // direction, and the deferred stamp above still owns the input region.
  ;(popups as any).onContentAppeared = () => { popupsSettled = false; updateVisibleRegion() }

  // Unified overlay pop (ScaleRevealer: subtle grow + fade, GTK-side). On close
  // the wrapper hides itself when the animation completes and THEN refreshes the
  // layer-shell input region, so the panel never keeps catching clicks.
  //
  // Once OPEN and still, the panel is measured for the adaptive glass (#673): only
  // then do the capture and the offscreen render describe the same frame.
  const popToggle = (pop: ScaleRevealer | MorphRevealer) => (open: boolean) =>
      pop.reveal(open, () => { if (!open) updateInputRegion(); else glassHandles.get(pop)?.remeasure() })
  const setCCVisible = popToggle(cc)
  const setNCVisible = popToggle(nc)
  const setSystemMenuVisible = popToggle(systemMenu)
  const setPrismVisible = popToggle(prism)

  // ── Keyboard inside the panels ─────────────────────────────────────────────
  // The grab already hands this window the keyboard for any open panel (barModal);
  // what was missing is a widget to receive it. Without one a key goes nowhere, and
  // the panel can only be driven with the pointer. So an opening panel moves focus
  // onto its first control — also when the pointer opened it: GTK shows no ring
  // for that (focus-visible is off after a click), yet Tab now starts from inside
  // the panel instead of from nothing.
  //
  // Idle, not immediate: reveal() makes the panel visible in this turn, but a
  // widget is only focusable once it is MAPPED, which is the next main-loop pass.
  // `set_focus(null)` first, because child_focus(TAB_FORWARD) CONTINUES from the
  // current focus — a control left focused in a panel that closed would make the
  // new one start after it instead of at its top.
  const focusPanel = (panel: Gtk.Widget) => {
    const fromKeyboard = status.keyboardEntry
    status.keyboardEntry = false
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!panel.get_mapped()) return GLib.SOURCE_REMOVE
      win.set_focus(null)
      panel.child_focus(Gtk.DirectionType.TAB_FORWARD)
      // See Status.keyboardEntry: the Super+… that opened us never reached GTK.
      if (fromKeyboard) win.set_focus_visible(true)
      return GLib.SOURCE_REMOVE
    })
  }
  // Tab and the arrows stay INSIDE an open panel. GTK moves focus across the whole
  // window, and this window is the bar: past a panel's last control Tab walked on
  // into the tray icons (measured 2026-09-27), behind a panel that was still open
  // and still holding the keyboard. Tab/Shift+Tab wrap around; an arrow with nowhere
  // left to go stops. BUBBLE, so a control that uses an arrow itself (a slider, an
  // entry's caret) has it first and this only sees the keys it let through — and
  // still before the window's own move-focus binding, which is the one that escapes.
  const FOCUS_KEYS: Record<number, Gtk.DirectionType> = {
    [Gdk.KEY_Tab]: Gtk.DirectionType.TAB_FORWARD, [Gdk.KEY_KP_Tab]: Gtk.DirectionType.TAB_FORWARD,
    [Gdk.KEY_ISO_Left_Tab]: Gtk.DirectionType.TAB_BACKWARD,
    [Gdk.KEY_Up]: Gtk.DirectionType.UP, [Gdk.KEY_Down]: Gtk.DirectionType.DOWN,
    [Gdk.KEY_Left]: Gtk.DirectionType.LEFT, [Gdk.KEY_Right]: Gtk.DirectionType.RIGHT,
  }
  const keepFocusIn = (panel: Gtk.Widget) => {
    const keys = new Gtk.EventControllerKey()
    keys.connect("key-pressed", (_c: any, keyval: number, _code: number, state: Gdk.ModifierType) => {
      let dir = FOCUS_KEYS[keyval]
      if (dir === undefined) return false
      if (dir === Gtk.DirectionType.TAB_FORWARD && (state & Gdk.ModifierType.SHIFT_MASK)) dir = Gtk.DirectionType.TAB_BACKWARD
      // We swallow the key GTK would have used to turn the ring on — do it here.
      win.set_focus_visible(true)
      if (panel.child_focus(dir)) return true
      if (dir === Gtk.DirectionType.TAB_FORWARD || dir === Gtk.DirectionType.TAB_BACKWARD) {
        win.set_focus(null)
        panel.child_focus(dir)
      }
      return true
    })
    panel.add_controller(keys)
  }
  keepFocusIn(cc); keepFocusIn(nc); keepFocusIn(systemMenu); keepFocusIn(expansionCapsule)

  // ── The keyboard walk of the bar (Super+Ctrl+B, Status.bar_keyboard) ───────────
  // The focus lands on the bar's first item, ←/→ and Tab move along
  // it (wrapping), Enter/Space/↓ open the item's panel (barItem), Esc closes that panel
  // and returns to the item, a second Esc leaves. The grab that carries the keys is
  // barModal's, which counts the walk. Not in edit mode: its ←/→ MOVE an item.
  const barKeys = new Gtk.EventControllerKey()
  barKeys.connect("key-pressed", (_c: any, keyval: number, _code: number, state: Gdk.ModifierType) => {
    if (!status.bar_keyboard || status.bar_edit_mode) return false
    let dir = FOCUS_KEYS[keyval]
    if (dir === undefined || dir === Gtk.DirectionType.UP || dir === Gtk.DirectionType.DOWN) return false
    if (dir === Gtk.DirectionType.TAB_FORWARD && (state & Gdk.ModifierType.SHIFT_MASK)) dir = Gtk.DirectionType.TAB_BACKWARD
    win.set_focus_visible(true)
    if (barBox.child_focus(dir)) return true
    // Past either end: wrap, like a menu bar. A ← at the first item goes to the last.
    win.set_focus(null)
    const back = dir === Gtk.DirectionType.LEFT || dir === Gtk.DirectionType.TAB_BACKWARD
    barBox.child_focus(back ? Gtk.DirectionType.TAB_BACKWARD : Gtk.DirectionType.TAB_FORWARD)
    return true
  })
  barBox.add_controller(barKeys)

  // The item the walk was on when a panel took the focus — where Esc brings it back.
  // Tracked off the window's focus rather than at each activation: search opens Prism,
  // a widget opens its expansion, the logo the system menu, and each would need a hook.
  let walkItem: Gtk.Widget | null = null
  win.connect("notify::focus-widget", () => {
    const f = win.get_focus()
    if (status.bar_keyboard && f && (f === barBox || f.is_ancestor(barBox))) walkItem = f
  })
  const anyBarPanel = () => status.cc_open || status.nc_open || status.system_menu_open
    || status.prism_open || status.bar_expanded_id !== ""
  // Only an Esc goes BACK to the walk. A panel that closed because something was
  // done in it (Prism launched an app, a CC row opened Settings) ends the walk, as a
  // menu does once an item is chosen: otherwise the grab stays on the bar and
  // the window that just opened gets none of the keys. `escPending` is set in the
  // CAPTURE phase — before any Esc handler closes a panel, whichever panel's it is —
  // and cleared once the turn is over.
  let escPending = false
  const escWatch = new Gtk.EventControllerKey()
  escWatch.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  escWatch.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval !== Gdk.KEY_Escape) return false
    escPending = true
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { escPending = false; return GLib.SOURCE_REMOVE })
    return false
  })
  win.add_controller(escWatch)
  const backToWalk = () => {
    if (!status.bar_keyboard || anyBarPanel()) return
    if (!escPending) { status.bar_keyboard = false; return }
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (status.bar_keyboard && walkItem?.get_mapped()) walkItem.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  }
  for (const prop of ["cc-open", "nc-open", "system-menu-open", "prism-open", "bar-expanded-id"])
    status.connect(`notify::${prop}`, backToWalk)

  status.connect("notify::bar-keyboard", () => {
    syncKeyboardMode()
    updateInputRegion()
    if (!status.bar_keyboard) { walkItem = null; if (!barModal()) win.set_focus(null); return }
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!status.bar_keyboard) return GLib.SOURCE_REMOVE
      win.set_focus(null)
      barBox.child_focus(Gtk.DirectionType.TAB_FORWARD)
      // The Super+Ctrl+B went to Hyprland, not to us (see Status.keyboardEntry).
      win.set_focus_visible(true)
      return GLib.SOURCE_REMOVE
    })
  })

  status.connect("notify::cc-open", () => { if (status.cc_open) focusPanel(cc) })
  status.connect("notify::nc-open", () => { if (status.nc_open) focusPanel(nc) })
  status.connect("notify::system-menu-open", () => { if (status.system_menu_open) focusPanel(systemMenu) })

  // Esc closes whichever of these panels is open. BUBBLE phase, so a focused control
  // that has its own use for Esc (an entry clearing itself, a dropdown closing) is
  // asked first. Prism, the bar's edit mode and the CC's edit mode each keep their
  // own Esc — edit mode's, in particular, means "Done", not "close the panel".
  const panelKeys = new Gtk.EventControllerKey()
  panelKeys.connect("key-pressed", (_c: any, keyval: number) => {
    if (keyval !== Gdk.KEY_Escape || status.bar_edit_mode || status.cc_edit_mode) return false
    if (!(status.cc_open || status.nc_open || status.system_menu_open
          || status.bar_expanded_id !== "" || status.bar_overflow_open)) {
      // No panel: an Esc in the keyboard walk leaves it (the SECOND Esc, after the one
      // that closed the item's panel and put the focus back on the item).
      if (!status.bar_keyboard) return false
      status.bar_keyboard = false
      return true
    }
    status.cc_open = false; status.nc_open = false; status.system_menu_open = false
    status.bar_expanded_id = ""; status.bar_overflow_open = false
    return true
  })
  win.add_controller(panelKeys)

  const syncOverlays = () => {
    // Before the visibility/region work below, because the region is computed from
    // whether the grab took (see syncKeyboardMode). It no-ops until layer-shell is
    // up, which is why it is safe from the construction-time call further down.
    syncKeyboardMode()
    setCCVisible(status.cc_open); setNCVisible(status.nc_open); setPrismVisible(status.prism_open); setSystemMenuVisible(status.system_menu_open)
    // Update immediately — reveal() flips visibility synchronously on open, so
    // the region calculation is accurate without waiting for a layout pass; the
    // post-close refresh happens in each toggle's reveal callback.
    updateInputRegion()
  }

  // The island's modes: the same reveal contract as the panels above. A closing mode
  // hands the capsule back, and the bar row re-decides its glass with it.
  const syncIslandModes = () => {
    island.sync((r, open) => r.reveal(open, () => {
      if (!open) updateInputRegion()
      glassHandles.get(open ? r : islandHost)?.remeasure()
    }))
    updateInputRegion()
  }
  status.connect("notify::cc-open", syncOverlays); status.connect("notify::nc-open", syncOverlays); status.connect("notify::system-menu-open", syncOverlays)
  // Toggling edit mode RESIZES the CC (content-height grid ↔ full 8-row board
  // + Done pill), and nothing else backs the region up, so it must track the
  // panel's real size. The synchronous stamp handles the grow
  // direction via measure() (see updateInputRegion); this deferred re-stamp
  // settles the shrink direction (leaving edit mode briefly over-covers, which
  // would eat clicks meant for windows under the vacated strip) once the
  // post-toggle allocation exists (defer-a-frame idiom, as showExpansion).
  status.connect("notify::cc-edit-mode", () => {
    syncOverlays()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { updateInputRegion(); return GLib.SOURCE_REMOVE })
  })

  // Modality for this window is a compositor focus grab, and nothing else — ONE for
  // every panel on it, the island's modes and the app grid included. Reached through
  // syncOverlays(), which calls it FIRST because the input region is computed from
  // its result; it guards on `layerShellReady` so the construction-time
  // syncOverlays() cannot touch layer-shell before init_for_window.
  //
  // The grab is suspended while `inputYield` is active: a grab clamps pointer focus
  // to the grabbed surface, so computer-use cannot reach the app it was asked to
  // drive until we let go (core/InputYield).
  //
  // Which states want THIS window to own input. Note what it is not:
  //
  //  · NOT just Prism and the keyboard modes. They need the KEYBOARD, but every
  //    panel wants MODALITY — "clicking outside closes me" — and an ambient island
  //    mode (media, a running activity) as much as any.
  //  · NOT `cc_edit_mode`: it is the one open state that deliberately leaves the
  //    desktop interactive, and a grab would take that away — UNLESS it was entered
  //    from the keyboard (Status.ccEditFromKeyboard), when releasing the grab would
  //    take the keyboard away from the person using it.
  const barModal = () =>
    (status.cc_open || status.nc_open || status.prism_open || status.system_menu_open
      || status.island_mode !== "" || status.app_grid_open
      || status.bar_expanded_id !== "" || status.bar_overflow_open || status.bar_edit_mode || status.bar_keyboard)
      && (!status.cc_edit_mode || status.ccEditFromKeyboard)
  const barGrabbing = () => barModal()

  // The compositor took the grab away. Three causes, indistinguishable from here
  // (see common/FocusGrab.ts): an outside press — the dismissal we asked for — a
  // popup grab stealing the single slot, or a layer surface mapping with keyboard
  // interactivity. This window's answer is the same for all three: whatever is open
  // is no longer modal, so it closes. (A popup of ours never reaches here: the grid's
  // context menus are popovers, and FocusGrab suspends the lease for the life of one.)
  const onBarGrabCleared = () => {
    barGrabToken = 0
    // The keyboard walk had the keys through this grab; without it keys go elsewhere.
    status.bar_keyboard = false
    if (!status.cc_edit_mode) {
      status.cc_open = false; status.nc_open = false
      status.prism_open = false; status.system_menu_open = false
      status.island_mode = ""; status.app_grid_open = false
      status.bar_expanded_id = ""; status.bar_overflow_open = false
      status.bar_edit_mode = false   // a click outside is "Done"
    }
    // dismissOverlays is a no-op in edit mode, and a closed overlay re-enters here
    // through its notify handler — but neither is guaranteed, so settle the region
    // unconditionally rather than relying on a notify that may not fire.
    updateInputRegion()
  }

  // The windows that stay clickable THROUGH the grab, besides ours. A press on a
  // window left out of the set is the press that dismisses: it never reaches what
  // was clicked (see common/FocusGrab.ts). With the app grid open that is the dock,
  // so its icons still launch in one click; for every other panel, nothing — a press
  // on the dock closes the CC as a press anywhere else does.
  const grabWindows = (): Gtk.Window[] => status.app_grid_open ? [win, ...gridPeers()] : [win]
  let grabbedWith: Gtk.Window[] = []
  const sameWindows = (a: Gtk.Window[], b: Gtk.Window[]) => a.length === b.length && a.every((w, i) => w === b[i])

  // Named for what it used to switch. It no longer touches layer-shell keyboard
  // interactivity at all: this surface is set to NONE once at init and stays there,
  // because EXCLUSIVE is what puts us in m_exclusiveLSes and makes Hyprland refuse
  // to move window focus (the whole reason core/InputYield exists), and the grab
  // already carries the keyboard.
  const syncKeyboardMode = () => {
    if (!layerShellReady) return
    const want = barGrabbing() && !inputYield.active
    const wins = grabWindows()

    // Taken again when the peer set changes under a held grab (a panel switching to
    // the app grid, or back). The same owner re-acquiring is not an eviction:
    // FocusGrab does not call `onBarGrabCleared` for it.
    if (want && (!barGrabToken || !sameWindows(grabbedWith, wins))) {
      barGrabToken = acquireFocusGrab(wins, onBarGrabCleared)
      grabbedWith = barGrabToken ? wins : []
      // A refusal is not a degrade — there is no second mechanism left. Say what is
      // broken and what it costs, once per open, so a session in that state can be
      // diagnosed from the log alone instead of from the symptoms.
      if (!barGrabToken)
        console.error("[Bar] focus grab REFUSED — no modality: nothing dismisses these panels, and Prism, the app grid and the island's keyboard modes cannot be typed into.")
    } else if (!want && barGrabToken) {
      releaseFocusGrab(barGrabToken)
      barGrabToken = 0
      grabbedWith = []
      // A closing panel hands GTK's focus to the next focusable widget in the window,
      // which is the bar: measured on a tray icon after Esc closed the CC. With the
      // window still focus-visible that icon would be left wearing the ring, on a bar
      // that no longer has the keyboard. Nothing here should hold focus now.
      win.set_focus(null)
    }
  }

  inputYield.registerHolder(barGrabbing)
  inputYield.connect("notify::active", () => {
    // Yielding drops the grab, so for as long as the truce lasts an overlay left
    // open is NOT dismissable by clicking outside — the agent owns the pointer, and
    // the grab (with its dismissal) comes back when it hands it over.
    syncKeyboardMode()
    updateInputRegion()
  })

  status.connect("notify::island-mode", () => {
    // Our grab and whatever Status's mutual exclusion just closed, first.
    syncOverlays()   // runs syncKeyboardMode first — see its body
    // Pin the island's top to the capsule's top before the reveal (the capsule
    // ref is the truth — survives layout changes).
    if (status.island_mode) island.syncAnchor(masterOverlay, PANEL_TOP)
    syncIslandModes()
    if (status.island_mode) island.onOpened()   // seed the mode's keyboard nav
  })

  // Route keys to the open island mode (overview: ←/→ move the cursor, Enter
  // switches + closes, Esc closes) and to the app grid (its search, its cursor).
  // CAPTURE phase so they fire before any focused child.
  const modeKeys = new Gtk.EventControllerKey()
  modeKeys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  modeKeys.connect("key-pressed", (_c: any, keyval: number) => {
    if (status.island_mode) return island.handleKey(keyval)
    if (status.app_grid_open) return grid.handleKey(keyval)
    return false
  })
  win.add_controller(modeKeys)

  // ── The app grid: open / close ─────────────────────────────────────────────
  // Over a fullscreen window the bar is hidden (`setBarFullscreenMode`) — and the
  // grid opens over it all the same, as it did on a layer of its own (owner,
  // 2026-10-06): the surface rises to OVERLAY for as long as the grid is up, with the
  // bar's row out of sight. Super+B's overlay mode already has the surface there.
  const liftForGrid = (lift: boolean) => {
    if (lift === rowHidden) return
    rowHidden = lift
    for (const w of [barBox, islandHost, popups] as Gtk.Widget[]) {
      w.set_opacity(lift ? 0 : 1)
      w.set_can_target(!lift)
    }
    try {
      Gtk4LayerShell.set_layer(win, lift ? Gtk4LayerShell.Layer.OVERLAY : Gtk4LayerShell.Layer.TOP)
      win.set_opacity(lift ? 1 : 0)
    } catch (e) { console.error("[Bar] app grid over fullscreen:", e) }
  }
  const openGrid = () => {
    if (barFullscreenMode && !barOverlayActive) liftForGrid(true)
    grid.onShow()
    grid.setVisible(true)
    updateInputRegion()
  }
  const closeGrid = () => {
    grid.setActive(false)
    win.set_focus(null)
    grid.setVisible(false, () => {
      updateInputRegion()
      // Back under the fullscreen window once the grid has shrunk away — unless it
      // opened again in the meantime.
      if (!status.app_grid_open) liftForGrid(false)
    })
  }
  status.connect("notify::app-grid-open", () => {
    // Grab first (and its peers), then the panel: syncOverlays orders it.
    syncOverlays()
    if (status.app_grid_open) openGrid()
    else closeGrid()
  })

  // ── Bar expansion show/hide ────────────────────────────────────────────────
  // Centers the panel horizontally under the clicked bar capsule (hidden widgets
  // fall back to the overflow capsule).
  const positionExpansion = (id: string) => {
      const capsule = id === CUSTOM_ID ? customAnchor : (capsuleRefs.get(id) ?? capsuleRefs.get(OVERFLOW_ID))
      if (!capsule) return
      const iconAlloc = capsule.get_allocation()
      if (iconAlloc.width <= 1) return
      const [ok, tx] = capsule.translate_coordinates(masterOverlay, 0, 0)
      if (!ok) return
      const iconCenterX = tx + iconAlloc.width / 2
      const panelAlloc = expansionCapsule.get_allocation()
      const panelW = panelAlloc.width > 1 ? panelAlloc.width : 260
      // Left edge of the panel: flush with the anchor (start-align) or centered
      // under it. halign is END, so margin_end pins the panel's RIGHT edge.
      const panelLeft = (id === CUSTOM_ID && customAlign === "start") ? tx : iconCenterX - panelW / 2
      expansionCapsule.margin_end = Math.max(8, Math.round(geo().width - panelLeft - panelW))
  }

  const showExpansion = (id: string) => {
      const onClose = () => { status.bar_expanded_id = "" }
      let content: Gtk.Widget | undefined
      let flush = false
      if (id === CUSTOM_ID) {
          if (!customContentBuilder) return
          content = customContentBuilder(onClose)
      } else {
          const w = registry.get(id)
          if (!w?.buildBarExpanded) return
          content = w.buildBarExpanded(onClose)
          flush = !!w.barExpandedFlush
      }
      // A flush panel reaches the capsule's inner edge horizontally (its scroll bar
      // has to live there); it keeps the vertical breathing room either way.
      // GLASS_INSET, not 0: the capsule's VISIBLE edge is that far inside its own
      // allocation (drawSquircle paints the glass in from the rect), so flush-to-rect
      // hangs the content outside the shape — and puts a scroll lane's pill 2px nearer
      // the curve than its clearance assumes, which is what clipped the clipboard bar.
      expansionInner.margin_start = flush ? GLASS_INSET : rowInsetFor(RADIUS.lg) + GLASS_INSET
      expansionInner.margin_end = flush ? GLASS_INSET : rowInsetFor(RADIUS.lg) + GLASS_INSET
      // Direct pill→pill switch (one click, no dismissal in between): the
      // capsule is still fully revealed at the PREVIOUS anchor's position, so
      // snap it to the hidden state first — otherwise the new content paints
      // at the old spot for the layout frame below, then visibly jumps.
      if (expansionCapsule.get_visible()) expansionCapsule.snapClosed()
      let c = expansionInner.get_first_child()
      while (c) { const n = c.get_next_sibling(); expansionInner.remove(c); c = n }
      expansionInner.append(content)
      // Mapped but still transparent (reveal progress 0 = opacity 0). Defer one
      // frame so the panel is laid out, position it under the icon, THEN pop in —
      // the panel never appears at the wrong spot first (no reposition jump).
      expansionCapsule.set_visible(true)
      // Re-stamp NOW, not in the deferred stamp below: the panel is already
      // visible (transparent, but laid out and painting), and a region still
      // describing only the bar strip would scissor away the frame that fades it
      // in. Late is free for the input region, never for this one. This stamp can
      // only ever be the stale bounds of the PREVIOUS content or nothing at all
      // (→ whole surface); the panel is at opacity 0 until `reveal` below, and
      // both the append and `positionExpansion` re-stamp from `onAllocated`
      // before anything of it is visible.
      updateVisibleRegion()
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
          positionExpansion(id)
          expansionCapsule.reveal(true)   // fresh pop (snapClosed above on a switch)
          updateInputRegion()
          focusPanel(expansionInner)
          return GLib.SOURCE_REMOVE
      })
  }
  const hideExpansion = () => {
      // The content is cleared in the close callback — a reopen mid-close starts
      // a new reveal(true), so the pending callback never fires (no flash).
      expansionCapsule.reveal(false, () => {
          let c = expansionInner.get_first_child()
          while (c) { const n = c.get_next_sibling(); expansionInner.remove(c); c = n }
          updateInputRegion()
      })
  }
  // Open arbitrary content (e.g. a tray context menu) in the shared expansion
  // capsule, anchored under `anchor`. Same glass/fade/positioning/dismissal as
  // the widget popovers — so it's consistent and free of Gtk.Popover quirks.
  const openCustomExpansion = (anchor: Gtk.Widget, builder: (onClose: () => void) => Gtk.Widget, align: "center" | "start" = "center") => {
      customAnchor = anchor
      setBarCustomAnchor(anchor)
      customContentBuilder = builder
      customAlign = align
      if (status.bar_expanded_id === CUSTOM_ID) showExpansion(CUSTOM_ID)  // refresh anchor + content
      else status.bar_expanded_id = CUSTOM_ID
  }
  status.connect("notify::bar-expanded-id", () => {
      if (status.bar_expanded_id) showExpansion(status.bar_expanded_id)
      else hideExpansion()
      syncKeyboardMode()   // the expansion is modal too — grab before deciding the rest
      updateInputRegion()
  })
  status.connect("notify::prism-open", () => {
    // Prism is the one overlay here that needs the KEYBOARD, not just modality —
    // and it needs nothing special for it: the compositor hands the keyboard over
    // with the grab, at no layer-shell interactivity at all.
    syncOverlays() // grab, then visibility + input region — in that order, inside
  })
  
  syncOverlays()

  // The LEFT group: one piece of glass holding the system menu and the window title
  // (barGroup, capsule.ts). `left` is only the flank that carries the `.bar-left` rules.
  const left = new Gtk.Box({ css_classes: ["bar-left"], halign: Gtk.Align.START, hexpand: false })
  const leftGroup = barGroup()
  left.append(leftGroup.widget)
  const sysMenuWidget = SystemMenuIcon()
  const appTitle = AppTitle(geo().width, openCustomExpansion)
  const appTitleWidget = appTitle.widget
  // The system-menu capsule has no visibility setting on purpose: it owns the
  // only GUI path to log out / restart / shut down (SystemMenu.tsx), and the
  // exit-session keybind was deliberately not shipped, so hiding it leaves no
  // way to end the session. Every other DE that is not an explicit panel-builder
  // makes the same call (GNOME and Windows never let you remove it). The
  // island's centre box below is permanent for the sibling reason — see barState.
  appTitleWidget.set_visible(barSettings.showAppTitle)
  leftGroup.box.append(sysMenuWidget)
  leftGroup.box.append(appTitleWidget)

  // ── Adaptive glass (#673) ─────────────────────────────────────────────────
  // Each surface keeps its text legible over whatever is behind it: thicker glass,
  // or the other skin (common/AdaptiveGlass.ts). One registration per SURFACE — the
  // bar strip is one decision, each panel another — never per capsule.
  const atRest = (r: ScaleRevealer | MorphRevealer) => () => r.tickId === null && r.progress >= 1
  // What the island covers on this window: its row (capsule + chips) and whichever
  // mode is open or still morphing, as one rect, or null when nothing of it is
  // measurable. masterOverlay is the window's child at 0,0 and the surface starts
  // at the monitor's corner, so these are monitor-relative too.
  //
  // Two readers. The adaptive glass, for whom the island is paint of OURS over the
  // backdrop of another registration (each measures only itself). And the Assistant,
  // which lives in this island and must not click controls UNDER it: the click lands
  // (the yield makes the surface click-through), but where the user cannot see it,
  // which reads as the assistant acting behind their back (app.ts → islandRect).
  const islandBounds = (): { x: number, y: number, w: number, h: number } | null => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const hitTargets = island.hitTargets()
    for (const w of [...hitTargets, ...island.revealers] as Gtk.Widget[]) {
      if (!w.get_visible() || !w.get_mapped()) continue
      const [ok, b] = w.compute_bounds(masterOverlay)
      if (!ok || b.get_width() <= 1 || b.get_height() <= 1) continue
      x0 = Math.min(x0, b.get_x()); y0 = Math.min(y0, b.get_y())
      x1 = Math.max(x1, b.get_x() + b.get_width()); y1 = Math.max(y1, b.get_y() + b.get_height())
    }
    if (!isFinite(x0)) return null
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
  }
  ;(win as any).occupiedRect = () => {
    const r = islandBounds()
    // The connector name (DP-1, …) so a consumer on a multi-monitor setup can tell
    // whether this rect is even on the output it is clicking.
    return r ? { ...r, monitor: gdkmonitor.get_connector() ?? "" } : null
  }
  const underIsland = () => {
    const r = islandBounds()
    return r ? [{ x: r.x, y: r.y, width: r.w, height: r.h }] : []
  }
  for (const [id, pop] of [
    ["control-center", cc], ["notification-center", nc], ["system-menu", systemMenu],
    ["search", prism], ["bar-expansion", expansionCapsule],
  ] as const) {
    glassHandles.set(pop, registerGlassSurface({ id, root: pop, role: "overlay", settled: atRest(pop), exclude: underIsland }))
  }
  glassHandles.set(barBox, registerGlassSurface({
    id: "bar", root: barBox, role: "bar", exclude: underIsland, group: () => "bar-row",
    // No `skinFromBackdrop` since 2026-09-30 (owner): the row's ink is the shell's —
    // white — and does not change with the wallpaper; the glass only thickens.
    // Hidden for a fullscreen window the bar stays MAPPED (opacity 0), so it looked
    // measurable — and what it found behind it was the fullscreen window: X's black page
    // and white text, which flipped the row and brought it back from fullscreen in that
    // skin (2026-09-29). Not settled while hidden; an event missed then is measured when
    // it shows again (`settle()` in setBarFullscreenMode / setBarOverlayMode).
    settled: () => !barFullscreenMode || barOverlayActive,
  }))
  glassHandles.set(popups, registerGlassSurface({ id: "notification-banners", root: popups, role: "overlay", exclude: underIsland }))
  // The island is TWO kinds of surface for the glass. Its row (the capsule and the
  // indicator chips) is part of the bar's row and decides with it. Each MODE is a panel
  // of its own — measured where it last opened, also while closed, so it opens already
  // right; the morph travels from the capsule's glass to the mode's. (One decision for
  // the whole island, switching between the two, could not be measured in advance: a
  // mode's rect is only known while it is open.)
  glassHandles.set(islandHost, registerGlassSurface({
    id: "island",
    root: islandHost,
    role: "bar",
    probe: () => island.capsule,
    // While a mode is open the capsule is switched off (opacity 0): nothing to measure.
    settled: () => !status.island_mode && islandHost.tickId === null,
    group: () => "bar-row",
  }))
  for (const { id, revealer } of island.modeRevealers) {
    glassHandles.set(revealer, registerGlassSurface({
      id: `island-${id}`,
      root: revealer,
      role: "overlay",
      settled: atRest(revealer),
    }))
  }
  // The grid's labels over whatever is behind it — only once the pop has landed:
  // mid-pop the capture and the render are different frames.
  glassHandles.set(grid.widget, registerGlassSurface({
    id: "app-grid", root: grid.widget, role: "launcher",
    // The launcher is a large content surface: its labels follow the system's light/dark
    // mode as a coherent group, not the wallpaper behind one side of the grid.
    skinFromMode: true,
    settled: atRest(grid.widget as unknown as ScaleRevealer),
  }))
  win.connect("destroy", () => { for (const h of glassHandles.values()) h.dispose(); glassHandles.clear() })

  const ISLAND_GAP = 16

  // Forward declaration for layout sync across the left/right flanks and Activity Island
  let scheduleBarLayoutSync: (delayMs?: number) => void = () => {}

  // The capsule changes size on its own — the compact stack interpolates its width
  // when the fronting activity changes, and a media title of a different length
  // reshapes the pill — and the row around it lays out against the room it leaves.
  // The glass DrawingArea's `resize` fires on exactly those. (No input region to
  // re-cut for it: the capsule is inside the bar strip.)
  ;(island.capsule as any).glassArea?.connect("resize", () => {
    syncLeftBudget()
    scheduleBarLayoutSync()
  })
  // A chip appearing or leaving moves the capsule sideways WITHOUT resizing it.
  island.onBackgroundChanged(() => {
    syncLeftBudget()
    scheduleBarLayoutSync()
  })
  // …and again when the slide actually ENDS, the frame the row's final width exists.
  island.onChipsSettled(() => {
    syncLeftBudget()
    scheduleBarLayoutSync()
  })
  island.indicatorRow.connect("notify::opacity", () => {
    syncLeftBudget()
    scheduleBarLayoutSync()
  })
  const right = new Gtk.Box({ css_classes: ["bar-right"], halign: Gtk.Align.END })
  // Absorbs remaining space so the group stays pinned to the right edge.
  const rightSpacer = new Gtk.Box({ hexpand: true })
  right.append(rightSpacer)
  // The RIGHT group: ONE piece of glass for the `»`, the widgets, the tray, search,
  // the CC and the clock, in that order (barGroup, capsule.ts; owner, 2026-09-26).
  const rightGroup = barGroup()
  right.append(rightGroup.widget)
  // An island mode big enough to cover a group or the banners fades them out instead of
  // laying its glass over them (ActivityIsland → coveredBy).
  island.setNeighbours(() => [leftGroup.widget, rightGroup.widget, popups])

  const timeContent = new Gtk.Box({ margin_start: BAR_TEXT_PAD, margin_end: BAR_TEXT_PAD })
  const timeLabel = new Gtk.Label({ label: "...", css_classes: ["bar-time-label"] })
  const updateClock = () => {
    const next = regionConfig.formatClock()
    if (timeLabel.label !== next) timeLabel.label = next
  }
  const clockTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { updateClock(); return GLib.SOURCE_CONTINUE })
  timeLabel.connect("unrealize", () => { try { GLib.source_remove(clockTimer) } catch {} })
  regionConfig.connect("changed", updateClock)
  updateClock()
  // No bell beside the date (owner, 2026-09-26): inside one group with the widgets it
  // read as another widget's icon. The pending count lives in the clock's tooltip.
  timeContent.append(timeLabel)

  // Everything in the right group that has a place in the ORDER (core/BarOrder.ts): the
  // widgets, the apps' tray icons and search, in one row the person arranges. Only the
  // `»` before it and the CC and clock after it stay put.
  const orderedItems = new Gtk.Box({ css_classes: ["bar-optional-widgets"], spacing: BAR_ITEM_GAP })

  // The overflow capsule: shown only while some item does not fit. It is not a
  // menu — it unfolds the hidden items IN LINE, in the same bar (the `»`):
  // the island rises out of the way and the row grows leftwards over the room it
  // leaves, the window title yielding if it has to (Status.bar_overflow_open).
  // Unfolded items are the same as the others, placed by the same loop.
  // Built once and kept outside `orderedItems`, which rebuildBarWidgets empties.
  const overflowIcon = new Gtk.Image({ gicon: uiIcon("nd-pan-end"), pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD, css_classes: ["nd-icon"] })
  const overflowItem = barItem({ child: overflowIcon, ...barOpen(() => status.bar_overflow_open), onKey: () => status.toggleBarOverflow() })
  overflowItem.set_visible(false)
  barTooltip(overflowItem, () => t(status.bar_overflow_open ? "bar.tooltip.overflow.hide" : "bar.tooltip.overflow.show"))
  {
      const g = new Gtk.GestureClick()
      g.connect("released", () => {
          if (status.cc_edit_mode) return
          status.toggleBarOverflow()
      })
      overflowItem.add_controller(g)
  }

  // The two kinds of ordered item that are built ONCE and re-parented on every rebuild
  // (a widget item is rebuilt instead): the tray's icons, which hold an app's menu and
  // subscriptions, and search.
  const tray = Tray(openCustomExpansion, () => scheduleBarLayoutSync())
  const searchItem = barItem({ child: new Gtk.Image({ gicon: uiIcon("nd-system-search"), pixel_size: BAR_ICON_SIZE, margin_start: BAR_ITEM_PAD, margin_end: BAR_ITEM_PAD, css_classes: ["nd-icon"] }), onClick: () => status.togglePrism(), ...barOpen(() => status.prism_open) })
  barTooltip(searchItem, () => t("bar.tooltip.search"))

  const buildWidgetItem = (id: string): Gtk.Widget | null => {
      const w = registry.get(id)
      if (!w?.buildBarContent) return null
      const hasExpand = !!w.buildBarExpanded
      // cc_edit_mode (not cc_open): while editing the CC the pills stay inert;
      // with the CC merely open, a pill click switches to its surface directly
      // (the bar_expanded_id setter closes the exclusive overlays).
      // barClick gets first refusal on EVERY click (asked here, not cached at
      // build time) so a widget can act directly in a state where opening a panel
      // would only be in the way — screenrecord stops the capture. See Types.ts.
      // A pill with no bar panel does NOT fall back to the CC detail: its content
      // acts on its own (makeBarIcon's onAction — night light, Bluetooth, Focus
      // toggle like dark mode), and the capsule's release fires after that press,
      // so the fallback made one click toggle AND open the CC.
      const open = hasExpand
          ? () => { status.bar_expanded_id = status.bar_expanded_id === id ? "" : id }
          : undefined
      const onRelease = (hasExpand || w.barClick)
          ? () => {
              if (status.cc_edit_mode) return
              if (w.barClick?.()) { status.bar_expanded_id = ""; return }
              open?.()
          }
          : undefined
      const item = barItem({ child: w.buildBarContent(), ...barOpen(() => status.bar_expanded_id === id), onKey: onRelease })
      if (onRelease) {
          // BUBBLE + released: child buttons claim on press → deny this gesture → released
          // never fires when a button is clicked; fires only for neutral-area taps.
          const g = new Gtk.GestureClick()
          g.connect("released", onRelease)
          item.add_controller(g)
      }
      // Tooltip: the widget's name, or "Name · state" when the widget offers a state
      // line (`barTooltipState`). Read at show time, so it is the state of that moment.
      barTooltip(item, () => {
          const state = w.barTooltipState?.()
          return state ? `${w.name} · ${state}` : w.name
      })
      if (hasExpand) capsuleRefs.set(id, item)
      return item
  }

  // The order's FULL list — every item that has a place, shown or not: enabled widgets
  // (active or not), tray icons seen and not hidden (running or not), search. What is
  // painted is a subset of it; what is saved after a move is all of it, so an icon that
  // is only absent right now (a VPN off, an app closed) keeps its place and does not
  // come back at the left end as if it were new.
  let fullKeys: string[] = []
  const keyOfItem = new Map<Gtk.Widget, string>()

  // "Done", in the `»`'s place while the bar is being edited.
  const doneItem = barItem({
      child: new Gtk.Label({ label: t("bar.edit.done"), css_classes: ["bar-app-name"], margin_start: BAR_TEXT_PAD, margin_end: BAR_TEXT_PAD }),
  })
  doneItem.set_visible(false)
  { const g = new Gtk.GestureClick(); g.connect("released", () => { status.bar_edit_mode = false }); doneItem.add_controller(g) }
  barTooltip(doneItem, () => t("bar.edit.hint"))

  const widgetShown = (id: string) => {
      const mode = widgetConfig.barMode(id)
      return mode !== "active" || status.bar_edit_mode || (registry.get(id)?.barActive?.() ?? true)
  }

  const rebuildBarWidgets = () => {
    if (status.bar_expanded_id) status.bar_expanded_id = ""
    capsuleRefs.clear()
    keyOfItem.clear()
    // A widget's panel opened while its pill is hidden (IPC) hangs from the overflow
    // capsule — see positionExpansion.
    capsuleRefs.set(OVERFLOW_ID, overflowItem)
    // remove(), not destroy: the tray icons and search are re-appended below.
    let child = orderedItems.get_first_child()
    while (child) {
        const n = child.get_next_sibling()
        orderedItems.remove(child)
        child.set_opacity(1)
        child = n
    }

    // Every item with a place, in its DEFAULT order, then the person's order on top.
    // Hardware gate: widgets without their hardware don't render or take a slot,
    // regardless of the user's saved placement (which stays untouched).
    const widgetKeys = widgetConfig.barWidgetIds()
        .filter(id => { const w = registry.get(id); return !!w?.buildBarContent && widgetAvailable(w) })
        .map(widgetKey)
    // Tray icons in the order they were FIRST SEEN (`tray-known`), not the order they
    // arrived this session: that is the order Settings lists them in, and the page must
    // show the bar's own order. One not recorded yet (a second instance's `#2`) goes last.
    const known = knownTrayItems().map(k => trayKey(k.id))
    const seen = new Map(known.map((k, i) => [k, i]))
    const trayKeys = [...new Set([...known, ...tray.keys()])]
        .filter(k => !isBarHidden(k))
        .sort((a, b) => (seen.get(a) ?? Infinity) - (seen.get(b) ?? Infinity))
    fullKeys = resolveOrder(savedBarOrder(), defaultOrder(widgetKeys, trayKeys))
    // What can be painted now: a widget in "When active" mode only while active (all of
    // them while editing, so each can be placed), a tray icon only while its app runs.
    const all = fullKeys.filter(key => {
        const p = parseBarKey(key)
        if (!p) return false
        if (p.kind === "widget") return widgetShown(p.id)
        if (p.kind === "tray") return !!tray.widget(key)
        return key === SEARCH_KEY && !isBarHidden(SEARCH_KEY)
    })
    // Hidden from the LEFT end: the order is the priority, so what the person put
    // nearest the clock is the last to go (by default the system widgets, the tray
    // and search). Unfolded, the island's half of the bar is available too.
    const unfolded = status.bar_overflow_open
    const folded = fitFolded ?? Infinity
    const fit = unfolded ? Math.max(folded, fitUnfolded ?? Infinity) : folded
    const visible = all.slice(all.length - Math.min(all.length, fit))
    const anyHidden = all.length > folded
    overflowItem.set_visible(anyHidden && !status.bar_edit_mode)
    doneItem.set_visible(status.bar_edit_mode)
    overflowIcon.gicon = uiIcon(unfolded ? "nd-pan-start" : "nd-pan-end")
    // Editing needs every item on screen: unfold when something does not fit.
    if (status.bar_edit_mode && anyHidden && !unfolded)
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { if (status.bar_edit_mode) status.bar_overflow_open = true; return GLib.SOURCE_REMOVE })
    // Nothing left to unfold (an item removed, a wider monitor): fold. Deferred, as
    // folding rebuilds through this very function. Only on a MEASURED answer: the
    // measuring pass rebuilds with nothing cached, which reads as "everything fits".
    if (unfolded && fitFolded !== null && !anyHidden && !status.bar_edit_mode)
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { status.bar_overflow_open = false; return GLib.SOURCE_REMOVE })

    for (const key of visible) {
      const parsed = parseBarKey(key)
      const item = !parsed ? null
          : parsed.kind === "widget" ? buildWidgetItem(parsed.id)
          : parsed.kind === "tray" ? tray.widget(key)
          : key === SEARCH_KEY ? searchItem : null
      if (!item) continue
      keyOfItem.set(item, key)
      // While editing, an item's CONTENT takes no input (a tray button, a widget's own
      // toggle), so a press is a selection and a drag a move; an inactive "When active"
      // widget is shown dimmed — it is here only to be placed.
      const content = item.get_last_child()
      content?.set_can_target(!status.bar_edit_mode)
      const inactive = parsed?.kind === "widget" && status.bar_edit_mode
          && widgetConfig.barMode(parsed.id) === "active" && !(registry.get(parsed.id)?.barActive?.() ?? true)
      item.set_opacity(inactive ? 0.5 : 1)
      orderedItems.append(item)
    }
    // An empty row is still a child of the group, and a visible one gets a gap on each
    // side of nothing: hidden while it holds no item.
    orderedItems.set_visible(orderedItems.get_first_child() !== null)
    reselect()
  }

  // ── Reordering in place (Status.bar_edit_mode) ─────────────────────────────
  // One drag source, one drop target and one click on the ROW, not on each item: the
  // tray icons and search are re-parented on every rebuild and would collect a
  // controller per rebuild otherwise. The item under the pointer is the row's direct
  // child that contains the picked widget.
  const itemAt = (x: number, y: number): Gtk.Widget | null => {
      let w: Gtk.Widget | null = orderedItems.pick(x, y, Gtk.PickFlags.INSENSITIVE | Gtk.PickFlags.NON_TARGETABLE)
      while (w && w.get_parent() !== orderedItems) w = w.get_parent()
      return w && keyOfItem.has(w) ? w : null
  }
  // The shown key a drop at `x` goes in front of (null = after the last shown one).
  const shownKeyAt = (x: number): string | null => {
      for (let c = orderedItems.get_first_child(); c; c = c.get_next_sibling()) {
          const a = c.get_allocation()
          if (x < a.x + a.width / 2) return keyOfItem.get(c) ?? null
      }
      return null
  }
  // Saves the FULL order with `key` moved to just before `before` among the shown
  // items; `before` null = right after the last shown one.
  const moveInBar = (key: string, before: string | null) => {
      if (before === key) return
      let target = before
      if (target === null) {
          const shown = [...keyOfItem.values()]
          const last = shown[shown.length - 1]
          const i = fullKeys.indexOf(last)
          target = i >= 0 ? (fullKeys[i + 1] ?? null) : null
          if (target === key) return
      }
      setSavedBarOrder(moveBefore(fullKeys, key, target))   // → watchBarOrder → rebuild
  }

  // The selection survives the rebuild a move causes: it is remembered by KEY and
  // re-picked after every rebuild (reselect).
  let selectedKey: string | null = null
  const selectItem = (w: Gtk.Widget | null) => {
      setBarEditSelected(w)
      selectedKey = w ? keyOfItem.get(w) ?? null : null
  }
  const reselect = () => {
      if (!status.bar_edit_mode || !selectedKey) return
      for (const [w, k] of keyOfItem) if (k === selectedKey) { setBarEditSelected(w); return }
  }

  const editPress = new Gtk.GestureClick()
  editPress.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  editPress.connect("pressed", (_g: any, _n: number, x: number, y: number) => {
      if (!status.bar_edit_mode) return
      selectItem(itemAt(x, y))
  })
  orderedItems.add_controller(editPress)

  let draggingKey: string | null = null
  const editDrag = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
  editDrag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  editDrag.connect("prepare", (_s: any, x: number, y: number) => {
      if (!status.bar_edit_mode) return null
      const item = itemAt(x, y)
      const key = item ? keyOfItem.get(item) : undefined
      if (!item || !key) return null
      draggingKey = key
      selectItem(item)
      const val = new GObject.Value()
      val.init(GObject.TYPE_STRING)
      val.set_string(key)
      return Gdk.ContentProvider.new_for_value(val)
  })
  editDrag.connect("drag-begin", (_s: any, drag: any) => {
      const item = barEditSelected()
      if (!item) return
      try { Gtk.DragIcon.set_from_paintable(drag, new Gtk.WidgetPaintable({ widget: item }), item.get_width() / 2, item.get_height() / 2) } catch {}
      item.set_opacity(0.3)
  })
  editDrag.connect("drag-end", () => { draggingKey = null; scheduleBarLayoutSync(0) })
  orderedItems.add_controller(editDrag)

  const editDrop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
  editDrop.connect("drop", (_t: any, _v: any, x: number) => {
      if (!status.bar_edit_mode || !draggingKey) return false
      moveInBar(draggingKey, shownKeyAt(x))
      return true
  })
  orderedItems.add_controller(editDrop)

  // Keyboard, through the bar's focus grab (barModal counts edit mode): ← → move the
  // selected item one place, Esc / Enter finish.
  const editKeys = new Gtk.EventControllerKey()
  editKeys.connect("key-pressed", (_c: any, keyval: number) => {
      if (!status.bar_edit_mode) return false
      if (keyval === Gdk.KEY_Escape || keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
          status.bar_edit_mode = false
          return true
      }
      if (keyval !== Gdk.KEY_Left && keyval !== Gdk.KEY_Right) return false
      const shown = [...keyOfItem.entries()]
      if (shown.length === 0) return true
      const selected = barEditSelected()
      const i = shown.findIndex(([w]) => w === selected)
      if (i < 0) { selectItem(keyval === Gdk.KEY_Left ? shown[shown.length - 1][0] : shown[0][0]); return true }
      const key = shown[i][1]
      if (keyval === Gdk.KEY_Left && i > 0) moveInBar(key, shown[i - 1][1])
      if (keyval === Gdk.KEY_Right && i < shown.length - 1) moveInBar(key, shown[i + 2]?.[1] ?? null)
      return true
  })
  win.add_controller(editKeys)

  status.connect("notify::bar-edit-mode", () => {
      if (!status.bar_edit_mode) {
          selectedKey = null
          if (status.bar_overflow_open) status.bar_overflow_open = false
      }
      rebuildBarWidgets()
      syncOverlays()
  })
  widgetConfig.connect("changed", () => {
      scheduleBarLayoutSync()
  })
  // The order, a tray icon hidden or shown — from Settings, another process later (#571).
  watchBarOrder(() => scheduleBarLayoutSync())
  // Hardware appearing/disappearing (BT dongle, wifi device…) re-runs the same path.
  watchWidgetAvailability(() => {
      scheduleBarLayoutSync()
  })
  // A "When active" widget turning on or off (Wi-Fi radio, VPN, a capture).
  for (const w of registry.all()) w.watchBarActive?.(() => scheduleBarLayoutSync())
  rebuildBarWidgets()

  rightGroup.box.append(doneItem)
  rightGroup.box.append(overflowItem)
  rightGroup.box.append(orderedItems)
  // The Control Centre's button is an ordinary icon item. Its drawing is two
  // switches (the freedesktop spec has no name for
  // that; `preferences-system` is a gear or tools everywhere, #587), and the
  // switches FLIP while the CC is open — a state of the icon, played by GTK
  // (common/StatefulIcon.ts), not a CSS transform on a clickable.
  // Until 2026-09-27 it also carried a red dot in a lane of its own for AI control
  // (StatusIndicators.tsx); the owner took the dot out: that notice lives only in
  // the CC's banner until what the bar should show for it is decided.
  const ccIcon = statefulIcon("nd-control-center", { pixelSize: BAR_ICON_SIZE, cssClasses: ["nd-icon"] })
  ccIcon.widget.margin_start = BAR_ITEM_PAD
  ccIcon.widget.margin_end = BAR_ITEM_PAD
  const syncCCIcon = () => ccIcon.setState(status.cc_open ? "open" : "closed")
  status.connect("notify::cc-open", syncCCIcon)
  syncCCIcon()
  const ccItem = barItem({ child: ccIcon.widget, onClick: () => status.toggleCC(), ...barOpen(() => status.cc_open) })
  barTooltip(ccItem, () => t("bar.tooltip.control-center"))
  rightGroup.box.append(ccItem)
  const clockItem = barItem({ child: timeContent, onClick: () => status.toggleNC(), ...barOpen(() => status.nc_open) })
  // The clock's tooltip is the whole date, year included, whatever date format the
  // clock itself shows; the state line is the count of pending notifications.
  barTooltip(clockItem, () => {
    const date = formatFullDate(GLib.DateTime.new_now_local())
    const n = notifications().length
    if (n === 0) return date
    const count = n === 1 ? t("bar.tooltip.notifications.one") : t("bar.tooltip.notifications.other").replace("%d", String(n))
    return `${date} · ${count}`
  })
  rightGroup.box.append(clockItem)

  // No center widget: the capsule that used to sit there paints on the island's
  // surface now. CenterBox places left at START and right at END.
  barBox.set_start_widget(left); barBox.set_end_widget(right)

  // ── Flank budget & dynamic collision prevention ───────────────────────────
  // Calculate available space on each flank before reaching the Activity Island zone,
  // guaranteeing consistent ISLAND_GAP separation regardless of island mutation or title length.
  const getAvailableFlankWidth = () => {
    const monW = geo().width
    const islandW = center.measure(Gtk.Orientation.HORIZONTAL, -1)[1] || 100
    return Math.max(0, (monW / 2) - (islandW / 2) - BAR_MARGIN - ISLAND_GAP)
  }

  // Below this the window title is not worth its capsule: while the overflow is
  // unfolded it steps aside entirely rather than showing an ellipsis.
  const TITLE_MIN_W = 96
  let titleYielded = false
  let showTitle = barSettings.showAppTitle
  const syncTitleVisible = () => appTitleWidget.set_visible(showTitle && !titleYielded)

  // `immediate`: the right group is growing over the title in this same frame
  // (the overflow unfolding), so the title cannot take its usual ~180ms to shrink.
  const syncLeftBudget = (immediate = false) => {
    const sysMenuW = sysMenuWidget.measure(Gtk.Orientation.HORIZONTAL, -1)[1] || 32
    // The title shares the left group's glass with the system menu: what it costs
    // besides the menu item is the group's own padding at both ends and the gap
    // between the two items.
    const groupPad = 2 * BAR_GROUP_PAD + BAR_ITEM_GAP
    let appTitleBudget: number
    if (status.bar_overflow_open) {
      // No island in the middle: the title gets whatever the unfolded right group
      // leaves, up to the same gap the island would have kept.
      const rightW = right.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
      appTitleBudget = Math.max(0, geo().width - 2 * BAR_MARGIN - rightW - sysMenuW - groupPad - ISLAND_GAP)
    } else {
      appTitleBudget = Math.max(0, getAvailableFlankWidth() - sysMenuW - groupPad)
    }
    const yielded = status.bar_overflow_open && appTitleBudget < TITLE_MIN_W
    if (yielded !== titleYielded) { titleYielded = yielded; syncTitleVisible() }
    appTitle.setMaxWidth(appTitleBudget, immediate)
  }

  compositor.connect("changed", () => syncLeftBudget())
  compositor.connect("title-changed", () => syncLeftBudget())
  syncLeftBudget()

  // How many ordered items (widgets, tray icons, search) fit, counted from the clock
  // side, in both states:
  //  · folded: the right flank only, between the island and the CC — and if they
  //    do not all fit, the overflow capsule takes a place too;
  //  · unfolded: the island is gone, so everything from the left group (plus the
  //    island's gap) to the CC, the window title yielding.
  // Measured with every item shown, then rebuilt to the folded/unfolded cut.
  const measureOverflow = () => {
    fitFolded = null
    fitUnfolded = null
    rebuildBarWidgets()

    const natW = (w: Gtk.Widget) => w.measure(Gtk.Orientation.HORIZONTAL, -1)[1]

    const iconWidths: number[] = []
    let c: Gtk.Widget | null = orderedItems.get_first_child()
    while (c) { iconWidths.push(natW(c)); c = c.get_next_sibling() }
    if (iconWidths.length === 0) return

    // Every item costs its own width plus the gap before it (BAR_ITEM_GAP), and the
    // group's glass costs its padding once, charged with the fixed items — whose first
    // one has no gap before it.
    const fixedItems: Gtk.Widget[] = [ccItem, clockItem]
    const fixedW = 2 * BAR_GROUP_PAD - BAR_ITEM_GAP
        + fixedItems.reduce((s, w) => s + (w.get_visible() ? natW(w) + BAR_ITEM_GAP : 0), 0)
    overflowItem.set_visible(true)
    const overflowW = natW(overflowItem) + BAR_ITEM_GAP
    overflowItem.set_visible(false)

    const fitFromClock = (budget: number) => {
      let total = 0, n = 0
      for (let i = iconWidths.length - 1; i >= 0; i--) {
        const cost = iconWidths[i] + BAR_ITEM_GAP
        if (total + cost > budget) break
        total += cost
        n++
      }
      return n
    }

    const foldedBudget = getAvailableFlankWidth() - fixedW
    fitFolded = fitFromClock(foldedBudget) >= iconWidths.length
      ? iconWidths.length
      : fitFromClock(foldedBudget - overflowW)
    const sysMenuW = natW(sysMenuWidget)
    const unfoldedBudget = geo().width - 2 * BAR_MARGIN - (sysMenuW + 2 * BAR_GROUP_PAD) - ISLAND_GAP - fixedW - overflowW
    fitUnfolded = fitFromClock(unfoldedBudget)
    // Only on an absurd widget count: the farthest ones stay out of reach even
    // unfolded. Said once per measurement so it cannot be mistaken for a bug.
    if (fitUnfolded < iconWidths.length)
      console.warn(`[Bar] ${iconWidths.length - fitUnfolded} bar widget(s) do not fit even with the overflow unfolded`)

    rebuildBarWidgets()
    if (status.bar_overflow_open) syncLeftBudget(true)
  }

  let barLayoutSyncTimeout = 0
  scheduleBarLayoutSync = (delayMs = 50) => {
    syncLeftBudget()
    if (barLayoutSyncTimeout) GLib.source_remove(barLayoutSyncTimeout)
    barLayoutSyncTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
      barLayoutSyncTimeout = 0
      syncLeftBudget()
      measureOverflow()
      return GLib.SOURCE_REMOVE
    })
  }

  onBarSettingsChanged((s) => {
    showTitle = s.showAppTitle
    syncTitleVisible()
    scheduleBarLayoutSync()
  })

  const monitorHeight = gdkmonitor.get_geometry().height

  // ── Top zone reservation ──────────────────────────────────────────────────
  // The bar reserves its own BAR_H top strip via exclusive_zone (set on `win`
  // below). The previous design used a SEPARATE invisible "nidara-bar-zone"
  // layer surface (exclusive_zone=40) plus exclusive_zone=-1 on the bar, so a
  // side dock's exclusive zone couldn't squish the bar's width. But that empty
  // spacer surface triggered a Wayland `configure` storm: Hyprland reconfigured
  // it ~60×/s, spinning its frame clock and forcing continuous recomposite +
  // reblur of the bar/dock layers — tech-debt #11's real GPU drain (gdb-confirmed:
  // gdk_wayland_surface_configure → gdk_surface_request_layout ~60/s on that 2560×1
  // surface; a content-bearing surface like the bar or dock never storms).
  // Reserving from the bar itself deletes that surface and the storm.
  //
  // A "trade-off" documented here — that the bar would now respect a side dock's
  // exclusive zone and start after it — WAS WRONG, and cost real time in 2026-07
  // because it reads plausibly. Layer-shell arranges a surface requesting
  // `exclusive_zone > 0` against the FULL output area; only surfaces asking for
  // zone 0 get pushed into the remaining usable area. The bar asks for BAR_H, so it
  // spans the whole monitor no matter what anyone else reserves. Measured:
  // `hyprctl monitors -j` reports reserved [0,40,0,100] with a bottom dock while
  // `hyprctl layers -j` still puts nidara-bar at 0 0 2560 1440. That is also why
  // syncPanelMargins has to dodge a side dock by hand a few lines up — the dock
  // covers the bar, it does not displace it.

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "nidara-bar")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    // No bottom anchor — required for the exclusive zone to reserve only the top strip.
    // The ONLY place this surface's keyboard interactivity is ever set. It stays NONE
    // for the life of the session: modality comes from the compositor focus grab
    // (syncKeyboardMode), and EXCLUSIVE would re-add us to m_exclusiveLSes for nothing.
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    // Reserve the BAR_H top strip for tiled windows (replaces the old nidara-bar-zone
    // spacer surface — see "Top zone reservation" above). Independent of the surface's
    // own height; the bar surface stays full-height for the CC/NC overlays.
    Gtk4LayerShell.set_exclusive_zone(win, BAR_H)
    Gtk4LayerShell.set_monitor(win, gdkmonitor)
    layerShellReady = true
  } catch (e) {
    console.error("[Bar] LayerShell failed:", e)
  }

  win.set_child(masterOverlay)
  win.connect("realize", () => updateInputRegion())
  
  // Present invisible → measure → show, so the bar is never visible with a wrong layout.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { win.present(); return GLib.SOURCE_REMOVE })

  // Measure after first layout pass (bar realized but still invisible)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => { scheduleBarLayoutSync(0); return GLib.SOURCE_REMOVE })

  // ── The monitor changed shape ──────────────────────────────────────────────
  //
  // The regions follow the geometry on their own now (the stamper re-stamps this
  // surface, and the island's re-stamps its own). What does NOT is everything
  // this file SOLVED from the monitor's width or height and then stored in a
  // widget: the notification budget, how many bar icons fit, the app-title cap.
  // Those are the "capsules cut off" half of the bug — a bar still fitting 2560px
  // worth of icons into 1920.
  //
  // Debounced like the dock's rebuild, and for the same reason: a mode change can
  // land as more than one `notify::geometry`, and `measureOverflow` rebuilds the
  // widget row. 100 ms is that rebuild's own debounce (`scheduleDockRebuild` in
  // app.ts), kept identical so the two do not disagree about how settled a
  // resolution change is.
  let geometrySync = 0
  visibleRegion.onGeometryChanged(() => {
    if (geometrySync) GLib.source_remove(geometrySync)
    geometrySync = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      geometrySync = 0
      applyPanelHeights()
      appTitle.setMonitorWidth(geo().width)
      scheduleBarLayoutSync(0)
      // The island's overview solves its card size from the monitor's width.
      island.onMonitorResized()
      // measureOverflow may have rebuilt the row and appTitle may have changed
      // width, so the strip's capsules are in new places. Both regions again.
      updateInputRegion()
      return GLib.SOURCE_REMOVE
    })
  })

  let barFullscreenMode = false
  let barOverlayActive = false

  // Show only after measurement+rebuild have had time to take effect
  // Skip if fullscreen is already detected by then (checkBarFullscreen runs in idle_add)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      if (!barFullscreenMode) win.set_opacity(1)
      // First real declaration of the visible region. The realize-time stamp
      // already ran, but it rode a frame the bar spent invisible and measured a
      // layout that had not settled (measureOverflow rebuilds at 220ms). This
      // one rides the opacity change, i.e. a guaranteed repaint — and the shim
      // only applies a region on a real commit, never on queue_draw() alone.
      updateVisibleRegion()
      return GLib.SOURCE_REMOVE
  })

  // Fullscreen detection — hide bar automatically, restore when fullscreen exits

  const setBarFullscreenMode = (active: boolean) => {
      if (barFullscreenMode === active) return
      barFullscreenMode = active
      try {
          if (active && !barOverlayActive) {
              Gtk4LayerShell.set_exclusive_zone(win, 0) // release top reservation
              // The app grid open over the window that just went fullscreen keeps
              // the surface on screen for itself (`liftForGrid`).
              if (status.app_grid_open) liftForGrid(true)
              else win.set_opacity(0)
              // An open island mode and an unfolded overflow go with the bar they
              // live in.
              status.island_mode = ""
              status.bar_overflow_open = false
          } else if (!active) {
              liftForGrid(false)
              if (barOverlayActive) {
                  // Exit overlay mode when fullscreen ends
                  barOverlayActive = false
                  Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              }
              Gtk4LayerShell.set_exclusive_zone(win, BAR_H) // restore top reservation
              win.set_opacity(1)
              glassHandles.get(barBox)?.settle()
          }
      } catch (e) {}
  }

  // No per-client signal to rewire: `fullscreen` is part of HyprlandState's
  // structural signature, so "changed" fires for a window that toggles FSMODE
  // without moving (maximized → fullscreen keeps the same rect).
  const checkBarFullscreen = () => {
      setBarFullscreenMode(compositor.isRealFullscreen(compositor.focusedClient ?? null))
  }

  compositor.connect("changed", checkBarFullscreen)
  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { checkBarFullscreen(); return GLib.SOURCE_REMOVE })

  ;(win as any).setBarOverlayMode = (active: boolean) => {
      try {
          barOverlayActive = active
          if (active) {
              // The row comes back if it was hidden for the app grid: the overlay
              // mode shows the bar, and the surface is already where the grid needs it.
              liftForGrid(false)
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
              Gtk4LayerShell.set_exclusive_zone(win, 0) // release top reservation
              win.set_opacity(1)
              win.present()
              glassHandles.get(barBox)?.settle()
          } else {
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              if (barFullscreenMode) {
                  Gtk4LayerShell.set_exclusive_zone(win, 0)
                  status.island_mode = ""
                  // Back to hidden-for-fullscreen — the grid, if open, keeps the
                  // surface up for itself.
                  if (status.app_grid_open) liftForGrid(true)
                  else win.set_opacity(0)
              } else {
                  Gtk4LayerShell.set_exclusive_zone(win, BAR_H) // restore top reservation
              }
          }
      } catch (e) { console.error("[Bar] setBarOverlayMode failed:", e) }
  }
  // ── The overflow, unfolded in line ────────────────────────────────────────
  // Order matters on the way OUT: the row grows first and the title gives way in
  // the same frame, then the island's capsule rises out of the row — so for the
  // 150ms of the rise the new pills slide in under a capsule that is still on its
  // way up. Once it is out of sight it takes no presses (a hidden revealer is not
  // picked), so the unfolded pills under it are reachable.
  //
  // Folding is Status's job, not this handler's: any other surface opening closes
  // it (closeExclusive), and a press outside clears the bar's focus grab, which
  // `barModal` now holds for the overflow too (onBarGrabCleared / dismissOverlays).
  // The one thing that does NOT fold it is a panel of an unfolded widget — its
  // pill has to stay where the panel hangs from.
  status.connect("notify::bar-overflow-open", () => {
      const open = status.bar_overflow_open
      rebuildBarWidgets()
      syncLeftBudget(open)
      syncOverlays()
      if (open) {
          islandHost.reveal(false, () => updateInputRegion())
      } else {
          islandHost.reveal(true, () => updateInputRegion())
      }
  })

  ;(win as any).isBarOverlayActive = () => barOverlayActive
  ;(win as any).isBarFullscreenMode = () => barFullscreenMode

  return win
}
