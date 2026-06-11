import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import AstalNotifd from "gi://AstalNotifd"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import { makeFadeToggle, FADE_HIDE_MS } from "../../common/fade"
import Cairo from "gi://cairo"
import Gio from "gi://Gio"

import SquircleContainer from "../../common/SquircleContainer"
import { CAPSULE_BORDER } from "./capsule"
import Theme from "../../core/ThemeManager"
import appService from "../../core/AppService"
import status from "../../core/Status"
import widgetConfig from "../../core/WidgetConfig"
import regionConfig from "../../core/RegionConfig"
import registry, { widgetAvailable, watchWidgetAvailability } from "../../widgets/index"
import Tray from "./Tray"
import { SystemMenuOverlay } from "./SystemMenu"
import { AppTitle } from "./AppTitle"
import { Workspaces } from "./Workspaces"

// Overlay panels mounted on the bar window (avoids separate layer-shell surfaces)
import { ControlCenterWidget } from "../control-center/ControlCenter"
import NotificationCenter from "../control-center/NotificationCenter"
import Prism from "../prism/Prism"
import { NotificationPopupsWidget } from "../control-center/NotificationPopups"
import WorkspaceOverview from "../overview/WorkspaceOverview"
import { execAsync } from "ags/process"
import { t } from "../../core/i18n"
import { barSettings, onBarSettingsChanged } from "./barState"
import { dockSideState, dockSettings, onDockSettingsChanged } from "../dock/state"
import Icons from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import hs from "../../core/HyprlandState"
import { SHELL_ROOT } from "../../core/Paths"

const ASSETS_DIR = SHELL_ROOT

export const LAUNCHER_ICON_PRESETS: Record<string, string> = {
  "arch": `${ASSETS_DIR}/assets/logos/arch-symbolic.svg`,
}

function resolveIconPath(key: string): string | null {
  if (LAUNCHER_ICON_PRESETS[key]) return LAUNCHER_ICON_PRESETS[key]
  if (key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)) return key
  return null
}

