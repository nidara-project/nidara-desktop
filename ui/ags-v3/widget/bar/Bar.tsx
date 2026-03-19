import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import app from "ags/gtk4/app"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"

// Astal Service Libraries
import AstalNotifd from "gi://AstalNotifd"
import { getWordmark, getServiceSafe } from "../../utils"
import SquircleContainer from "../common/SquircleContainer" 
import appService from "../../core/AppService"
import status from "../../core/Status"
import Tray from "./Tray"
import SystemResources from "./Resources"

/**
 * App Menu Module (Left) 🍎
 */
function AppMenu() {
  const box = new Gtk.Box({
    name: "bar-app-menu-content",
    css_classes: ["bar-app-menu-content"],
    spacing: 32,
    valign: Gtk.Align.CENTER,
    margin_start: 16,
    margin_end: 16,
    margin_top: 4,
    margin_bottom: 4
  })

  const pill = SquircleContainer({
    child: box,
    gloss: true,
    css_classes: ["bar-app-menu-pill"],
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true
  })

  const getIcon = (name: string) => {
    const res = appService.getIconName(name)
    if (res && (res.startsWith("/") || res.startsWith("file://"))) {
      return new Gtk.Image({ file: res.replace("file://", ""), css_classes: ["bar-app-distro-icon"] })
    }
    return new Gtk.Image({ icon_name: res || name, css_classes: ["bar-app-distro-icon"] })
  }

  const distroIcon = getIcon("/home/angel/Dev/Distroia/ui/ags-v3/assets/logos/arch-white.svg")

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    getServiceSafe(() => AstalHyprland.get_default(), "Hyprland").then(hyprland => {
      if (!hyprland) return;
      const appName = new Gtk.Label({ name: "bar-app-name", css_classes: ["bar-app-name"], label: "Finder", valign: Gtk.Align.CENTER })
      let lastClient: any = null;
      const sync = () => {
        const client = hyprland.focused_client
        const title = getWordmark(client, hyprland)
        appName.label = title || "Finder"
        if (client !== lastClient) {
          if (lastClient) try { (lastClient as any).disconnect_by_func(sync) } catch (e) { }
          if (client) client.connect("notify::title", sync)
          lastClient = client
        }
      }
      hyprland.connect("notify::focused-client", sync)
      hyprland.connect("notify::focused-workspace", sync)
      sync()
      box.append(distroIcon)
      box.append(appName)
    })
    return GLib.SOURCE_REMOVE
  })

  return pill
}

/**
 * Workspace Module (Fixed 5 Dots) 🔘
 */
function Workspaces() {
  const hypr = AstalHyprland.get_default()
  const box = new Gtk.Box({ name: "bar-workspaces", css_classes: ["bar-workspaces"], spacing: 12, valign: Gtk.Align.CENTER, margin_start: 16, margin_end: 16 })

  Array.from({ length: 5 }, (_, i) => {
    const id = i + 1
    const dot = new Gtk.Box({ css_classes: ["workspace-dot"], valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
    const update = () => {
      const active = hypr.focusedWorkspace.id === id
      const occupied = hypr.get_workspace(id)?.clients.length > 0
      dot.set_css_classes(["workspace-dot", active ? "active" : occupied ? "occupied" : "empty"])
    }
    hypr.connect("notify::focused-workspace", update)
    hypr.connect("workspace-added", update)
    hypr.connect("workspace-removed", update)
    hypr.connect("client-added", update)
    hypr.connect("client-removed", update)
    update()
    box.append(dot)
  })

  return SquircleContainer({
    child: box,
    gloss: true,
    css_classes: ["bar-ws-pill"],
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true,
    onClick: () => execAsync("ags request 'toggleAppGrid()'")
  })
}

/**
 * Control Center Toggle Pill 🎛️
 */
function ControlCenterMenu() {
  const box = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, margin_start: 16, margin_end: 16 })
  box.append(new Gtk.Image({ file: "/home/angel/Dev/Distroia/ui/ags-v3/assets/logos/cc.svg", pixel_size: 14, valign: Gtk.Align.CENTER }))

  return SquircleContainer({
    child: box,
    gloss: true,
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true,
    onClick: () => status.toggleCC()
  })
}

/**
 * System Status (Network & Battery) Pill 🔋
 */
