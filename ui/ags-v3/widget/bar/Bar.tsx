import { Astal, Gtk, Gdk } from "ags/gtk4"
import Pango from "gi://Pango"
import app from "ags/gtk4/app"
import AstalHyprland from "gi://AstalHyprland"
import AstalNotifd from "gi://AstalNotifd"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"
import Gio from "gi://Gio"

// Astal Service Libraries
import { getWordmark, getServiceSafe } from "../../utils"
import SquircleContainer from "../common/SquircleContainer"
import Theme from "../../core/ThemeManager"
import appService from "../../core/AppService"
import status from "../../core/Status"
import widgetConfig from "../../core/WidgetConfig"
import regionConfig from "../../core/RegionConfig"
import registry from "../widgets/index"
import Tray from "./Tray"

// Overlay panels mounted on the bar window (avoids separate layer-shell surfaces)
import { ControlCenterWidget } from "../control-center/ControlCenter"
import NotificationCenter from "../control-center/NotificationCenter"
import Prism from "../prism/Prism"
import { NotificationPopupsWidget } from "../control-center/NotificationPopups"
import WorkspaceOverview from "../overview/WorkspaceOverview"
import { execAsync } from "ags/process"
import { t } from "../../core/i18n"
import { barSettings, onBarSettingsChanged } from "./barState"
import { dockSideState } from "../dock/state"
import Icons from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import hs from "../../core/HyprlandState"

const ASSETS_DIR = GLib.get_current_dir()

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

  return SquircleContainer({ child: img, gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, onClick: () => status.toggleSystemMenu() })
}

