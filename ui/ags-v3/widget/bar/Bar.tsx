import { Astal, Gtk, Gdk } from "ags/gtk4"
import Pango from "gi://Pango"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import app from "ags/gtk4/app"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"

// Astal Service Libraries
import { getWordmark, getServiceSafe } from "../../utils"
import SquircleContainer from "../common/SquircleContainer" 
import appService from "../../core/AppService"
import status from "../../core/Status"
import Tray from "./Tray"
import SystemResources from "./Resources"

// 🛰️ Zenith Native Overlays (One-file Simplicity)
import { ControlCenterWidget } from "../control-center/ControlCenter"
import NotificationCenter from "../control-center/NotificationCenter"
import Prism from "../prism/Prism"
import { NotificationPopupsWidget } from "../control-center/NotificationPopups"

function AppMenu(monitorWidth: number): { widget: Gtk.Widget; appName: Gtk.Label } {
  const box = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER, margin_start: 16, margin_end: 16 })
  const distroIcon = new Gtk.Image({ icon_name: "start-here-symbolic", pixel_size: 16, css_classes: ["bar-distro-icon"] })
  // Max label width = half monitor - center capsule est. (100px) - icon/padding overhead (80px)
  const labelMaxChars = Math.max(15, Math.floor((monitorWidth / 2 - 180) / 8))
  const appName = new Gtk.Label({
    label: "Finder",
    css_classes: ["bar-app-name"],
    ellipsize: Pango.EllipsizeMode.END,
    max_width_chars: labelMaxChars,
  })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    getServiceSafe(() => AstalHyprland.get_default(), "Hyprland").then(hyprland => {
      if (!hyprland) return

      let trackedClient: AstalHyprland.Client | null = null
      let titleHandlerId = 0

      const sync = () => {
        const client = hyprland.focused_client
        const label = getWordmark(client, hyprland)
        // Only update when we have a real value — avoids momentary "App" on window init
        if (label) appName.label = label

        // Re-subscribe to title changes on the newly focused client
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

  box.append(distroIcon); box.append(appName)
  
  const widget = SquircleContainer({ child: box, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, onClick: () => {
    status.toggleSystemMenu()
  }})

  return { widget, appName }
}

function SystemMenuOverlay() {
  const pBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 })

  const makeRow = (ico: string, txt: string, cmd: () => void) => {
    const lbl = new Gtk.Label({ label: txt, halign: Gtk.Align.START, css_classes: ["system-menu-label"] })
    const img = new Gtk.Image({ icon_name: ico, pixel_size: 16 })
    const b = new Gtk.Box({ spacing: 12, margin_top: 2, margin_bottom: 2, margin_start: 4, margin_end: 16 })
    b.append(img); b.append(lbl)
    const btn = new Gtk.Button({ child: b, css_classes: ["system-menu-row"], hexpand: true })
    btn.connect("clicked", () => { status.system_menu_open = false; cmd() })
    return btn
  }

  pBox.append(makeRow("dialog-information-symbolic", "Acerca de este equipo", () => execAsync(["bash", "-c", "missioncenter || gnome-system-monitor || hwinfo --gui || kitty --class float -e fastfetch"]).catch(console.error)))
  pBox.append(new Gtk.Separator({ css_classes: ["system-menu-sep"], margin_top: 4, margin_bottom: 4 }))
  pBox.append(makeRow("preferences-system-symbolic", "Configuración del Sistema...", () => execAsync("ags request 'toggleSettings()'").catch(console.error)))
  pBox.append(new Gtk.Separator({ css_classes: ["system-menu-sep"], margin_top: 4, margin_bottom: 4 }))
  pBox.append(makeRow("system-log-out-symbolic", "Opciones de Energía...", () => execAsync("ags request 'togglePowerMenu()'").catch(console.error)))

  const squircleWrapper = SquircleContainer({ 
      child: pBox, 
      radius: 16, 
      gloss: true, 
      alpha: 0.15, 
      borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, 
      css_classes: ["system-menu-dropdown"] 
  })

  const outerBox = new Gtk.Box({
      valign: Gtk.Align.START,
      halign: Gtk.Align.START,
      margin_top: 48,
      margin_start: 8,
      visible: false
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
  return SquircleContainer({ child: box, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.2 }, perfect: true, onClick: () => execAsync("ags request 'toggleOverview()'") })
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

  // 💎 THE CATCHER: Invisible button to close overlays
  const catcher = new Gtk.Button({ css_classes: ["overlay-catcher"], visible: false, hexpand: true, vexpand: true })
  catcher.connect("clicked", () => {
    if (status.cc_edit_mode) return   // don't close CC while in edit mode
    status.cc_open = false; status.nc_open = false; status.prism_open = false; status.system_menu_open = false
  })

  masterOverlay.set_child(barBox)
  masterOverlay.add_overlay(catcher) // 💎 Behind panels, above BarBox base child
  masterOverlay.add_overlay(cc); masterOverlay.add_overlay(nc); masterOverlay.add_overlay(prism); masterOverlay.add_overlay(popups); masterOverlay.add_overlay(systemMenu)

  cc.valign = Gtk.Align.START; cc.halign = Gtk.Align.END
  nc.valign = Gtk.Align.START; nc.halign = Gtk.Align.END
  prism.valign = Gtk.Align.CENTER; prism.halign = Gtk.Align.CENTER
  popups.valign = Gtk.Align.START; popups.halign = Gtk.Align.END

  cc.margin_top = 48; cc.margin_end = 8

  const CC_WIDTH = 356
  const centerCCUnderIcon = () => {
    const alloc = ccBtn.get_allocation()
    if (alloc.width <= 1) return // not yet laid out
    const [ok, tx] = ccBtn.translate_coordinates(masterOverlay, 0, 0)
    if (!ok) return
    const iconCenter = tx + alloc.width / 2
    const margin = Math.round(monGeo.width - iconCenter - CC_WIDTH / 2)
    cc.margin_end = Math.max(8, margin)
  }
  nc.margin_top = 48; nc.margin_end = 8
  prism.margin_top = 0
  popups.margin_top = 54; popups.margin_end = 12

  // 💎 TAHOE GEOMETRY: NC must end just before the dock
  const maxH = monGeo.height - 160 // 40 (Bar) + 92 (Dock) + 28 (Safety)
  cc.height_request = 800; nc.height_request = maxH; prism.height_request = 500

  const updateInputRegion = () => {
      const surface = win.get_native()?.get_surface()
      if (!surface) return
      const region = new Cairo.Region()
      
      // Bar strip (40px)
      // @ts-ignore
      region.unionRectangle({ x: 0, y: 0, width: Math.round(monGeo.width), height: 40 })

      const isAnyOpen = status.cc_open || status.nc_open || status.prism_open || status.system_menu_open
      if (isAnyOpen && !status.cc_edit_mode) {
          // 🛰️ SURGICAL: Catcher region (Everything below Bar to catch outside clicks)
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
      addWidgetToRegion(cc); addWidgetToRegion(nc); addWidgetToRegion(prism); addWidgetToRegion(systemMenu)
      
      // 🛰️ ATOMIC: Add every individual popup to the region
      let child = popups.get_first_child()
      while (child) {
          addWidgetToRegion(child)
          child = child.get_next_sibling()
      }

      if (surface.set_input_region) surface.set_input_region(region)
  }

  const syncOverlays = () => {
    const isAnyOpen = status.cc_open || status.nc_open || status.prism_open || status.system_menu_open
    catcher.set_visible(isAnyOpen && !status.cc_edit_mode)
    if (status.cc_open) centerCCUnderIcon()
    cc.set_visible(status.cc_open); nc.set_visible(status.nc_open); prism.set_visible(status.prism_open); systemMenu.set_visible(status.system_menu_open)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { updateInputRegion(); return GLib.SOURCE_REMOVE })
  }
  status.connect("notify::cc-open", syncOverlays); status.connect("notify::nc-open", syncOverlays); status.connect("notify::system-menu-open", syncOverlays)
  status.connect("notify::cc-edit-mode", () => {
    syncOverlays()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { updateInputRegion(); return GLib.SOURCE_REMOVE })
  })
  status.connect("notify::prism-open", () => { 
    syncOverlays() // Call syncOverlays to update visibility and input region
    Gtk4LayerShell.set_keyboard_mode(win, status.prism_open ? Gtk4LayerShell.KeyboardMode.ON_DEMAND : Gtk4LayerShell.KeyboardMode.NONE)
  })
  
  syncOverlays()

  const left = new Gtk.Box({ css_classes: ["bar-left"], halign: Gtk.Align.START, hexpand: false, spacing: 8 })
  left.append(AppMenu(monGeo.width).widget)
  const center = new Gtk.Box({ css_classes: ["bar-center"], halign: Gtk.Align.CENTER }); center.append(Workspaces())
  const right = new Gtk.Box({ css_classes: ["bar-right"], halign: Gtk.Align.END, spacing: 10 })

  const timeContent = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 16 })
  const timeLabel = new Gtk.Label({ label: "..." })
  const timeAccessor = createPoll("...", 1000, "date +'%a %b %d  %H:%M'", (out) => out.trim())
  timeAccessor.subscribe(() => { timeLabel.label = timeAccessor.get() })
  timeContent.append(new Gtk.Image({ icon_name: "notifications-symbolic", pixel_size: 14 })); timeContent.append(timeLabel)

  right.append(SquircleContainer({ child: SystemResources(), gloss: true, alpha: 0.15, perfect: true }))
  right.append(SquircleContainer({ child: Tray(), gloss: true, alpha: 0.15, perfect: true }))
  right.append(SquircleContainer({ child: new Gtk.Image({ icon_name: "edit-find-symbolic", pixel_size: 14, margin_start: 16, margin_end: 16 }), onClick: () => status.togglePrism(), gloss: true, alpha: 0.15, perfect: true }))
  const ccBtn = SquircleContainer({ child: new Gtk.Image({ icon_name: "open-menu-symbolic", pixel_size: 14, margin_start: 16, margin_end: 16 }), onClick: () => status.toggleCC(), gloss: true, alpha: 0.15, perfect: true })
  right.append(ccBtn)
  right.append(SquircleContainer({ child: timeContent, onClick: () => status.toggleNC(), gloss: true, alpha: 0.15, perfect: true }))

  barBox.set_start_widget(left); barBox.set_center_widget(center); barBox.set_end_widget(right)

  const monitorHeight = gdkmonitor.get_geometry().height

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "crystal-bar")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    // 🏗️ SURGICAL: No bottom anchor = proper exclusive zone for the top strip
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    Gtk4LayerShell.set_exclusive_zone(win, 40) // 💎 TRUE 40px RESERVE
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
  
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      win.present()
      win.set_opacity(1)
      return GLib.SOURCE_REMOVE
  })

  return win
}