function SystemStatus() {
  const box = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, margin_start: 16, margin_end: 16 })
  box.append(new Gtk.Image({ icon_name: "network-wireless-signal-excellent-symbolic", pixel_size: 14 }))
  box.append(new Gtk.Image({ icon_name: "battery-level-100-charged-symbolic", pixel_size: 14 }))

  return SquircleContainer({
    child: box,
    gloss: true,
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true
  })
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const win = new Gtk.Window({
    name: "crystal-bar",
    css_classes: ["crystal-bar", "fc-ignore"],
    application: app,
  })

  win.set_decorated(false)
  // @ts-ignore
  win.app_paintable = true

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "crystal-bar")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    Gtk4LayerShell.set_exclusive_zone(win, 40)
    Gtk4LayerShell.set_monitor(win, gdkmonitor)
  } catch (e) {
    console.error("[Bar] LayerShell init failed:", e)
  }

  const centerBox = new Gtk.CenterBox({ name: "bar-centerbox", css_classes: ["bar-centerbox"], hexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL })

  const leftSide = new Gtk.Box({ halign: Gtk.Align.START, valign: Gtk.Align.CENTER, css_classes: ["bar-left"], height_request: 32, margin_start: 8 })
  leftSide.append(AppMenu())

  const centerSide = new Gtk.Box({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, css_classes: ["bar-center"], height_request: 32 })
  centerSide.append(Workspaces())

  const rightSide = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END, valign: Gtk.Align.CENTER, height_request: 32, margin_end: 8 })
  
  const timeContent = new Gtk.Box({ spacing: 32, valign: Gtk.Align.CENTER, margin_start: 16, margin_end: 16 })
  const timeLabel = new Gtk.Label({ name: "bar-time-label", css_classes: ["bar-time"], label: "...", valign: Gtk.Align.CENTER })
  const notifCluster = new Gtk.Box({ spacing: 6, css_classes: ["bar-notif-cluster"], valign: Gtk.Align.CENTER })
  const timeNotifIcon = new Gtk.Image({ icon_name: "notifications-symbolic", pixel_size: 14, valign: Gtk.Align.CENTER })
  const timeNotifCount = new Gtk.Label({ label: "", css_classes: ["bar-time-notif-count"], valign: Gtk.Align.CENTER })
  notifCluster.append(timeNotifIcon); notifCluster.append(timeNotifCount);
  timeContent.append(notifCluster); timeContent.append(timeLabel);

  const timeAccessor = createPoll("...", 1000, "date +'%a %b %d  %H:%M'", (out) => out.trim())
  timeAccessor.subscribe(() => { timeLabel.label = timeAccessor.get() })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    getServiceSafe(() => AstalNotifd.get_default(), "Notifd (Bar)").then(notifd => {
      if (!notifd) return;
      const sync = () => {
        const count = notifd.notifications.length
        notifCluster.set_visible(count > 0 || notifd.dont_disturb)
        timeNotifIcon.icon_name = notifd.dont_disturb ? "notifications-disabled-symbolic" : "notifications-symbolic"
        timeNotifCount.label = count > 0 ? count.toString() : ""
        timeNotifCount.set_visible(count > 0)
      }
      notifd.connect("notify::notifications", sync)
      notifd.connect("notify::dont-disturb", sync)
      sync()
    })
    return GLib.SOURCE_REMOVE
  })

  const SpotlightPill = SquircleContainer({
    child: new Gtk.Image({ icon_name: "edit-find-symbolic", pixel_size: 16, margin_start: 16, margin_end: 16 }),
    radius: 16,
    gloss: true,
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.25,
    borderColor: { r: 1, g: 1, b: 1, a: 0.35 },
    perfect: true,
    onClick: () => status.togglePrism()
  })

  const TimePill = SquircleContainer({
    child: timeContent,
    gloss: true,
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true,
    onClick: () => status.toggleNC()
  })

  const ResourcesPill = SquircleContainer({
    child: SystemResources(),
    gloss: true,
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true
  })

  const TrayPill = SquircleContainer({
    child: Tray(),
    gloss: true,
    color: { r: 1, g: 1, b: 1 },
    alpha: 0.15,
    borderColor: { r: 1, g: 1, b: 1, a: 0.25 },
    perfect: true
  })

  rightSide.append(ResourcesPill)
  rightSide.append(SpotlightPill)
  rightSide.append(ControlCenterMenu())
  rightSide.append(TrayPill)
  rightSide.append(TimePill)

  centerBox.set_start_widget(leftSide)
  centerBox.set_center_widget(centerSide)
  centerBox.set_end_widget(rightSide)

  win.set_child(centerBox)
  win.present()

  return win
}