function AppTitle(monitorWidth: number): Gtk.Widget {
  // Max label width = half monitor - center capsule est. (100px) - icon capsule + gap overhead (~100px)
  const labelMaxChars = Math.max(15, Math.floor((monitorWidth / 2 - 200) / 8))
  const appName = new Gtk.Label({
    label: "—",
    css_classes: ["bar-app-name"],
    ellipsize: Pango.EllipsizeMode.END,
    max_width_chars: labelMaxChars,
    margin_start: 16,
    margin_end: 16,
  })

  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    let trackedClient: AstalHyprland.Client | null = null
    let titleHandlerId = 0

    const sync = () => {
      const client = hs.focusedClient
      const label = getWordmark(client, AstalHyprland.get_default())
      if (label && label !== appName.label) appName.label = label

      // Only rewire notify::title when the focused client actually changed
      if (client === trackedClient) return
      if (trackedClient && titleHandlerId) {
        trackedClient.disconnect(titleHandlerId)
        titleHandlerId = 0
      }
      trackedClient = client
      if (client) {
        titleHandlerId = client.connect("notify::title", sync)
      }
    }

    hs.connect("changed", sync)
    sync()
    return GLib.SOURCE_REMOVE
  })

  return SquircleContainer({ child: appName, gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
}

function SystemMenuOverlay() {
  // ── Shared confirm state ───────────────────────────────────────────────
  let pendingCmd: (() => void) | null = null

  const stack = new Gtk.Stack({
    transition_type: Gtk.StackTransitionType.CROSSFADE,
    transition_duration: 130,
  })

  // ── Normal menu page ───────────────────────────────────────────────────
  const menuBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 2,
    margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6,
  })

  const makeRow = (ico: Gio.FileIcon, txt: string, _danger: boolean, cmd: () => void) => {
    const lbl = new Gtk.Label({ label: txt, halign: Gtk.Align.START, hexpand: true,
      css_classes: ["system-menu-label"] })
    const img = new Gtk.Image({ gicon: ico, pixel_size: 16, css_classes: ["cs-icon"] })
    const b = new Gtk.Box({ spacing: 12, margin_top: 2, margin_bottom: 2, margin_start: 4, margin_end: 16 })
    b.append(img); b.append(lbl)
    const btn = new Gtk.Button({ child: b, css_classes: ["system-menu-row"], hexpand: true })
    btn.connect("clicked", cmd)
    return btn
  }

  const sep = () => new Gtk.Separator({ css_classes: ["system-menu-sep"], margin_top: 4, margin_bottom: 4 })

  const showConfirm = (ico: Gio.FileIcon, question: string, actionLabel: string, danger: boolean, cmd: () => void) => {
    pendingCmd = cmd
    confirmIcon.gicon = ico
    confirmQuestion.label = question
    confirmActionBtn.label = actionLabel
    if (danger) confirmActionBtn.add_css_class("danger-action")
    else confirmActionBtn.remove_css_class("danger-action")
    stack.set_visible_child_name("confirm")
  }

  const closeAndRun = (cmd: string[]) => {
    status.system_menu_open = false
    execAsync(cmd).catch(console.error)
  }

  menuBox.append(makeRow(Icons.info, t("bar.system-menu.about"), false, () => {
    status.system_menu_open = false; status.toggleAbout()
  }))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.settings, t("bar.system-menu.settings"), false, () => {
    status.system_menu_open = false; shellActions.toggleSettings?.()
  }))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.lock, t("bar.system-menu.lock"), false, () => {
    status.system_menu_open = false
    shellActions.lockScreen?.()
    execAsync(["crystal-lock"]).catch(console.error)
  }))
  menuBox.append(makeRow(Icons.moon, t("bar.system-menu.suspend"), false, () =>
    closeAndRun(["systemctl", "suspend"])
  ))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.logOut, t("bar.system-menu.logout"), true, () =>
    showConfirm(Icons.logOut, t("bar.system-menu.confirm.logout"), t("bar.system-menu.confirm.action.logout"), true,
      () => closeAndRun(["uwsm", "stop"]))
  ))
  menuBox.append(makeRow(Icons.rotateCcw, t("bar.system-menu.restart"), false, () =>
    showConfirm(Icons.rotateCcw, t("bar.system-menu.confirm.restart"), t("bar.system-menu.confirm.action.restart"), false,
      () => closeAndRun(["reboot"]))
  ))
  menuBox.append(makeRow(Icons.power, t("bar.system-menu.shutdown"), true, () =>
    showConfirm(Icons.power, t("bar.system-menu.confirm.shutdown"), t("bar.system-menu.confirm.action.shutdown"), true,
      () => closeAndRun(["shutdown", "now"]))
  ))

  // ── Confirmation page ──────────────────────────────────────────────────
  const confirmIcon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER, css_classes: ["cs-icon"] })
  const confirmQuestion = new Gtk.Label({
    halign: Gtk.Align.CENTER,
    justify: Gtk.Justification.CENTER,
    css_classes: ["system-menu-label"],
    wrap: true,
    max_width_chars: 20,
  })

  const confirmCancelBtn = new Gtk.Button({ label: t("bar.system-menu.confirm.cancel"), css_classes: ["system-menu-row", "system-confirm-secondary"], hexpand: true })
  confirmCancelBtn.connect("clicked", () => {
    pendingCmd = null
    stack.set_visible_child_name("menu")
  })

  const confirmActionBtn = new Gtk.Button({ label: "", css_classes: ["system-menu-row", "system-confirm-primary"], hexpand: true })
  confirmActionBtn.connect("clicked", () => {
    pendingCmd?.()
    pendingCmd = null
    stack.set_visible_child_name("menu")
  })

  const confirmBtnRow = new Gtk.Box({ spacing: 6, homogeneous: true, margin_top: 4 })
  confirmBtnRow.append(confirmCancelBtn)
  confirmBtnRow.append(confirmActionBtn)

  const confirmBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 10,
    margin_top: 16, margin_bottom: 14, margin_start: 10, margin_end: 10,
    width_request: 210,
  })
  confirmBox.append(confirmIcon)
  confirmBox.append(confirmQuestion)
  confirmBox.append(confirmBtnRow)

  // Reset to menu page when closed
  status.connect("notify::system-menu-open", () => {
    if (!status.system_menu_open) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        stack.set_visible_child_name("menu")
        pendingCmd = null
        return GLib.SOURCE_REMOVE
      })
    }
  })

  stack.add_named(menuBox, "menu")
  stack.add_named(confirmBox, "confirm")
  stack.set_visible_child_name("menu")

  const squircleWrapper = SquircleContainer({
    child: stack,
    radius: 24,
    gloss: true,
    useShellOpacity: true,
    borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
    css_classes: ["system-menu-dropdown"],
  })

  const outerBox = new Gtk.Box({
    valign: Gtk.Align.START,
    halign: Gtk.Align.START,
    margin_top: 56,
    margin_start: 16,
    visible: false,
  })
  outerBox.append(squircleWrapper)
  return outerBox
}

