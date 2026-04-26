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
      img.icon_name = "start-here-symbolic"
    }
  }

  applyIcon()
  onBarSettingsChanged(applyIcon)

  return SquircleContainer({ child: img, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, onClick: () => status.toggleSystemMenu() })
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

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    getServiceSafe(() => AstalHyprland.get_default(), "Hyprland").then(hyprland => {
      if (!hyprland) return

      let trackedClient: AstalHyprland.Client | null = null
      let titleHandlerId = 0

      const sync = () => {
        const client = hyprland.focused_client
        const label = getWordmark(client, hyprland)
        if (label) appName.label = label

        if (trackedClient && titleHandlerId) {
          trackedClient.disconnect(titleHandlerId)
          titleHandlerId = 0
        }
        trackedClient = client
        if (client) {
          titleHandlerId = client.connect("notify::title", sync)
        }
      }

      hyprland.connect("notify::focused-client", sync)
      hyprland.connect("notify::focused-workspace", sync)
      sync()
    })
    return GLib.SOURCE_REMOVE
  })

  return SquircleContainer({ child: appName, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
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

  const makeRow = (ico: string, txt: string, _danger: boolean, cmd: () => void) => {
    const lbl = new Gtk.Label({ label: txt, halign: Gtk.Align.START, hexpand: true,
      css_classes: ["system-menu-label"] })
    const img = new Gtk.Image({ icon_name: ico, pixel_size: 16 })
    const b = new Gtk.Box({ spacing: 12, margin_top: 2, margin_bottom: 2, margin_start: 4, margin_end: 16 })
    b.append(img); b.append(lbl)
    const btn = new Gtk.Button({ child: b, css_classes: ["system-menu-row"], hexpand: true })
    btn.connect("clicked", cmd)
    return btn
  }

  const sep = () => new Gtk.Separator({ css_classes: ["system-menu-sep"], margin_top: 4, margin_bottom: 4 })

  const showConfirm = (ico: string, question: string, actionLabel: string, danger: boolean, cmd: () => void) => {
    pendingCmd = cmd
    confirmIcon.icon_name = ico
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
  menuBox.append(makeRow("preferences-system-symbolic", t("bar.system-menu.settings"), false, () => {
    status.system_menu_open = false; ;(globalThis as any).toggleSettings?.()
  }))
  menuBox.append(sep())
  menuBox.append(makeRow("changes-prevent-symbolic", t("bar.system-menu.lock"), false, () =>
    closeAndRun(["crystal-lock"])
  ))
  menuBox.append(makeRow("system-suspend-symbolic", t("bar.system-menu.suspend"), false, () =>
    closeAndRun(["systemctl", "suspend"])
  ))
  menuBox.append(sep())
  menuBox.append(makeRow("system-log-out-symbolic", t("bar.system-menu.logout"), true, () =>
    showConfirm("system-log-out-symbolic", t("bar.system-menu.confirm.logout"), t("bar.system-menu.confirm.action.logout"), true,
      () => closeAndRun(["hyprctl", "dispatch", "exit"]))
  ))
  menuBox.append(makeRow("system-reboot-symbolic", t("bar.system-menu.restart"), false, () =>
    showConfirm("system-reboot-symbolic", t("bar.system-menu.confirm.restart"), t("bar.system-menu.confirm.action.restart"), false,
      () => closeAndRun(["reboot"]))
  ))
  menuBox.append(makeRow("system-shutdown-symbolic", t("bar.system-menu.shutdown"), true, () =>
    showConfirm("system-shutdown-symbolic", t("bar.system-menu.confirm.shutdown"), t("bar.system-menu.confirm.action.shutdown"), true,
      () => closeAndRun(["shutdown", "now"]))
  ))

  // ── Confirmation page ──────────────────────────────────────────────────
  const confirmIcon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER })
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
    alpha: 0.15,
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
  const hypr = AstalHyprland.get_default()
  const box = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16 })
  for (let i = 1; i <= 5; i++) {
    const dot = new Gtk.Box({ css_classes: ["workspace-dot"], valign: Gtk.Align.CENTER })
    const update = () => {
      const active = hypr.focusedWorkspace.id === i; const occupied = hypr.get_workspace(i)?.clients.length > 0
      dot.set_css_classes(["workspace-dot", active ? "active" : occupied ? "occupied" : "empty"])
    }
    hypr.connect("notify::focused-workspace", update); hypr.connect("workspace-added", update); hypr.connect("workspace-removed", update); update()
    box.append(dot)
  }
  return SquircleContainer({ child: box, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, onClick: () => status.toggleOverview() })
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
    status.overview_open = false
  })

  masterOverlay.set_child(barBox)
  masterOverlay.add_overlay(catcher) // behind panels, above bar base
  masterOverlay.add_overlay(cc); masterOverlay.add_overlay(nc); masterOverlay.add_overlay(prism); masterOverlay.add_overlay(popups); masterOverlay.add_overlay(systemMenu); masterOverlay.add_overlay(overview)

  cc.valign = Gtk.Align.START; cc.halign = Gtk.Align.END
  nc.valign = Gtk.Align.START; nc.halign = Gtk.Align.END
  prism.valign = Gtk.Align.CENTER; prism.halign = Gtk.Align.CENTER
  popups.valign = Gtk.Align.START; popups.halign = Gtk.Align.END
  overview.valign = Gtk.Align.CENTER; overview.halign = Gtk.Align.CENTER

  cc.margin_top = 56; cc.margin_end = 16

  const CC_WIDTH = 356
  const centerCCUnderIcon = () => {
    const alloc = ccBtn.get_allocation()
    if (alloc.width <= 1) return // not yet laid out
    const [ok, tx] = ccBtn.translate_coordinates(masterOverlay, 0, 0)
    if (!ok) return
    const iconCenter = tx + alloc.width / 2
    const margin = Math.round(monGeo.width - iconCenter - CC_WIDTH / 2)
    cc.margin_end = Math.max(16, margin)
  }
  nc.margin_top = 56
  const syncNcMargin = () => { nc.margin_end = 16 + (dockSideState.position === 'right' ? dockSideState.width : 0) }
  syncNcMargin()
  dockSideState.subscribe(syncNcMargin)
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
    if (status.cc_open) centerCCUnderIcon()
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
  const bellIcon = new Gtk.Image({ icon_name: Icons.bell, pixel_size: 16, visible: false })
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
  const rebuildBarWidgets = () => {
    let child = optWidgets.get_first_child()
    while (child) { const n = child.get_next_sibling(); optWidgets.remove(child); child = n }
    for (const id of widgetConfig.barWidgetIds()) {
      const w = registry.get(id)
      if (w?.buildBarContent) {
        optWidgets.append(SquircleContainer({ child: w.buildBarContent(), gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true }))
      }
    }
  }
  widgetConfig.connect("changed", rebuildBarWidgets)
  rebuildBarWidgets()

  right.append(optWidgets)
  const trayInner = Tray()
  const trayCapsule = SquircleContainer({ child: trayInner, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
  trayInner.connect("notify::visible", () => trayCapsule.set_visible(trayInner.get_visible()))
  trayCapsule.set_visible(trayInner.get_visible())
  right.append(trayCapsule)
  right.append(SquircleContainer({ child: new Gtk.Image({ icon_name: Icons.search, pixel_size: 16, margin_start: 16, margin_end: 16 }), onClick: () => status.togglePrism(), gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true }))
  const ccBtn = SquircleContainer({ child: new Gtk.Image({ icon_name: Icons.menu, pixel_size: 16, margin_start: 16, margin_end: 16 }), onClick: () => status.toggleCC(), gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true })
  right.append(ccBtn)
  right.append(SquircleContainer({ child: timeContent, onClick: () => status.toggleNC(), gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true }))

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

  // Safety net: refresh input region on workspace switch so any stale allocation
  // left by a closing overlay (e.g. overview animation) is cleared immediately.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      const hyprland = AstalHyprland.get_default()
      if (hyprland) hyprland.connect("notify::focused-workspace", () => updateInputRegion())
      return GLib.SOURCE_REMOVE
  })
  
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      win.present()
      win.set_opacity(1)
      return GLib.SOURCE_REMOVE
  })

  return win
}
