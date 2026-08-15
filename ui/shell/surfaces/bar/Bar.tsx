import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalNotifd from "gi://AstalNotifd"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import { ScaleRevealer, OVERLAY_POP } from "../../common/ScaleRevealer"
import { MorphRevealer } from "../../common/MorphRevealer"
import { createRegionStamper } from "../../common/VisibleRegion"
import { acquireFocusGrab, releaseFocusGrab } from "../../common/FocusGrab"
import Cairo from "gi://cairo"
import Gio from "gi://Gio"

import SquircleContainer, { GLASS_INSET } from "../../common/SquircleContainer"
import { RADIUS, rowInsetFor } from "../../../lib/tokens"
import { CAPSULE_BORDER } from "./capsule"
import Theme from "../../core/ThemeManager"
import appService from "../../core/AppService"
import status from "../../core/Status"
import inputYield from "../../core/InputYield"
import widgetConfig from "../../core/WidgetConfig"
import regionConfig from "../../core/RegionConfig"
import registry, { widgetAvailable, watchWidgetAvailability } from "../../widgets/index"
import Tray from "./Tray"
import { SystemMenuOverlay } from "./SystemMenu"
import { AppTitle } from "./AppTitle"
import { ccBadge } from "./StatusIndicators"

// Overlay panels mounted on the bar window (avoids separate layer-shell surfaces)
import { ControlCenterWidget } from "../control-center/ControlCenter"
import NotificationCenter from "../control-center/NotificationCenter"
import Prism from "../prism/Prism"
import { NotificationPopupsWidget } from "../control-center/NotificationPopups"
import { ActivityIsland } from "../island/ActivityIsland"
import { IslandWindow } from "../island/IslandWindow"
import { execAsync } from "ags/process"
import { t } from "../../core/i18n"
import { barSettings, onBarSettingsChanged } from "./barState"
import { dockSideState, dockSettings, onDockSettingsChanged } from "../dock/state"
import Icons from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import hs from "../../core/HyprlandState"
import { safeDisconnect } from "../../core/signals"
import { SHELL_ROOT } from "../../core/Paths"

const ASSETS_DIR = SHELL_ROOT

export const LAUNCHER_ICON_PRESETS: Record<string, string> = {
  "nidara": `${ASSETS_DIR}/assets/nidara/assets/nidara-symbolic.svg`,
}

export const DEFAULT_LAUNCHER_ICON = "nidara"

function resolveIconPath(key: string): string | null {
  if (LAUNCHER_ICON_PRESETS[key]) return LAUNCHER_ICON_PRESETS[key]
  if (key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)) return key
  return null
}