function Workspaces() {
  const box = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16 })
  for (let i = 1; i <= 5; i++) {
    const dot = new Gtk.Box({ css_classes: ["workspace-dot"], valign: Gtk.Align.CENTER })
    const update = () => {
      const active   = hs.focusedWorkspaceId === i
      const occupied = hs.occupiedWorkspaces.has(i)
      dot.set_css_classes(["workspace-dot", active ? "active" : occupied ? "occupied" : "empty"])
    }
    hs.connect("changed", update)
    update()
    box.append(dot)
  }
  return SquircleContainer({ child: box, gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, onClick: () => status.toggleOverview() })
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
  let overflowContentBuilder: ((onClose: () => void) => Gtk.Widget) | null = null
  // Measurement cache — populated after first layout; used to cap visible icons
  let cachedMaxIcons: number | null = null
  const capsuleRefs = new Map<string, Gtk.Widget>()
  const expansionInner = new Gtk.Box({ margin_top: 10, margin_bottom: 10, margin_start: 14, margin_end: 14 })
  const expansionCapsule = SquircleContainer({
      child: expansionInner, gloss: true, useShellOpacity: true,
      borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, radius: 20,
      css_classes: ["bar-expansion-panel"],
  })
  expansionCapsule.valign = Gtk.Align.START
  expansionCapsule.halign = Gtk.Align.END
  expansionCapsule.margin_top = 44
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

  cc.margin_top = 56
  nc.margin_top = 56
  const syncPanelMargins = () => {
    const end = 16 + (dockSideState.position === 'right' ? dockSideState.width : 0)
    cc.margin_end = end
    nc.margin_end = end
  }
  syncPanelMargins()
  dockSideState.subscribe(syncPanelMargins)
  prism.margin_top = 0
  popups.margin_top = 56; popups.margin_end = 16

  // NC height: leave room for bar (40px) + dock (92px) + safety margin
  const maxH = monGeo.height - 160 // 40 (Bar) + 92 (Dock) + 28 (Safety)
  cc.height_request = 800; nc.height_request = maxH

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
    cc.set_visible(status.cc_open); nc.set_visible(status.nc_open); prism.set_visible(status.prism_open); systemMenu.set_visible(status.system_menu_open)
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
  const showExpansion = (id: string) => {
      const onClose = () => { status.bar_expanded_id = "" }
      let content: Gtk.Widget | undefined
      if (id === OVERFLOW_ID) {
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
      expansionCapsule.visible = true
      // Position centered under the capsule (hidden widgets fall back to overflow capsule)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
          const capsule = capsuleRefs.get(id) ?? capsuleRefs.get(OVERFLOW_ID)
          if (!capsule) return GLib.SOURCE_REMOVE
          const iconAlloc = capsule.get_allocation()
          if (iconAlloc.width <= 1) return GLib.SOURCE_REMOVE
          const [ok, tx] = capsule.translate_coordinates(masterOverlay, 0, 0)
          if (!ok) return GLib.SOURCE_REMOVE
          const iconCenterX = tx + iconAlloc.width / 2
          const panelAlloc = expansionCapsule.get_allocation()
          const panelW = panelAlloc.width > 1 ? panelAlloc.width : 260
          expansionCapsule.margin_end = Math.max(8, Math.round(monGeo.width - iconCenterX - panelW / 2))
          updateInputRegion()
          return GLib.SOURCE_REMOVE
      })
  }
  const hideExpansion = () => {
      expansionCapsule.visible = false
      let c = expansionInner.get_first_child()
      while (c) { const n = c.get_next_sibling(); expansionInner.remove(c); c = n }
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
  const appTitleWidget = AppTitle(monGeo.width)
  sysMenuWidget.set_visible(barSettings.showSystemMenu)
  appTitleWidget.set_visible(barSettings.showAppTitle)
  left.append(sysMenuWidget)
  left.append(appTitleWidget)
  const center = new Gtk.Box({ css_classes: ["bar-center"], halign: Gtk.Align.CENTER }); center.append(Workspaces())
  center.set_visible(barSettings.showWorkspaces)
  const right = new Gtk.Box({ css_classes: ["bar-right"], halign: Gtk.Align.END, spacing: 8 })

  // Keep workspace capsule at the true monitor center regardless of how wide the
  // right side grows.  SizeGroup makes both sides request max(left, right) width,
  // so CenterBox always sees equal flanks and places center at exactly width/2.
  const sideGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL })
  sideGroup.add_widget(left)
  sideGroup.add_widget(right)

  const timeContent = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 16 })
  const timeLabel = new Gtk.Label({ label: "..." })
  const updateClock = () => {
    const fmt = regionConfig.getClockFormat()
    const next = GLib.DateTime.new_now_local().format(fmt) ?? ""
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
      const btn = new Gtk.Button({ child: row, css_classes: ["clip-entry-btn"], hexpand: true })
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

    const allIds = widgetConfig.barWidgetIds()
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
          borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true,
          hoverAlpha: onRelease ? 0.06 : undefined,
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
          borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, hoverAlpha: 0.06,
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
      rebuildBarWidgets()  // rebuild with all icons first (cachedMaxIcons may be stale)
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

  const trayInner = Tray()
  const trayCapsule = SquircleContainer({ child: trayInner, gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
  trayInner.connect("notify::visible", () => trayCapsule.set_visible(trayInner.get_visible()))
  trayCapsule.set_visible(trayInner.get_visible())
  right.append(trayCapsule)
  const searchCapsule = SquircleContainer({ child: new Gtk.Image({ gicon: Icons.search, pixel_size: 16, margin_start: 16, margin_end: 16 , css_classes: ["cs-icon"] }), onClick: () => status.togglePrism(), gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
  right.append(searchCapsule)
  const ccBtn = SquircleContainer({ child: new Gtk.Image({ gicon: Icons.settings2, pixel_size: 16, margin_start: 16, margin_end: 16 , css_classes: ["cs-icon"] }), onClick: () => status.toggleCC(), gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
  right.append(ccBtn)
  const timeCapsule = SquircleContainer({ child: timeContent, onClick: () => status.toggleNC(), gloss: true, useShellOpacity: true, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
  right.append(timeCapsule)

  barBox.set_start_widget(left); barBox.set_center_widget(center); barBox.set_end_widget(right)

  onBarSettingsChanged((s) => {
    sysMenuWidget.set_visible(s.showSystemMenu)
    appTitleWidget.set_visible(s.showAppTitle)
    center.set_visible(s.showWorkspaces)
  })

  const monitorHeight = gdkmonitor.get_geometry().height

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "crystal-bar")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    // No bottom anchor — required for the exclusive zone to reserve only the top strip
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    Gtk4LayerShell.set_exclusive_zone(win, 40) // reserve 40px at top
    Gtk4LayerShell.set_monitor(win, gdkmonitor)
    
    // Guard against missing set_size in some Gjs binding versions
    if ((Gtk4LayerShell as any).set_size) {
        (Gtk4LayerShell as any).set_size(win, 0, monitorHeight)
    }
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
              Gtk4LayerShell.set_exclusive_zone(win, 0)
              win.set_opacity(0)
          } else if (!active) {
              if (gameOverlayActive) {
                  // Exit overlay mode when fullscreen ends
                  gameOverlayActive = false
                  Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              }
              Gtk4LayerShell.set_exclusive_zone(win, 40)
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
              Gtk4LayerShell.set_exclusive_zone(win, 0)
              win.set_opacity(1)
              win.present()
          } else {
              Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
              if (barFullscreenMode) {
                  Gtk4LayerShell.set_exclusive_zone(win, 0)
                  win.set_opacity(0)
              } else {
                  Gtk4LayerShell.set_exclusive_zone(win, 40)
              }
          }
      } catch (e) { console.error("[Bar] setGameOverlayMode failed:", e) }
  }
  ;(win as any).isGameOverlayActive = () => gameOverlayActive
  ;(win as any).isBarFullscreenMode = () => barFullscreenMode

  return win
}