function SystemMenuIcon(): Gtk.Widget {
  const img = new Gtk.Image({ pixel_size: 18, css_classes: ["bar-distro-icon"], margin_start: 14, margin_end: 14 })

  const applyIcon = () => {
    const path = resolveIconPath(barSettings.launcherIcon || "arch")
    if (path) {
      img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path))
    } else {
      img.gicon = null
      img.gicon = Icons.grid
    }
  }

  applyIcon()
  onBarSettingsChanged(applyIcon)

  return SquircleContainer({ child: img, gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true, onClick: () => status.toggleSystemMenu() })
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const monGeo = gdkmonitor.get_geometry()
  const win = new Gtk.Window({
    name: "crystal-bar",
    application: app,
    css_classes: ["crystal-bar-window"],
    default_width: monGeo.width,
    default_height: monGeo.height, // Stay full height for CC/NC
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
  let overflowContentBuilder: ((onClose: () => void) => Gtk.Widget) | null = null
  // Measurement cache — populated after first layout; used to cap visible icons
  let cachedMaxIcons: number | null = null
  const capsuleRefs = new Map<string, Gtk.Widget>()
  const expansionInner = new Gtk.Box({ margin_top: 10, margin_bottom: 10, margin_start: 14, margin_end: 14 })
  const expansionCapsule = SquircleContainer({
      child: expansionInner, gloss: true, useShellOpacity: true,
      borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, radius: 20,
      // overlay-fade → same opacity crossfade as CC/NC (toggled via overlay-open)
      css_classes: ["bar-expansion-panel", "overlay-fade"],
  })
  expansionCapsule.valign = Gtk.Align.START
  expansionCapsule.halign = Gtk.Align.END
  // margin_top set below to PANEL_TOP so the gap matches CC/NC exactly.
  expansionCapsule.visible = false

  const cc = ControlCenterWidget(gdkmonitor)
  const nc = NotificationCenter()
  const prism = Prism()
  const popups = NotificationPopupsWidget()
  const systemMenu = SystemMenuOverlay()
  const overview = WorkspaceOverview(gdkmonitor)
  // Invisible full-screen button — dismisses any open overlay on outside click
  const catcher = new Gtk.Button({ css_classes: ["overlay-catcher"], visible: false, hexpand: true, vexpand: true })
  catcher.connect("clicked", () => {
    if (status.cc_edit_mode) return   // don't close CC while in edit mode
    status.cc_open = false; status.nc_open = false; status.prism_open = false; status.system_menu_open = false
    status.overview_open = false; status.bar_expanded_id = ""
  })

  masterOverlay.set_child(barBox)
  masterOverlay.add_overlay(catcher)       // behind panels, above bar base
  masterOverlay.add_overlay(expansionCapsule)  // above catcher, below major overlays
  masterOverlay.add_overlay(cc); masterOverlay.add_overlay(nc); masterOverlay.add_overlay(prism); masterOverlay.add_overlay(popups); masterOverlay.add_overlay(systemMenu); masterOverlay.add_overlay(overview)

  cc.valign = Gtk.Align.START; cc.halign = Gtk.Align.END
  nc.valign = Gtk.Align.START; nc.halign = Gtk.Align.END
  prism.valign = Gtk.Align.CENTER; prism.halign = Gtk.Align.CENTER
  popups.valign = Gtk.Align.START; popups.halign = Gtk.Align.END
  overview.valign = Gtk.Align.CENTER; overview.halign = Gtk.Align.CENTER

  // ── Panel geometry ──────────────────────────────────────────────────────
  // Derived from the bar height and the dock's actual footprint (dock size is
  // user-configurable) instead of hardcoded magic numbers.
  const BAR_H = 40
  const PANEL_TOP = BAR_H + 16   // gap below the bar
  const SAFETY = 28
  const DOCK_VPAD = 20           // dock padding around its icons

  // Vertical space the dock reserves at the bottom (0 when docked to a side —
  // there it consumes horizontal space, handled by syncPanelMargins instead).
  const dockBottomFootprint = () =>
    dockSettings.position === 'bottom'
      ? dockSettings.iconSize + dockSettings.screenGap + DOCK_VPAD
      : 0

  cc.margin_top = PANEL_TOP
  nc.margin_top = PANEL_TOP
  expansionCapsule.margin_top = PANEL_TOP   // same gap below the bar as CC/NC
  const syncPanelMargins = () => {
    const end = 16 + (dockSideState.position === 'right' ? dockSideState.width : 0)
    cc.margin_end = end
    // NC reserves a 14px scrollbar lane on its right (see LANE in NotificationCenter).
    // Pull the panel right by that much so its CONTENT edge still aligns with the CC,
    // with the lane living in the gap toward the screen edge/dock.
    nc.margin_end = Math.max(2, end - 14)
  }
  syncPanelMargins()
  dockSideState.subscribe(syncPanelMargins)

  prism.margin_top = 0
  popups.margin_top = PANEL_TOP; popups.margin_end = 16

  // NC fills the gap between bar and dock; CC is capped to the same budget so it
  // never overflows on short screens (was a fixed 800px). Reactive to dock size.
  const applyPanelHeights = () => {
    const maxH = monGeo.height - BAR_H - dockBottomFootprint() - SAFETY
    nc.height_request = maxH
    cc.height_request = Math.min(800, maxH)
  }
  applyPanelHeights()
  onDockSettingsChanged(applyPanelHeights)

  const updateInputRegion = () => {
      const surface = win.get_native()?.get_surface()
      if (!surface) return
      const region = new Cairo.Region()
      
      // Bar strip (40px)
      // @ts-ignore
      region.unionRectangle({ x: 0, y: 0, width: Math.round(monGeo.width), height: 40 })

      const isAnyOpen = status.isAnyOverlayOpen
      if (isAnyOpen && !status.cc_edit_mode) {
          // Catcher region — covers everything below bar to intercept outside-click dismissal
          // In edit mode we skip this so other windows remain interactive
          // @ts-ignore
          region.unionRectangle({ x: 0, y: 40, width: Math.round(monGeo.width), height: Math.round(monGeo.height - 40) })
      }

      const addWidgetToRegion = (widget: Gtk.Widget) => {
          if (!widget.get_visible()) return
          const alloc = widget.get_allocation()
          if (alloc.width <= 1 || alloc.height <= 1) return
          // @ts-ignore
          region.unionRectangle({ x: Math.round(alloc.x), y: Math.round(alloc.y), width: Math.round(alloc.width), height: Math.round(alloc.height) })
      }
      addWidgetToRegion(cc); addWidgetToRegion(nc); addWidgetToRegion(prism); addWidgetToRegion(systemMenu); addWidgetToRegion(overview)
      addWidgetToRegion(expansionCapsule)
      
      // Add each popup individually to the input region
      let child = popups.get_first_child()
      while (child) {
          addWidgetToRegion(child)
          child = child.get_next_sibling()
      }

      if (surface.set_input_region) surface.set_input_region(region)
  }

  // Unified overlay fade (opacity crossfade via .overlay-fade/.overlay-open CSS).
  // makeFadeToggle lives in common/fade; pass updateInputRegion so the layer-shell
  // input region is refreshed once each panel has actually faded out.
  const setCCVisible = makeFadeToggle(cc, updateInputRegion)
  const setNCVisible = makeFadeToggle(nc, updateInputRegion)
  const setSystemMenuVisible = makeFadeToggle(systemMenu, updateInputRegion)

  // V9.0: Animated Overview — CSS transition driven by class toggle
  let overviewHideTimer: number | null = null
  const setOverviewVisible = (open: boolean) => {
      if (overviewHideTimer) { GLib.source_remove(overviewHideTimer); overviewHideTimer = null }
      if (open) {
          overview.set_visible(true)
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => { overview.add_css_class("overview-open"); return GLib.SOURCE_REMOVE })
      } else {
          overview.remove_css_class("overview-open")
          overviewHideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
              if (!status.overview_open) {
                  overview.set_visible(false)
                  updateInputRegion() // re-evaluate now that overview is actually gone
              }
              overviewHideTimer = null; return GLib.SOURCE_REMOVE
          })
      }
  }

  const syncOverlays = () => {
    catcher.set_visible(status.isAnyOverlayOpen && !status.cc_edit_mode)
    setCCVisible(status.cc_open); setNCVisible(status.nc_open); prism.set_visible(status.prism_open); setSystemMenuVisible(status.system_menu_open)
    setOverviewVisible(status.overview_open)
    // Update immediately — get_visible() is already correct after set_visible() above,
    // so the region calculation is accurate without waiting for a layout pass.
    // The overview is the exception: its input region is refreshed inside
    // setOverviewVisible() after the fade-out animation completes (260ms).
    updateInputRegion()
  }
  status.connect("notify::cc-open", syncOverlays); status.connect("notify::nc-open", syncOverlays); status.connect("notify::system-menu-open", syncOverlays)
  status.connect("notify::overview-open", syncOverlays)
  status.connect("notify::cc-edit-mode", syncOverlays)

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
      expansionCapsule.margin_end = Math.max(8, Math.round(monGeo.width - iconCenterX - panelW / 2))
  }

  let expansionHideTimer: number | null = null
  const showExpansion = (id: string) => {
      if (expansionHideTimer) { GLib.source_remove(expansionHideTimer); expansionHideTimer = null }
      const onClose = () => { status.bar_expanded_id = "" }
      let content: Gtk.Widget | undefined
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
      }
      let c = expansionInner.get_first_child()
      while (c) { const n = c.get_next_sibling(); expansionInner.remove(c); c = n }
      expansionInner.append(content)
      // Mapped but still transparent (overlay-fade = opacity 0). Defer one frame so
      // the panel is laid out, position it under the icon, THEN fade in — the panel
      // never appears at the wrong spot first (no reposition jump).
      expansionCapsule.set_visible(true)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
          positionExpansion(id)
          expansionCapsule.add_css_class("overlay-open")   // no-op if already open (widget switch)
          updateInputRegion()
          return GLib.SOURCE_REMOVE
      })
  }
  const hideExpansion = () => {
      if (expansionHideTimer) { GLib.source_remove(expansionHideTimer); expansionHideTimer = null }
      expansionCapsule.remove_css_class("overlay-open")
      // Defer the actual hide until the fade-out finishes (matches CC/NC).
      expansionHideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FADE_HIDE_MS, () => {
          if (!expansionCapsule.has_css_class("overlay-open")) {
              expansionCapsule.set_visible(false)
              let c = expansionInner.get_first_child()
              while (c) { const n = c.get_next_sibling(); expansionInner.remove(c); c = n }
              updateInputRegion()
          }
          expansionHideTimer = null
          return GLib.SOURCE_REMOVE
      })
  }
  // Open arbitrary content (e.g. a tray context menu) in the shared expansion
  // capsule, anchored under `anchor`. Same glass/fade/positioning/dismissal as
  // the widget popovers — so it's consistent and free of Gtk.Popover quirks.
  const openCustomExpansion = (anchor: Gtk.Widget, builder: (onClose: () => void) => Gtk.Widget) => {
      customAnchor = anchor
      customContentBuilder = builder
      if (status.bar_expanded_id === CUSTOM_ID) showExpansion(CUSTOM_ID)  // refresh anchor + content
      else status.bar_expanded_id = CUSTOM_ID
  }
  status.connect("notify::bar-expanded-id", () => {
      if (status.bar_expanded_id) showExpansion(status.bar_expanded_id)
      else hideExpansion()
      catcher.set_visible(status.isAnyOverlayOpen && !status.cc_edit_mode)
      updateInputRegion()
  })
  status.connect("notify::prism-open", () => { 
    syncOverlays() // Call syncOverlays to update visibility and input region
    Gtk4LayerShell.set_keyboard_mode(win, status.prism_open ? Gtk4LayerShell.KeyboardMode.ON_DEMAND : Gtk4LayerShell.KeyboardMode.NONE)
  })
  
  syncOverlays()

  const left = new Gtk.Box({ css_classes: ["bar-left"], halign: Gtk.Align.START, hexpand: false, spacing: 8 })
  const sysMenuWidget = SystemMenuIcon()
  const appTitleWidget = AppTitle(monGeo.width, openCustomExpansion)
  sysMenuWidget.set_visible(barSettings.showSystemMenu)
  appTitleWidget.set_visible(barSettings.showAppTitle)
  left.append(sysMenuWidget)
  left.append(appTitleWidget)
  const center = new Gtk.Box({ css_classes: ["bar-center"], halign: Gtk.Align.CENTER }); center.append(Workspaces())
  center.set_visible(barSettings.showWorkspaces)
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
  const bellIcon = new Gtk.Image({ gicon: Icons.bell, pixel_size: 16, visible: false , css_classes: ["cs-icon"] })
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
      const row = new Gtk.Box({ spacing: 10 })
      row.append(new Gtk.Image({ gicon: w.icon, pixel_size: 16, css_classes: ["cs-icon"] }))
      row.append(new Gtk.Label({ label: w.name, halign: Gtk.Align.START, hexpand: true }))
      const btn = new Gtk.Button({ child: row, css_classes: ["crystal-menu-row"], hexpand: true })
      btn.connect("clicked", () => {
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
      const onRelease = hasExpand
          ? () => { if (status.cc_open) return; status.bar_expanded_id = status.bar_expanded_id === id ? "" : id }
          : hasCCDetail
              ? () => { if (status.cc_open) return; status.cc_open = true; status.cc_detail_id = id }
              : undefined
      const capsule = SquircleContainer({
          child: w.buildBarContent(), gloss: true, useShellOpacity: true,
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
          child: overflowLabel, gloss: true, useShellOpacity: true,
          borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true,
      })
      const g = new Gtk.GestureClick()
      g.connect("released", () => {
          if (status.cc_open) return
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

  // Recording indicator — always in DOM, visible only while recording
  const recDot = new Gtk.Box({
      css_classes: ["bar-rec-indicator"],
      width_request: 8, height_request: 8,
      valign: Gtk.Align.CENTER,
      visible: false,
  })
  const recLabel = new Gtk.Label({ label: "REC", css_classes: ["bar-rec-label"] })
  const recBox = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER, margin_start: 8, margin_end: 8 })
  recBox.append(recDot)
  recBox.append(recLabel)
  const recCapsule = SquircleContainer({ child: recBox, gloss: false, useShellOpacity: true, borderColor: { r: 0.9, g: 0.1, b: 0.1, a: 0.4 }, perfect: true, css_classes: ["bar-rec-capsule"] })
  recCapsule.set_visible(false)
  const syncRecIndicator = () => {
      recCapsule.set_visible(status.recording)
      recDot.set_visible(status.recording)
  }
  status.connect("notify::recording", syncRecIndicator)
  right.append(recCapsule)

  const trayInner = Tray(openCustomExpansion)
  const trayCapsule = SquircleContainer({ child: trayInner, gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  trayInner.connect("notify::visible", () => trayCapsule.set_visible(trayInner.get_visible()))
  trayCapsule.set_visible(trayInner.get_visible())
  right.append(trayCapsule)
  const searchCapsule = SquircleContainer({ child: new Gtk.Image({ gicon: Icons.search, pixel_size: 16, margin_start: 16, margin_end: 16 , css_classes: ["cs-icon"] }), onClick: () => status.togglePrism(), gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  right.append(searchCapsule)
  const ccBtn = SquircleContainer({ child: new Gtk.Image({ gicon: Icons.settings2, pixel_size: 16, margin_start: 16, margin_end: 16 , css_classes: ["cs-icon"] }), onClick: () => status.toggleCC(), gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  right.append(ccBtn)
  const timeCapsule = SquircleContainer({ child: timeContent, onClick: () => status.toggleNC(), gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
  right.append(timeCapsule)

  barBox.set_start_widget(left); barBox.set_center_widget(center); barBox.set_end_widget(right)

  onBarSettingsChanged((s) => {
    sysMenuWidget.set_visible(s.showSystemMenu)
    appTitleWidget.set_visible(s.showAppTitle)
    center.set_visible(s.showWorkspaces)
  })

  const monitorHeight = gdkmonitor.get_geometry().height

  // ── Zone reservor ─────────────────────────────────────────────────────────
  // Wayland layer-shell: a surface with LEFT+RIGHT anchors gets width = workarea
  // width, which shrinks when the dock has a side exclusive zone. There is no
  // protocol mechanism to make a single surface both span the full output AND
  // ignore other surfaces' exclusive zones.
  //
  // Solution: two surfaces.
  //   crystal-bar-zone  invisible, TOP+LEFT+RIGHT, exclusive_zone=40
  //     → reserves 40 px at the top for tiled windows. Gets squished by the
  //       dock's zone but is invisible so it doesn't matter.
  //   crystal-bar  exclusive_zone=-1
  //     → protocol: compositor MUST NOT adjust position/size based on other
  //       surfaces' exclusive zones. Bar stays monGeo.width always.
  const zoneWin = new Gtk.Window({ name: "crystal-bar-zone", application: app, visible: false })
  // GTK requires a child to present; height_request 1 shrinks the surface to a
  // 1 px strip (an empty window defaults to 200 px) — the exclusive zone (40)
  // is independent of surface size.
  zoneWin.set_child(new Gtk.Box({ height_request: 1 }))
  // Invisible via transparent CSS background (_bar.scss), NOT set_opacity(0):
  // toplevel opacity routes every frame through the compositing pipeline and is
  // the prime suspect for this window's frame clock spinning at refresh rate
  // (tech-debt #11).
  zoneWin.set_default_size(-1, 1)
  zoneWin.connect("realize", () => {
    // Empty input region — this window must never intercept pointer events
    const surf = zoneWin.get_native()?.get_surface()
    // @ts-ignore
    if (surf?.set_input_region) surf.set_input_region(new Cairo.Region())
  })
  try {
    Gtk4LayerShell.init_for_window(zoneWin)
    Gtk4LayerShell.set_namespace(zoneWin, "crystal-bar-zone")
    Gtk4LayerShell.set_layer(zoneWin, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(zoneWin, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(zoneWin, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(zoneWin, Gtk4LayerShell.Edge.RIGHT, true)
    Gtk4LayerShell.set_exclusive_zone(zoneWin, 40)
    Gtk4LayerShell.set_monitor(zoneWin, gdkmonitor)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { zoneWin.present(); return GLib.SOURCE_REMOVE })
  } catch (e) { console.error("[Bar] Zone reservor init failed:", e) }

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "crystal-bar")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    // No bottom anchor — required for the exclusive zone to reserve only the top strip.
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    // -1: compositor must not adjust this surface based on other surfaces' exclusive zones.
    // The dock's side zone cannot squish the bar. TOP reservation is handled by zoneWin.
    Gtk4LayerShell.set_exclusive_zone(win, -1)
    Gtk4LayerShell.set_monitor(win, gdkmonitor)
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
      const fixedCapsules: Gtk.Widget[] = [recCapsule, trayCapsule, searchCapsule, ccBtn, timeCapsule]
      const fixedW = fixedCapsules.reduce((s, w) => s + (w.get_visible() ? natW(w) + spacing : 0), 0)
      // Budget = space available to optWidgets before the right side would overlap the
      // workspace capsule. The workspace is centered, so each side gets at most:
      //   (monGeo.width - 16(bar margins) - workspace_nat) / 2
      // minus fixedW, minus the barBox margin_end (8px).
      const workspaceNat = natW(center)
      const budget = (monGeo.width - 16 - workspaceNat) / 2 - fixedW

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
  let barFullscreenMode = false
  let gameOverlayActive = false

  // Show only after measurement+rebuild have had time to take effect
  // Skip if fullscreen is already detected by then (checkBarFullscreen runs in idle_add)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      if (!barFullscreenMode) win.set_opacity(1)
      return GLib.SOURCE_REMOVE
  })

  // Fullscreen detection — hide bar automatically, restore when fullscreen exits
  let trackedBarClient: any = null
  let trackedBarClientConn: number | null = null

  const setBarFullscreenMode = (active: boolean) => {
      if (barFullscreenMode === active) return
      barFullscreenMode = active
      try {
          if (active && !gameOverlayActive) {
              Gtk4LayerShell.set_exclusive_zone(zoneWin, 0) // release top reservation
              win.set_opacity(0)
          } else if (!active) {
              if (gameOverlayActive) {
                  // Exit overlay mode when fullscreen ends
                  gameOverlayActive = false
                  Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              }
              Gtk4LayerShell.set_exclusive_zone(zoneWin, 40) // restore top reservation
              win.set_opacity(1)
          }
      } catch (e) {}
  }

  const checkBarFullscreen = () => {
      const client = hs.focusedClient ?? null
      // Skip rewire if focused client object hasn't changed
      if (client !== trackedBarClient) {
          if (trackedBarClient && trackedBarClientConn !== null) {
              try { trackedBarClient.disconnect(trackedBarClientConn) } catch (_) {}
              trackedBarClientConn = null
          }
          trackedBarClient = client
          if (client) {
              trackedBarClientConn = client.connect("notify::fullscreen", () =>
                  setBarFullscreenMode(client.fullscreen ?? false))
          }
      }
      setBarFullscreenMode(client ? (client.fullscreen ?? false) : false)
  }

  hs.connect("changed", checkBarFullscreen)
  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { checkBarFullscreen(); return GLib.SOURCE_REMOVE })

  ;(win as any).setGameOverlayMode = (active: boolean) => {
      try {
          gameOverlayActive = active
          if (active) {
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
              Gtk4LayerShell.set_exclusive_zone(zoneWin, 0) // release top reservation
              win.set_opacity(1)
              win.present()
          } else {
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              if (barFullscreenMode) {
                  Gtk4LayerShell.set_exclusive_zone(zoneWin, 0)
                  win.set_opacity(0)
              } else {
                  Gtk4LayerShell.set_exclusive_zone(zoneWin, 40) // restore top reservation
              }
          }
      } catch (e) { console.error("[Bar] setGameOverlayMode failed:", e) }
  }
  ;(win as any).isGameOverlayActive = () => gameOverlayActive
  ;(win as any).isBarFullscreenMode = () => barFullscreenMode

  return win
}