function SystemMenuIcon(): Gtk.Widget {
  const img = new Gtk.Image({ pixel_size: 18, css_classes: ["bar-distro-icon"], margin_start: 14, margin_end: 14 })

  const applyIcon = () => {
    // Fall back to the built-in mark for unknown presets (e.g. a stale "arch"
    // from before the rebrand) or a custom path that no longer exists.
    const path = resolveIconPath(barSettings.launcherIcon || DEFAULT_LAUNCHER_ICON)
      ?? LAUNCHER_ICON_PRESETS[DEFAULT_LAUNCHER_ICON]
    img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path))
  }

  applyIcon()
  onBarSettingsChanged(applyIcon)

  return SquircleContainer({ child: img, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => status.toggleSystemMenu() })
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
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
  const barBox = new Gtk.CenterBox({ css_classes: ["bar-centerbox"], height_request: 40, valign: Gtk.Align.START, margin_start: 8, margin_end: 8 })

  // ── Inline expansion panel ─────────────────────────────────────────────────
  const OVERFLOW_ID = "__overflow"
  // Transient expansion (tray context menus etc.): arbitrary content anchored to
  // an arbitrary bar widget, reusing the exact same capsule/fade/positioning.
  const CUSTOM_ID = "__custom"
  let customContentBuilder: ((onClose: () => void) => Gtk.Widget) | null = null
  let customAnchor: Gtk.Widget | null = null
  // Horizontal anchoring of a custom expansion: "center" under the anchor (tray,
  // right side) vs "start" = panel's left edge flush with the anchor's left edge.
  // Start-align is for left-side capsules (AppTitle) whose centered panel would
  // otherwise overflow the left screen edge.
  let customAlign: "center" | "start" = "center"
  let overflowContentBuilder: ((onClose: () => void) => Gtk.Widget) | null = null
  // Measurement cache — populated after first layout; used to cap visible icons
  let cachedMaxIcons: number | null = null
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
  // CAPSULE — 40px tall, where it is what clamps the corner to min(w,h)/2 and makes the
  // stadium. This panel is the only large surface that had inherited it, and at radius lg
  // it bought nothing but a circular corner: a different shape from the system menu, the
  // CC context menu and the CC detail island, which are the same family (`lg` = "any
  // floating popup of the shell"). A squircle also does not reach into its own corner, so
  // the halo above drops from 14 to 6 — the reason this panel read airy next to a menu
  // sitting right under it.
  const expansionCapsule = new ScaleRevealer(SquircleContainer({
      child: expansionInner, gloss: true, useShellOpacity: true,
      borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, radius: RADIUS.lg,
      css_classes: ["bar-expansion-panel"],
  }), { ...OVERLAY_POP, pivot: "top-center" })   // grows down from its bar capsule
  expansionCapsule.valign = Gtk.Align.START
  expansionCapsule.halign = Gtk.Align.END
  // margin_top set below to PANEL_TOP so the gap matches CC/NC exactly.
  expansionCapsule.visible = false

  const cc = new ScaleRevealer(ControlCenterWidget(gdkmonitor), { ...OVERLAY_POP, pivot: "top-right" })
  const ncWidget = NotificationCenter()
  const nc = new ScaleRevealer(ncWidget, { ...OVERLAY_POP, pivot: "top-right" })
  const prism = Prism()
  const popups = NotificationPopupsWidget()
  const systemMenu = new ScaleRevealer(SystemMenuOverlay(), { ...OVERLAY_POP, pivot: "top-left" })
  // The Activity Island: the bar-center workspace capsule as a multi-purpose
  // morphing surface — capsule = compact state, expanded modes morph out of
  // it Dynamic-Island-style, one MorphRevealer per mode, all driven by
  // status.island_mode (see surfaces/island/ActivityIsland.tsx). Phase 1
  // ships one mode: the workspace overview.
  //
  // The WHOLE island — compact capsule included — lives in its own OVERLAY
  // layer surface (IslandWindow.ts), the one deliberate exception to "overlays
  // live inside the Bar's window": a surface cannot blur its own siblings, and
  // the island must blur the bar capsules it covers. The capsule goes with it so
  // the morph stays ONE object transforming on ONE surface; splitting them meant
  // two surfaces painting glass over the same pixels mid-morph, and their blurs
  // stacked into a visible seam. The bar still owns the capsule's geometry (the
  // row below) — it just hands the widget over.
  const islandWin = IslandWindow(gdkmonitor)
  const island = ActivityIsland(gdkmonitor)
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
    status.island_mode = ""; status.bar_expanded_id = ""
    // The app grid too, and it is NOT decoration: this surface is a peer in the
    // grid's focus grab (so its capsules stay hoverable while the grid is open), and
    // a peer is precisely a surface the compositor will NOT dismiss on. Without this
    // line the empty strip would be the one press on screen that does nothing.
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
  // `margin-top: 8px` and a CSS margin lies OUTSIDE the allocation: the band between
  // the capsules and the screen edge is not barBox at all, it is the overlay behind
  // it. Measured on the live shell (`query_ui`): the window is 40px tall and barBox
  // is y=8 h=32 x=8, so the same is true of the 8px at either end. All of it is
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
    // `owner` ends as the masterOverlay child the press belongs to, or null when it
    // landed on the overlay's own background (the bands around barBox).
    let owner: Gtk.Widget | null = null
    for (let w: Gtk.Widget | null = hit; w && w !== masterOverlay; w = w.get_parent()) {
      if (handlesPresses(w)) return    // a control owns this press
      owner = w
    }
    if (owner === null || owner === barBox) dismissOverlays()
  })
  masterOverlay.add_controller(barStripClick)

  masterOverlay.set_child(barBox)
  masterOverlay.add_overlay(expansionCapsule)  // below the major overlays
  masterOverlay.add_overlay(cc); masterOverlay.add_overlay(nc); masterOverlay.add_overlay(prism); masterOverlay.add_overlay(popups); masterOverlay.add_overlay(systemMenu)
  // (The island — capsule row + mode revealers — is mounted on its own surface
  // further down, once `center` has been built. NOT on masterOverlay.)

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
  const BAR_H = 40

  const PANEL_TOP = BAR_H + 8   // gap below the bar (8: same rhythm as the side gap)
  const SAFETY = 28
  const DOCK_VPAD = 20           // dock padding around its icons

  // Vertical space the dock reserves at the bottom (0 when docked to a side —
  // there it consumes horizontal space, handled by syncPanelMargins instead).
  const dockBottomFootprint = () =>
    dockSettings.position === 'bottom'
      ? dockSettings.iconSize + dockSettings.screenGap + DOCK_VPAD
      : 0

  // 8px side gap: panels sit flush with the bar capsules (which live 8px from
  // the screen edge) instead of the old 16 — the capsule alignment is a stronger
  // visual reference than the tiling gaps_out grid underneath.
  const SIDE_GAP = 8
  const NC_LANE = 8   // must match LANE in NotificationCenter.tsx

  cc.margin_top = PANEL_TOP
  nc.margin_top = PANEL_TOP
  expansionCapsule.margin_top = PANEL_TOP   // same gap below the bar as CC/NC
  systemMenu.margin_top = PANEL_TOP         // Bar owns the menu geometry (see syncPanelMargins)
  const syncPanelMargins = () => {
    const end = SIDE_GAP + (dockSideState.position === 'right' ? dockSideState.width : 0)
    cc.margin_end = end
    popups.margin_end = end
    // NC reserves a scrollbar lane on its right (LANE in NotificationCenter).
    // Pull the panel right by that much so its CONTENT edge still aligns with the
    // CC/clock capsule, with the lane living in the gap toward the screen edge.
    nc.margin_end = Math.max(0, end - NC_LANE)
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


      // Bar strip (40px)
      // @ts-ignore
      region.unionRectangle({ x: 0, y: 0, width: Math.round(geo().width), height: BAR_H })

      const isAnyOpen = status.isAnyOverlayOpen
      if (false) {
          // Catcher region — covers everything below bar to intercept outside-click dismissal
          // In edit mode we skip this so other windows remain interactive.
          // Skipped under a compositor focus grab too, for the opposite reason: the
          // dismissal happens ABOVE us, and a region covering the desktop would make
          // the outside press land on our own surface — which the grab accepts, so
          // nothing would dismiss at all.
          // @ts-ignore
          region.unionRectangle({ x: 0, y: BAR_H, width: Math.round(geo().width), height: Math.round(geo().height - BAR_H) })
      }

      const addWidgetToRegion = (widget: Gtk.Widget) => {
          if (!widget.get_visible()) return
          const alloc = widget.get_allocation()
          if (alloc.width <= 1 || alloc.height <= 1) return
          // @ts-ignore
          region.unionRectangle({ x: Math.round(alloc.x), y: Math.round(alloc.y), width: Math.round(alloc.width), height: Math.round(alloc.height) })
      }
      addWidgetToRegion(cc); addWidgetToRegion(nc); addWidgetToRegion(prism); addWidgetToRegion(systemMenu)
      // The island's revealers are NOT in this window any more — its surface
      // stamps its own region (islandWin.updateInputRegion), and everything
      // outside the island stays click-through there.
      addWidgetToRegion(expansionCapsule)

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
  // is most of any interaction. The island genuinely cannot do better (its modes
  // arrive through a MorphRevealer, which has no final allocation until the
  // morph lands); these panels are `ScaleRevealer` + OVERLAY_POP with
  // `animateLayout: false`, so the allocation is the FINAL one from the first
  // laid-out frame and the 0.97→1.0 pop paints INSIDE it.
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

  // The banner stack is settled (its box's allocation describes every banner in
  // it). False between a banner being appended and the deferred stamp that
  // follows its grow-in — the window in which the box's bounds are a lie.
  let popupsSettled = true

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
  // An open ISLAND mode does not count either, and no longer needs excluding by
  // hand: the island paints on its own surface, so nothing of it is a child here
  // and this window still declares only the strip — and a long activity (media,
  // the assistant) is exactly when that saving matters.
  // Everything else answers with `tickId` as well as `get_visible()`: a panel
  // closing is still visible until its final tick, and dropping its rect one
  // tick early would scissor away the tail of its own close animation.
  const paintedRects = (box: BlurRect): BlurRect[] | null => {
      // The strip's own extent. Measured rather than hardcoded (the 8px top
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
          rects.push(fullWidth
              ? { x: 0, y: Math.round(b.get_y()) - PANEL_PAD, width: box.width, height: Math.round(height) + PANEL_PAD * 2 }
              : { x: Math.round(b.get_x()) - PANEL_PAD, y: Math.round(b.get_y()) - PANEL_PAD,
                  width: Math.round(b.get_width()) + PANEL_PAD * 2, height: Math.round(height) + PANEL_PAD * 2 })
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
  ;(popups as any).onStackChanged = () => { popupsSettled = true; updateInputRegion() }
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
  const popToggle = (pop: ScaleRevealer | MorphRevealer) => (open: boolean) =>
      pop.reveal(open, () => { if (!open) updateInputRegion() })
  const setCCVisible = popToggle(cc)
  const setNCVisible = popToggle(nc)
  const setSystemMenuVisible = popToggle(systemMenu)
  const setPrismVisible = popToggle(prism)

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

  // The island's own surface: same reveal contract, only the region it refreshes
  // belongs to that window. The surface stays MAPPED — the capsule lives on it,
  // so there is no "closed" state to unmap into.
  const syncIslandModes = () => {
    island.sync((r, open) => r.reveal(open, () => { if (!open) islandWin.updateInputRegion() }))
    islandWin.updateInputRegion()
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

  // Modality for this window is a compositor focus grab, and nothing else. Reached
  // through syncOverlays(), which calls it FIRST because the input region is
  // computed from its result; it guards on `layerShellReady` so the
  // construction-time syncOverlays() cannot touch layer-shell before
  // init_for_window. The island grabs on ITS OWN surface — there is exactly one
  // grab slot compositor-wide, so the two must never want it at the same time.
  //
  // Both grabs are suspended while `inputYield` is active: a grab clamps pointer
  // focus to the grabbed surface, so computer-use cannot reach the app it was asked
  // to drive until we let go (core/InputYield).
  // Which states want THIS window to own input. Note what it is not:
  //
  //  · NOT `isAnyOverlayOpen` — that includes `island_mode`, which lives on the
  //    island's own surface. There is exactly ONE grab slot in the compositor, so
  //    letting both windows want it at the same time makes them evict each other,
  //    and the loser's `cleared` would close what the winner just opened.
  //  · NOT just Prism any more. Prism is the only overlay here that needs the
  //    KEYBOARD, but every one of them wants MODALITY — "clicking outside closes
  //    me" — which was the catcher's whole job.
  //  · NOT `cc_edit_mode`: it is the one open state that deliberately leaves the
  //    desktop interactive, and a grab would take that away.
  const barModal = () =>
    (status.cc_open || status.nc_open || status.prism_open || status.system_menu_open
      || status.bar_expanded_id !== "") && !status.cc_edit_mode
  const barGrabbing = () => barModal()
  // ⚠️ ANY open island mode, not just the keyboard-driven ones. Under layer-shell
  // only an EXCLUSIVE mode took input, so this used to read `island.needsKeyboard()`
  // — but a focus grab clamps POINTER focus too, and syncIslandGrab takes one for
  // every mode. Left narrow, an ambient mode (media, a running activity) would hold
  // the pointer while inputYield reported nobody holding anything, and computer-use
  // clicks would land on the island instead of the app they were aimed at.
  const islandGrabbing = () => !!status.island_mode

  // The compositor took the grab away. Three causes, indistinguishable from here
  // (see common/FocusGrab.ts): an outside press — the dismissal we asked for — a
  // popup grab stealing the single slot, or a layer surface mapping with keyboard
  // interactivity. This window's answer is the same for all three: whatever is open
  // is no longer modal, so it closes.
  //
  // Nothing in THIS window opens a popover, which is what makes one grab safe for
  // all of its overlays. The app grid does, and is migrated anyway: FocusGrab
  // suspends the lease for the life of a popup rather than reading the eviction as
  // a dismissal (see common/FocusGrab.ts and DockCore).
  const onBarGrabCleared = () => {
    barGrabToken = 0
    // Close ONLY what this window owns — deliberately NOT dismissOverlays(), which
    // also clears island_mode. An eviction can come from the ISLAND taking the
    // single slot for a mode the user just opened, and reaching that far would close
    // it again. The wider behaviour belongs to `dismissOverlays`, which runs off a
    // REAL click on the bar strip rather than off an eviction.
    if (!status.cc_edit_mode) {
      status.cc_open = false; status.nc_open = false
      status.prism_open = false; status.system_menu_open = false
      status.bar_expanded_id = ""
    }
    // dismissOverlays is a no-op in edit mode, and a closed overlay re-enters here
    // through its notify handler — but neither is guaranteed, so settle the region
    // unconditionally rather than relying on a notify that may not fire.
    updateInputRegion()
  }

  // Named for what it used to switch. It no longer touches layer-shell keyboard
  // interactivity at all: this surface is set to NONE once at init and stays there,
  // because EXCLUSIVE is what puts us in m_exclusiveLSes and makes Hyprland refuse
  // to move window focus (the whole reason core/InputYield exists), and the grab
  // already carries the keyboard.
  const syncKeyboardMode = () => {
    if (!layerShellReady) return
    const want = barGrabbing() && !inputYield.active

    if (want && !barGrabToken) {
      // The ISLAND's surface is whitelisted alongside ours, symmetrically to what
      // syncIslandGrab does for us. Not a nicety: the island's capsule MOVED to its
      // own surface (the documented exception to commandment #5), so leaving it out
      // clamps pointer focus to the bar and a click on the capsule is swallowed by
      // the dismissal instead of reaching it — the island stops responding for as
      // long as a bar panel is open.
      barGrabToken = acquireFocusGrab([win, islandWin.win], onBarGrabCleared)
      // A refusal is not a degrade — there is no second mechanism left. Say what is
      // broken and what it costs, once per open, so a session in that state can be
      // diagnosed from the log alone instead of from the symptoms.
      if (!barGrabToken)
        console.error("[Bar] focus grab REFUSED — no modality: nothing dismisses these panels and Prism cannot be typed into.")
    } else if (!want && barGrabToken) {
      releaseFocusGrab(barGrabToken)
      barGrabToken = 0
    }
  }
  // The island is modal for ANY open mode, not just the keyboard-driven ones —
  // an ambient player wants "click outside closes" exactly as much. It grabs the
  // BAR's surface alongside its own so a click on another bar capsule still
  // switches in one go; without that peer the press would be swallowed by the
  // dismissal (see common/FocusGrab.ts). There is no fallback for when that fails —
  // the compositor grab IS the mechanism (see FocusGrab's header), so a false here
  // is a broken desktop and says so rather than degrading in silence.
  const syncIslandGrab = () => {
    const open = !!status.island_mode
    // The `!inputYield.active` term is the same one syncKeyboardMode carries, and it
    // is here for the same reason — `setModal` applies it internally, so without it
    // this call reads a DELIBERATE release as a broken desktop. It fired on every
    // computer-use action taken from the Assistant (which is an open island by
    // definition): five CRITICALs in one 2026-08-12 log, under two shell PIDs,
    // describing a grab nobody had asked for. An alarm that cries during the one
    // situation it cannot distinguish is worse than no alarm — it was sitting next to
    // a real bug (the yield eating the caller's focus, see core/InputYield) and made
    // it look like the same thing.
    if (!islandWin.setModal(open, [win]) && open && !inputYield.active)
      console.error("[Bar] island modality: NO compositor focus grab — nothing will dismiss it")
  }

  inputYield.registerHolder(barGrabbing)
  inputYield.registerHolder(islandGrabbing)
  inputYield.connect("notify::active", () => {
    // Yielding drops the grab, so for as long as the truce lasts an overlay left
    // open is NOT dismissable by clicking outside — the agent owns the pointer, and
    // the grab (with its dismissal) comes back when it hands it over.
    syncKeyboardMode()
    syncIslandGrab()
    updateInputRegion()
    islandWin.updateInputRegion()
  })

  status.connect("notify::island-mode", () => {
    // Immediately: our own grab and whatever Status's mutual exclusion just
    // closed. The island itself waits for its surface (below).
    syncOverlays()   // runs syncKeyboardMode first — see its body
    if (status.island_mode) {
      // Re-assert our layer level in case the bar is currently in overlay mode
      // (it moves to OVERLAY too, which would otherwise stack it above us).
      islandWin.raise()
      // Pin the island's top to the capsule's top before the reveal (the capsule
      // ref is the truth — survives layout changes). Same surface, so this is an
      // ordinary measurement; no deferred frame needed.
      island.syncAnchor(islandWin.root(), PANEL_TOP)
    }
    // The island's own surface owns its region: a grab clamps pointer focus to the
    // grabbed surface, so while a mode is open every press is delivered THERE first
    // and the bar never sees it. (Under the old catcher this is why the overview and
    // the assistant stopped closing while the ambient player kept working: only the
    // keyboard modes took the grab back then.) The bar strip stays reachable because
    // the island whitelists it as a peer, which is what keeps capsule-to-capsule
    // switching ONE click.
    syncIslandModes()
    syncIslandGrab()
    if (status.island_mode) island.onOpened()   // seed the mode's keyboard nav
  })

  // Route keys to the open island mode (overview: ←/→ move the cursor, Enter
  // switches + closes, Esc closes). CAPTURE phase so it fires before any focused
  // child — mirrors the app grid's key controller on the dock window. Lives on
  // the ISLAND's window: that's the surface holding the keyboard grab, so it is
  // where the key events actually arrive.
  const islandKeyCtrl = new Gtk.EventControllerKey()
  islandKeyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  islandKeyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
    if (!status.island_mode) return false
    return island.handleKey(keyval)
  })
  islandWin.win.add_controller(islandKeyCtrl)

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
      } else if (id === OVERFLOW_ID) {
          if (!overflowContentBuilder) return
          content = overflowContentBuilder(onClose)
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

  const left = new Gtk.Box({ css_classes: ["bar-left"], halign: Gtk.Align.START, hexpand: false, spacing: 8 })
  const sysMenuWidget = SystemMenuIcon()
  const appTitle = AppTitle(geo().width, openCustomExpansion)
  const appTitleWidget = appTitle.widget
  // The system-menu capsule has no visibility setting on purpose: it owns the
  // only GUI path to log out / restart / shut down (SystemMenu.tsx), and the
  // exit-session keybind was deliberately not shipped, so hiding it leaves no
  // way to end the session. Every other DE that is not an explicit panel-builder
  // makes the same call (macOS/GNOME/Windows never let you remove it). The
  // island's centre box below is permanent for the sibling reason — see barState.
  appTitleWidget.set_visible(barSettings.showAppTitle)
  left.append(sysMenuWidget)
  left.append(appTitleWidget)
  // NO spacing — the gap lives on each chip's own margin (see ActivityIsland).
  // A Gtk.Box reserves its spacing between every VISIBLE child, and a collapsed
  // Gtk.Revealer is still visible (it just measures 0), so spacing here would
  // hold a permanent 8px to the right of the capsule and leave it off-centre in
  // an idle session — the one state that must look exactly as it always has.
  // The GROUP is what centres: a chip appearing shifts the capsule off the
  // monitor's axis, which is the cost of the iOS split and is only ever paid
  // while something is actually running.
  const center = new Gtk.Box({ css_classes: ["bar-center"], halign: Gtk.Align.CENTER })
  center.append(island.capsule)      // the island's compact state
  center.append(island.indicatorRow) // live activities that are NOT fronting it
  // `center` is NOT put in the bar's CenterBox: the capsule paints on the
  // island's surface (see islandWin above). It goes into a row that reuses the
  // SAME `.bar-centerbox` class the bar's own row does, so the 8px top margin
  // and the 40px row height come from one CSS rule instead of a constant
  // duplicated across two windows — the capsule lands pixel-identically where
  // the bar would have drawn it. `center` still exists and still holds the live
  // capsule, so `measureOverflow` can keep measuring its natural width.
  const islandRow = new Gtk.Box({ css_classes: ["bar-centerbox"], height_request: BAR_H, valign: Gtk.Align.START })
  islandRow.append(center)
  center.hexpand = true           // halign CENTER inside a full-width row
  islandWin.mount(islandRow, island.hitTargets, island.revealers)
  // Keep the island level with the bar. Both surfaces are full-rect at y=0 in the
  // normal case, so this is a no-op — it only matters when something reserves
  // space ABOVE the bar (Hyprland's config-error bar), which slides the bar down
  // while the island's `exclusive_zone = -1` keeps it put, leaving the capsule
  // floating over the row it belongs to (user-caught 2026-08-02, reproduced with
  // a reserving layer created before the shell).
  //
  // `configreloaded` is when that bar APPEARS, but it is NOT when it goes away,
  // and reading the bar's position once on that event turned the fix into its own
  // bug: fix the config and the island stayed down forever (user-caught
  // 2026-08-04). Hyprland's own source says why (src/errorOverlay/Overlay.cpp,
  // v0.56.0): creating the overlay reserves and re-arranges layers on the spot,
  // but `destroy()` only sets `m_queuedDestroy` — the reservation is released, and
  // the layers re-arranged, inside `draw()` and only once the fadeOut animation has
  // ENDED. So the release lands an animation later than the event that caused it,
  // on no event of its own, at a delay the user's animation config decides.
  //
  // Nothing client-side can see it either: a layer surface is only told about its
  // SIZE, and the bar's never changes (top/left/right anchors, no bottom anchor →
  // client-chosen height), so a pure vertical move produces no configure we could
  // hook. Polling is the only instrument, so poll where it costs nothing: measure
  // on the event, and then keep watching ONLY while displaced. A healthy session
  // polls zero times; a broken-config session — already degraded, and being fixed
  // right now — pays one `hyprctl layers` every 400 ms until the bar comes home.
  const monName = gdkmonitor.get_connector() ?? undefined
  let islandWatch = 0
  const syncIslandToBar = () =>
    hs.layerTop("nidara-bar", monName).then(y => {
      if (y === null) return
      // layerTop is global; the island's margin is monitor-local
      const offset = Math.max(0, y - geo().y)
      islandWin.setTopOffset(offset)
      if (offset > 0 && !islandWatch) {
        islandWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
          syncIslandToBar(); return GLib.SOURCE_CONTINUE
        })
      } else if (offset === 0 && islandWatch) {
        GLib.source_remove(islandWatch); islandWatch = 0
      }
    })
  // The deferred first call waits for our own surface to exist to be measured; it
  // also covers a session that STARTS with a broken config (the error bar is up
  // before the shell is, and no `configreloaded` will ever announce it).
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => { syncIslandToBar(); return GLib.SOURCE_REMOVE })
  // Two reads per reload, not one: the overlay is created from `draw()`, i.e. a
  // frame AFTER the event, so the immediate read can legitimately still see the
  // old position. The second one starts the watch, and from there the watch owns it.
  hs.connect("config-reloaded", () => {
    syncIslandToBar()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { syncIslandToBar(); return GLib.SOURCE_REMOVE })
  })
  // The capsule is a CLICK TARGET living on a mostly click-through surface, so
  // its rect in the input region has to track its real size — and that size
  // moves on its own: the compact stack interpolates width when the fronting
  // activity changes, and a media title of a different length reshapes the pill
  // with no page change at all. The glass DrawingArea's `resize` fires on
  // exactly those, and only those.
  ;(island.capsule as any).glassArea?.connect("resize", () => islandWin.updateInputRegion())
  // A chip appearing or leaving moves the capsule sideways WITHOUT resizing it,
  // so the resize hook above never fires for it and both the chip's rect and the
  // capsule's displaced one would stay unstamped. Re-stamped after the reveal
  // lands (the slide takes COMPACT_SWAP_MS; the capsule may still be settling,
  // and while it is, the resize hook keeps stamping anyway).
  island.onBackgroundChanged(() => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      islandWin.updateInputRegion(); return GLib.SOURCE_REMOVE
    })
  })
  // …and again when the slide actually ENDS, which is the frame the row's final
  // rects exist. The 400ms above is a guess at that moment and it only has to be
  // wrong once: nothing else re-cuts the region for a chip, so a stamp taken while
  // the row was still moving leaves that chip painted where the compositor sends
  // nothing, for as long as the layout holds. Both are kept — the timer covers a
  // reveal that never animates, this covers one that outlasts it.
  island.onChipsSettled(() => islandWin.updateInputRegion())
  // …and the moment the chips re-ENTER the hit set at all. `hitTargets()` returns
  // the capsule alone while the row is faded to nothing, so every stamp taken with
  // a mode open drops the chips' rects deliberately — and that becomes the reported
  // symptom the instant nothing re-stamps once they ramp back. The re-stamp is
  // supposed to come from `MorphRevealer.reveal`'s `onDone`, which does not run if
  // the morph is interrupted (a mode switched mid-close). The trap caught exactly
  // that once, 2026-08-13 04:38: *"stamped 1 target(s), 6 are live now and nothing
  // re-stamped"*. Opacity does not affect `compute_bounds`, so the crossing back off
  // zero is already a measurable layout — one stamp, at the only moment that matters.
  let chipsWereHidden = island.indicatorRow.opacity === 0
  island.indicatorRow.connect("notify::opacity", () => {
    const hidden = island.indicatorRow.opacity === 0
    if (chipsWereHidden && !hidden) islandWin.updateInputRegion()
    chipsWereHidden = hidden
  })
  const right = new Gtk.Box({ css_classes: ["bar-right"], halign: Gtk.Align.END, spacing: 8 })
  // Absorbs SizeGroup slack so actual capsules stay pinned to the right edge.
  // When left > right (long window title), SizeGroup widens the right allocation;
  // without this spacer, children would pack from the left of that wider slot.
  const rightSpacer = new Gtk.Box({ hexpand: true })
  right.append(rightSpacer)

  // Keep workspace capsule at the true monitor center regardless of how wide the
  // right side grows.  SizeGroup makes both sides request max(left, right) width,
  // so CenterBox always sees equal flanks and places center at exactly width/2.
  const sideGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL })
  sideGroup.add_widget(left)
  sideGroup.add_widget(right)

  const timeContent = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 16 })
  const timeLabel = new Gtk.Label({ label: "..." })
  const updateClock = () => {
    const next = regionConfig.formatClock()
    if (timeLabel.label !== next) timeLabel.label = next
  }
  const clockTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => { updateClock(); return GLib.SOURCE_CONTINUE })
  timeLabel.connect("unrealize", () => { try { GLib.source_remove(clockTimer) } catch {} })
  regionConfig.connect("changed", updateClock)
  updateClock()
  const bellIcon = new Gtk.Image({ gicon: Icons.bell, pixel_size: 16, visible: false , css_classes: ["nd-icon"] })
  try {
    const notifd = AstalNotifd.get_default()
    const syncBell = () => { bellIcon.set_visible(notifd.notifications.length > 0) }
    notifd.connect("notified", syncBell)
    notifd.connect("resolved", syncBell)
    syncBell()
  } catch {}
  timeContent.append(bellIcon); timeContent.append(timeLabel)

  // Optional bar widgets (before Tray, reactive to config changes)
  const optWidgets = new Gtk.Box({ css_classes: ["bar-optional-widgets"], spacing: 8 })

  const getMaxIcons = (): number => cachedMaxIcons ?? Infinity

  const buildOverflowList = (hiddenIds: string[]): Gtk.Widget => {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    for (const id of hiddenIds) {
      const w = registry.get(id)
      if (!w) continue
      const hasExpand = !!w.buildBarExpanded
      const hasCCDetail = !!w.buildCCDetail
      const row = new Gtk.Box({ spacing: 12 })
      row.append(new Gtk.Image({ gicon: w.icon, pixel_size: 16, css_classes: ["nd-icon"] }))
      row.append(new Gtk.Label({ label: w.name, halign: Gtk.Align.START, hexpand: true }))
      const btn = new Gtk.Button({ child: row, css_classes: ["nidara-menu-row"], hexpand: true })
      btn.connect("clicked", () => {
        // Same first refusal as a visible pill (see rebuildBarWidgets) — an
        // overflowed widget must not behave differently from a shown one.
        if (w.barClick?.()) { status.bar_expanded_id = ""; return }
        if (hasExpand) {
          status.bar_expanded_id = id
        } else if (hasCCDetail) {
          status.bar_expanded_id = ""
          status.cc_open = true
          status.cc_detail_id = id
        }
      })
      box.append(btn)
    }
    return box
  }

  const rebuildBarWidgets = () => {
    if (status.bar_expanded_id) status.bar_expanded_id = ""
    capsuleRefs.clear()
    overflowContentBuilder = null
    let child = optWidgets.get_first_child()
    while (child) { const n = child.get_next_sibling(); optWidgets.remove(child); child = n }

    // Hardware gate: widgets without their hardware don't render or take a slot,
    // regardless of the user's saved placement (which stays untouched).
    const allIds = widgetConfig.barWidgetIds().filter(id => {
        const w = registry.get(id)
        return !!w && widgetAvailable(w)
    })
    const maxIcons = getMaxIcons()
    const needsOverflow = allIds.length > maxIcons
    // Reserve 1 slot for the overflow capsule itself when overflow is needed
    const visibleCount = needsOverflow ? Math.max(0, maxIcons - 1) : allIds.length
    const visibleIds = allIds.slice(0, visibleCount)
    const hiddenIds = allIds.slice(visibleCount)

    for (const id of visibleIds) {
      const w = registry.get(id)
      if (!w?.buildBarContent) continue
      const hasExpand = !!w.buildBarExpanded
      const hasCCDetail = !!w.buildCCDetail
      // cc_edit_mode (not cc_open): while editing the CC the pills stay inert;
      // with the CC merely open, a pill click switches to its surface directly
      // (the bar_expanded_id setter closes the exclusive overlays).
      // barClick gets first refusal on EVERY click (asked here, not cached at
      // build time) so a widget can act directly in a state where opening a panel
      // would only be in the way — screenrecord stops the capture. See Types.ts.
      const open = hasExpand
          ? () => { status.bar_expanded_id = status.bar_expanded_id === id ? "" : id }
          : hasCCDetail
              ? () => { status.cc_open = true; status.cc_detail_id = id }
              : undefined
      const onRelease = (hasExpand || hasCCDetail || w.barClick)
          ? () => {
              if (status.cc_edit_mode) return
              if (w.barClick?.()) { status.bar_expanded_id = ""; return }
              open?.()
          }
          : undefined
      const capsule = SquircleContainer({
          child: w.buildBarContent(), gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar",
          borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true,
      })
      if (onRelease) {
          // BUBBLE + released: child buttons claim on press → deny this gesture → released
          // never fires when a button is clicked; fires only for neutral-area taps.
          const g = new Gtk.GestureClick()
          g.connect("released", onRelease)
          capsule.add_controller(g)
      }
      if (hasExpand) capsuleRefs.set(id, capsule)
      optWidgets.append(capsule)
    }

    if (hiddenIds.length > 0) {
      overflowContentBuilder = () => buildOverflowList(hiddenIds)
      const overflowLabel = new Gtk.Label({ label: "···", css_classes: ["bar-overflow-label"], margin_start: 12, margin_end: 12 })
      const overflowCapsule = SquircleContainer({
          child: overflowLabel, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar",
          borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true,
      })
      const g = new Gtk.GestureClick()
      g.connect("released", () => {
          if (status.cc_edit_mode) return
          status.bar_expanded_id = status.bar_expanded_id === OVERFLOW_ID ? "" : OVERFLOW_ID
      })
      overflowCapsule.add_controller(g)
      capsuleRefs.set(OVERFLOW_ID, overflowCapsule)
      optWidgets.append(overflowCapsule)
    }
  }
  widgetConfig.connect("changed", () => {
      // measureOverflow rebuilds against the full set, measures, then caps —
      // so it recovers correctly when widgets are added/removed.
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { measureOverflow(); return GLib.SOURCE_REMOVE })
  })
  // Hardware appearing/disappearing (BT dongle, wifi device…) re-runs the same path.
  watchWidgetAvailability(() => {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { measureOverflow(); return GLib.SOURCE_REMOVE })
  })
  rebuildBarWidgets()

  right.append(optWidgets)

  // Tray items each carry their own glass capsule (built in Tray.tsx), so there's
  // no outer grouping capsule here — the tray is a plain spacing container that
  // manages its own visibility (hidden while empty).
  const trayInner = Tray(openCustomExpansion)
  right.append(trayInner)
  const searchCapsule = SquircleContainer({ child: new Gtk.Image({ gicon: Icons.search, pixel_size: 16, margin_start: 16, margin_end: 16 , css_classes: ["nd-icon"] }), onClick: () => status.togglePrism(), gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  right.append(searchCapsule)
  // CC capsule layout: [16px left pad][gear 16px][16px right-gap] = 48px (matches the
  // search capsule). The status-indicator dot (recording / AI control) sits in that right
  // gap WITHOUT widening the capsule, centred between the icon's right edge and the capsule's
  // right edge. We overlay the dot on the whole content and centre it within a region that
  // starts `margin_start` from the left, so its centre lands at (margin_start / 2) + 24.
  //   Centre in the DRAWN geometry, not GTK's allocation: both the squircle and the glyph draw
  //   ~3px INSIDE their boxes (measured). So the capsule's visible right edge ≈ alloc-x 45 (not
  //   48) and the icon's visible right edge ≈ 29 (not its box edge 32). Visible gap = [29, 45]
  //   → centre (29 + 45) / 2 = 37 → margin_start = 26 (verified: 5px air each side of the dot).
  //   (Centring on the allocation boxes gives 40, which looks pegged-right because both draw narrower.)
  // The gap is a plain 16px spacer that just reserves the width (no shift when the dot shows/hides).
  // Detail + Stop/kill-switch live in the CC banner. Badge can_target:false → clicks hit the capsule.
  const ccGear = new Gtk.Image({ gicon: Icons.settings2, pixel_size: 16, margin_start: 16, css_classes: ["nd-icon"] })
  const ccInner = new Gtk.Box({ valign: Gtk.Align.CENTER })
  ccInner.append(ccGear)
  ccInner.append(new Gtk.Box({ width_request: 16 }))   // reserve the right gap → capsule stays 48px
  const ccDot = ccBadge()
  ccDot.set_margin_start(26)                            // dot centre = 37px — centred between the icon's and capsule's VISIBLE (drawn) right edges (5px air each side)
  const ccOverlay = new Gtk.Overlay()
  ccOverlay.set_child(ccInner)
  ccOverlay.add_overlay(ccDot)
  const ccBtn = SquircleContainer({ child: ccOverlay, onClick: () => status.toggleCC(), gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  right.append(ccBtn)
  const timeCapsule = SquircleContainer({ child: timeContent, onClick: () => status.toggleNC(), gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  right.append(timeCapsule)

  // No center widget: the capsule that used to sit there paints on the island's
  // surface now. The SizeGroup below already forces equal flanks, so CenterBox
  // still places everything as before — it just has nothing to centre.
  barBox.set_start_widget(left); barBox.set_end_widget(right)

  onBarSettingsChanged((s) => {
    appTitleWidget.set_visible(s.showAppTitle)
  })

  const monitorHeight = gdkmonitor.get_geometry().height

  // ── Top zone reservation ──────────────────────────────────────────────────
  // The bar reserves its own 40 px top strip via exclusive_zone (set on `win`
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
  // zone 0 get pushed into the remaining usable area. The bar asks for 40, so it
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
    // Reserve the 40 px top strip for tiled windows (replaces the old nidara-bar-zone
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

  // Measure actual available space and greedy-fill icons; rebuild if overflow needed.
  // Uses measure() (natural/preferred width) instead of get_width() (allocated width)
  // so that a squished/overflowed bar state doesn't fool the calculation.
  const measureOverflow = () => {
      // Measure against the full, uncapped widget set. A previously collapsed bar
      // only contains the "···" pill, so measuring the live children would size the
      // pill instead of the real widgets and could never recover. Reset the cache
      // and rebuild (getMaxIcons → Infinity) so every widget is present first.
      cachedMaxIcons = null
      rebuildBarWidgets()

      const natW = (w: Gtk.Widget) => w.measure(Gtk.Orientation.HORIZONTAL, -1)[1]

      const iconWidths: number[] = []
      let c: Gtk.Widget | null = optWidgets.get_first_child()
      while (c) { iconWidths.push(natW(c)); c = c.get_next_sibling() }
      if (iconWidths.length === 0) return

      const spacing = 8
      const fixedCapsules: Gtk.Widget[] = [trayInner, searchCapsule, ccBtn, timeCapsule]
      const fixedW = fixedCapsules.reduce((s, w) => s + (w.get_visible() ? natW(w) + spacing : 0), 0)
      // Budget = space available to optWidgets before the right side would overlap the
      // workspace capsule. The workspace is centered, so each side gets at most:
      //   (geo().width - 16(bar margins) - workspace_nat) / 2
      // minus fixedW, minus the barBox margin_end (8px).
      const workspaceNat = natW(center)
      const budget = (geo().width - 16 - workspaceNat) / 2 - fixedW

      let total = 0
      let fitsCount = 0
      for (let i = 0; i < iconWidths.length; i++) {
          const cost = i === 0 ? iconWidths[i] : iconWidths[i] + spacing
          if (total + cost > budget) break
          total += cost
          fitsCount++
      }

      cachedMaxIcons = fitsCount
      if (widgetConfig.barWidgetIds().length > fitsCount) {
          rebuildBarWidgets()
      }
  }
  // Measure after first layout pass (bar realized but still invisible)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => { measureOverflow(); return GLib.SOURCE_REMOVE })

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
      measureOverflow()
      // The island's own numbers: its top margin is measured against the
      // monitor's Y (which moves when outputs are re-arranged), and its overview
      // solves the card size from the monitor's width.
      syncIslandToBar()
      island.onMonitorResized()
      // measureOverflow may have rebuilt the row and appTitle may have changed
      // width, so the strip's capsules are in new places. Both regions again.
      updateInputRegion()
      // And the island's, from HERE rather than only from its own geometry
      // handler. That one fires the instant the monitor changes, which is before
      // GTK has re-allocated anything: its 50 ms verify would then compare a stale
      // measurement against a stale stamp, agree, and stop. This one runs after
      // the debounce and after the row rebuild above, i.e. on the layout that is
      // going to persist — and the capsule is CENTRED, so it moves on a width
      // change without ever resizing, which is exactly the case its own
      // `glassArea "resize"` trigger cannot see.
      islandWin.updateInputRegion()
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
  let trackedBarClient: any = null
  let trackedBarClientConn: number | null = null

  const setBarFullscreenMode = (active: boolean) => {
      if (barFullscreenMode === active) return
      barFullscreenMode = active
      try {
          if (active && !barOverlayActive) {
              Gtk4LayerShell.set_exclusive_zone(win, 0) // release top reservation
              win.set_opacity(0)
              // The island is its own surface, and the CAPSULE lives on it — so
              // hiding the bar no longer hides it. Close any open mode and unmap
              // the surface, or the capsule floats alone over the fullscreen
              // window (and keeps costing a blur pass).
              status.island_mode = ""
              islandWin.setShown(false)
          } else if (!active) {
              if (barOverlayActive) {
                  // Exit overlay mode when fullscreen ends
                  barOverlayActive = false
                  Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              }
              Gtk4LayerShell.set_exclusive_zone(win, BAR_H) // restore top reservation
              win.set_opacity(1)
              // Bring the capsule back with the bar, and re-assert our level:
              // present() re-adds the surface to Hyprland's overlay list, and the
              // bar may have moved layers in between.
              islandWin.setShown(true)
              islandWin.raise()
          }
      } catch (e) {}
  }

  const checkBarFullscreen = () => {
      const client = hs.focusedClient ?? null
      // Skip rewire if focused client object hasn't changed
      if (client !== trackedBarClient) {
          if (trackedBarClient && trackedBarClientConn !== null) {
              safeDisconnect(trackedBarClient, trackedBarClientConn)
              trackedBarClientConn = null
          }
          trackedBarClient = client
          if (client) {
              trackedBarClientConn = client.connect("notify::fullscreen", () =>
                  setBarFullscreenMode(hs.isRealFullscreen(client)))
          }
      }
      setBarFullscreenMode(hs.isRealFullscreen(client))
  }

  hs.connect("changed", checkBarFullscreen)
  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { checkBarFullscreen(); return GLib.SOURCE_REMOVE })

  ;(win as any).setBarOverlayMode = (active: boolean) => {
      try {
          barOverlayActive = active
          if (active) {
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
              Gtk4LayerShell.set_exclusive_zone(win, 0) // release top reservation
              win.set_opacity(1)
              win.present()
              // The capsule comes back with the bar (fullscreen may have unmapped
              // it). Then re-assert our level: the bar just joined OVERLAY, which
              // appends it AFTER the island in Hyprland's list for that level, so
              // without this the bar would cover the island instead of being
              // blurred by it.
              islandWin.setShown(true)
              islandWin.raise()
          } else {
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              if (barFullscreenMode) {
                  Gtk4LayerShell.set_exclusive_zone(win, 0)
                  win.set_opacity(0)
                  status.island_mode = ""
                  islandWin.setShown(false)   // back to hidden-for-fullscreen
              } else {
                  Gtk4LayerShell.set_exclusive_zone(win, BAR_H) // restore top reservation
              }
          }
      } catch (e) { console.error("[Bar] setBarOverlayMode failed:", e) }
  }
  ;(win as any).isBarOverlayActive = () => barOverlayActive
  ;(win as any).isBarFullscreenMode = () => barFullscreenMode
  // The island's surface is created here but is a sibling toplevel — app.ts
  // tracks it alongside the bar so it takes part in teardown.
  ;(win as any).islandWindow = islandWin.win

  return win
}
