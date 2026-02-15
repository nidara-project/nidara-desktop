import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import app from "ags/gtk4/app"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"

// Astal Service Libraries
import AstalBattery from "gi://AstalBattery"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import AstalTray from "gi://AstalTray"
import WorkspaceOverview from "./WorkspaceOverview"
import WorkspacePreview from "./WorkspacePreview"
import { getWordmark } from "../utils"

// ... (skipping Tray logic for brevity in match) ...

/**
 * System Tray Module (Right) 📥
 */
function Tray() {
  const box = new Gtk.Box({
    name: "bar-tray",
    css_classes: ["bar-tray"],
    spacing: 8
  })

  const items = new Map<string, Gtk.Button>()

  const createItem = (tray: any, id: string) => {
    if (items.has(id)) return;

    // Use find() instead of get_item() to avoid service-level assertion crashes
    const item = tray.items.find((i: any) => i.item_id === id)
    if (!item) return;

    // Strict Visibility Check: only items with Icons or Titles
    if (!item.gicon && (!item.icon_name || item.icon_name.length === 0) && !item.title) return;

    const btn = new Gtk.Button({
      css_classes: ["bar-tray-btn"],
      tooltip_markup: item.tooltip_markup || item.title || id,
      child: new Gtk.Image({
        pixel_size: 16,
        css_classes: ["bar-tray-icon"],
        gicon: item.gicon,
        icon_name: item.icon_name
      })
    })

    // Context Menu Support 🖱️
    let menu: Gtk.PopoverMenu | null = null
    if (item.menu_model) {
      menu = new Gtk.PopoverMenu({
        menu_model: item.menu_model,
        autohide: true,
        has_arrow: false,
        css_classes: ["bar-tray-menu"]
      })
      menu.set_parent(btn)
      if (item.action_group) {
        btn.insert_action_group("dbusmenu", item.action_group)
      }
    }

    btn.connect("clicked", () => {
      try { item.activate(0, 0) } catch (e) { }
    })

    const gesture = new Gtk.GestureClick()
    gesture.set_button(0)
    gesture.connect("released", (g) => {
      const b = g.get_current_button()
      if (b === 3) { // Right Click
        try { item.about_to_show() } catch (e) { }
        if (menu) menu.popup()
      }
    })
    btn.add_controller(gesture)

    items.set(id, btn)
    box.append(btn)
  }

  const removeItem = (id: string) => {
    const btn = items.get(id)
    if (btn) {
      try {
        if (btn.get_parent() === box) box.remove(btn)
      } catch (e) { }
      items.delete(id)
    }
  }

  // Sync Tray Mechanism 📥 (Simplified & Robust)
  getServiceSafe(() => AstalTray.get_default(), "Tray").then(tray => {
    if (!tray) return;

    const syncVisibility = () => box.set_visible(items.size > 0)

    const addItem = (id: string) => {
      if (!id || items.has(id)) return
      createItem(tray, id)
      syncVisibility()
    }

    const delItem = (id: string) => {
      if (!id) return
      removeItem(id)
      syncVisibility()
    }

    // Connect signals first to catch new arrivals
    tray.connect("item-added", (_, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { addItem(id); return GLib.SOURCE_REMOVE }))
    tray.connect("item-removed", (_, id) => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { delItem(id); return GLib.SOURCE_REMOVE }))

    // Initial Sync on low priority next idle to ensure service list is stable
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
      try {
        const current = tray.items || []
        current.forEach(item => {
          if (item && item.item_id) addItem(item.item_id)
        })
      } catch (e) { }
      syncVisibility()
      return GLib.SOURCE_REMOVE
    })
  })

  box.set_visible(false) // Start hidden
  return box
}

/**
 * Robust Service Fetcher with Exponential Backoff 🛡️
 * Retries with increasing delays: 200ms, 400ms, 800ms, 1600ms, 3200ms
 */
async function getServiceSafe<T>(getter: () => T, name: string): Promise<T | null> {
  const MAX_RETRIES = 5;
  const BASE_DELAY = 200;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const service = getter();
      if (service) return service;
    } catch (e) {
      console.warn(`[Bar] Service ${name} not ready (attempt ${i + 1}/${MAX_RETRIES}), retrying...`);
    }
    // Exponential backoff: 200, 400, 800, 1600, 3200ms
    const delay = BASE_DELAY * Math.pow(2, i);
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => { r(null); return GLib.SOURCE_REMOVE }));
  }
  console.error(`[Bar] Service ${name} failed to initialize after ${MAX_RETRIES} attempts`);
  return null;
}



/**
 * App Menu Module (Left) 🍎
 */
function AppMenu() {
  const box = new Gtk.Box({
    name: "bar-app-menu",
    css_classes: ["bar-app-menu", "bar-app-menu-btn"],
    spacing: 12,
    valign: Gtk.Align.CENTER,
    focusable: false,
    can_focus: false
  })

  const distroIcon = new Gtk.Image({
    icon_name: "archlinux-symbolic",
    pixel_size: 24,
    css_classes: ["bar-app-distro-icon"]
  })

  const sep = new Gtk.Separator({
    orientation: Gtk.Orientation.VERTICAL,
    css_classes: ["bar-app-sep"],
    valign: Gtk.Align.CENTER,
    height_request: 12 // Strict separator height
  })


  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    getServiceSafe(() => AstalHyprland.get_default(), "Hyprland").then(hyprland => {
      if (!hyprland) return;

      const appName = new Gtk.Label({
        name: "bar-app-name",
        css_classes: ["bar-app-name"],
        label: "Finder"
      })

      let lastClient: any = null;

      const sync = () => {
        const client = hyprland.focused_client
        const title = getWordmark(client, hyprland)
        appName.label = title || "Finder"

        if (client !== lastClient) {
          if (lastClient) {
            try { (lastClient as any).disconnect_by_func(sync) } catch (e) { }
          }
          if (client) {
            client.connect("notify::title", sync)
          }
          lastClient = client
        }
      }

      hyprland.connect("notify::focused-client", sync)
      hyprland.connect("notify::focused-workspace", sync)
      sync()

      box.append(distroIcon)
      box.append(sep)
      box.append(appName)
    })
    return GLib.SOURCE_REMOVE
  })

  return box
}

/**
 * Stitch-style Workspace Module (Fixed 5 Dots) 🔘
 */
function Workspaces() {
  const hypr = AstalHyprland.get_default()

  const box = new Gtk.Box({
    name: "bar-workspaces",
    css_classes: ["bar-workspaces"],
    spacing: 8,
    valign: Gtk.Align.CENTER
  })

  // Fixed 5 dots (Stitch aesthetic)
  const dots = Array.from({ length: 5 }, (_, i) => {
    const id = i + 1
    const dot = new Gtk.Box({
      css_classes: ["workspace-dot"],
      valign: Gtk.Align.CENTER,
      halign: Gtk.Align.CENTER
    })

    const update = () => {
      const active = hypr.focusedWorkspace.id === id
      const occupied = hypr.get_workspace(id)?.clients.length > 0

      dot.remove_css_class("active")
      dot.remove_css_class("occupied")
      dot.remove_css_class("empty")

      if (active) dot.add_css_class("active")
      else if (occupied) dot.add_css_class("occupied")
      else dot.add_css_class("empty")
    }

    hypr.connect("notify::focused-workspace", update)
    hypr.connect("workspace-added", update)
    hypr.connect("workspace-removed", update)
    hypr.connect("client-added", update)
    hypr.connect("client-removed", update)
    update()

    return dot
  })

  dots.forEach(d => box.append(d))

  const btn = new Gtk.Button({
    child: box,
    css_classes: ["bar-ws-btn"],
    cursor: Gdk.Cursor.new_from_name("pointer", null),
    hexpand: false,
    vexpand: false,
    focusable: false,
    can_focus: false,
    focus_on_click: false
  })
  btn.connect("clicked", () => execAsync("ags request 'toggleAppGrid()'"))

  return btn
}

/**
 * Circular Resource Gauge (Cairo-based) ⭕
 */
function ResourceCircle(iconName: string, update: (cb: (val: number) => void) => void, interval = 2000) {
  const canvas = new Gtk.DrawingArea({
    css_classes: ["resource-canvas"],
    width_request: 24,
    height_request: 24,
    valign: Gtk.Align.CENTER,
    halign: Gtk.Align.CENTER
  })

  let percentage = 0

  canvas.set_draw_func((area, cr, width, height) => {
    const radius = Math.min(width, height) / 2 - 2
    const xc = width / 2
    const yc = height / 2

    // Background track
    cr.setSourceRGBA(0.2, 0.2, 0.2, 0.3)
    cr.setLineWidth(2.5)
    cr.arc(xc, yc, radius, 0, 2 * Math.PI)
    cr.stroke()

    // Progress arc
    if (percentage > 0) {
      const isCpu = iconName === "cpu-symbolic"
      if (isCpu) cr.setSourceRGBA(0.79, 0.65, 0.97, 1.0) // accent_purple
      else cr.setSourceRGBA(0.54, 0.81, 0.94, 1.0) // accent_blue approx

      cr.setLineWidth(2.5)
      cr.setLineCap(1) // Round caps
      const angle = (percentage / 100) * 2 * Math.PI
      cr.arc(xc, yc, radius, -Math.PI / 2, angle - Math.PI / 2)
      cr.stroke()
    }

    // DRAW INNER SYMBOL (Bespoke Cairo Icons) 💎
    const isCpu = iconName === "cpu-symbolic"
    cr.setLineCap(1)
    cr.setLineWidth(1.5)

    if (isCpu) {
      cr.setSourceRGBA(0.79, 0.65, 0.97, 1.0) // accent_purple
      // Center Chip
      const s = 6
      cr.rectangle(xc - s / 2, yc - s / 2, s, s)
      cr.stroke()
      // Pins
      const len = 2
      for (let i = -1; i <= 1; i += 2) {
        // Top/Bottom
        cr.moveTo(xc + i * 2, yc - s / 2); cr.lineTo(xc + i * 2, yc - s / 2 - len);
        cr.moveTo(xc + i * 2, yc + s / 2); cr.lineTo(xc + i * 2, yc + s / 2 + len);
        // Left/Right
        cr.moveTo(xc - s / 2, yc + i * 2); cr.lineTo(xc - s / 2 - len, yc + i * 2);
        cr.moveTo(xc + s / 2, yc + i * 2); cr.lineTo(xc + s / 2 + len, yc + i * 2);
      }
      cr.stroke()
    } else {
      cr.setSourceRGBA(0.54, 0.81, 0.94, 1.0) // accent_blue
      // RAM Stick
      const w = 4, h = 10
      cr.rectangle(xc - w / 2, yc - h / 2, w, h)
      cr.stroke()
      // Segments
      cr.moveTo(xc - w / 2, yc); cr.lineTo(xc + w / 2, yc)
      cr.moveTo(xc - w / 2, yc - 2); cr.lineTo(xc + w / 2, yc - 2)
      cr.moveTo(xc - w / 2, yc + 2); cr.lineTo(xc + w / 2, yc + 2)
      cr.stroke()
    }
  })

  const overlay = new Gtk.Overlay({
    css_classes: ["resource-circle"],
    valign: Gtk.Align.CENTER,
    halign: Gtk.Align.CENTER
  })
  overlay.set_child(canvas)

  const sync = () => {
    update((val) => {
      percentage = val
      canvas.queue_draw()
    })
    return true
  }

  sync()
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, sync)

  return overlay
}

/**
 * CPU and RAM Monitor Module 📊
 */
function SystemResources() {
  const box = new Gtk.Box({
    name: "bar-resources",
    css_classes: ["bar-resources"],
    spacing: 10,
    valign: Gtk.Align.CENTER
  })

  const cpu = ResourceCircle("cpu-symbolic", (cb) => {
    execAsync(["bash", "-c", "LC_ALL=C top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'"]).then(out => {
      const val = parseFloat(out.trim().replace(",", "."))
      cb(isNaN(val) ? 0 : Math.floor(val))
    })
  }, 2000)

  const ram = ResourceCircle("media-memory-symbolic", (cb) => {
    execAsync(["bash", "-c", "LC_ALL=C free -m | grep Mem | awk '{print $3/$2 * 100}'"]).then(out => {
      const val = parseFloat(out.trim().replace(",", "."))
      cb(isNaN(val) ? 0 : Math.floor(val))
    })
  }, 5000)

  box.append(cpu)
  box.append(ram)

  return box
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const win = new Gtk.Window({
    name: "crystal-bar",
    css_classes: ["crystal-bar"],
    application: app,
  })

  win.set_decorated(false)
  // @ts-ignore
  win.app_paintable = true

  // V135: Initialize LayerShell first
  let layerInit = false
  try {
    Gtk4LayerShell.init_for_window(win)
    layerInit = true
  } catch (e) { }

  if (layerInit) {
    try {
      Gtk4LayerShell.set_namespace(win, "crystal-bar")
      Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
      Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
      Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
      Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)

      // Precision Gaps: 8-32-8 UNIFIED CALIBRATION
      Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 0)
      Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.LEFT, 0)
      Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 0)
      Gtk4LayerShell.set_exclusive_zone(win, 40)

      // Focus Kill: Prevent accidental focus rings on the main bar
      win.focusable = false
      win.can_focus = false

      // @ts-ignore
      win.gdkmonitor = gdkmonitor
    } catch (e) {
      console.error("[Bar] LayerShell init failed:", e)
    }
  }

  const centerBox = new Gtk.CenterBox({
    name: "bar-centerbox",
    css_classes: ["bar-centerbox"],
    hexpand: true,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.FILL
  })

  const leftSide = new Gtk.Box({
    halign: Gtk.Align.START,
    valign: Gtk.Align.CENTER,
    css_classes: ["bar-left"],
    height_request: 32,
    vexpand: false,
    focusable: false,
    can_focus: false
  })
  leftSide.append(AppMenu())

  const centerSide = new Gtk.Box({
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    css_classes: ["bar-center"],
    height_request: 32,
    vexpand: false,
    focusable: false,
    can_focus: false
  })
  centerSide.append(Workspaces())

  const timeContent = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
  const timeLabel = new Gtk.Label({ name: "bar-time-label", css_classes: ["bar-time"], label: "...", valign: Gtk.Align.CENTER })
  const notifCluster = new Gtk.Box({ spacing: 6, css_classes: ["bar-notif-cluster"], valign: Gtk.Align.CENTER })
  const timeNotifIcon = new Gtk.Image({ icon_name: "notifications-symbolic", pixel_size: 14, valign: Gtk.Align.CENTER })
  const timeNotifCount = new Gtk.Label({ label: "", css_classes: ["bar-time-notif-count"], valign: Gtk.Align.CENTER })
  const timeSep = new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["bar-time-sep"], valign: Gtk.Align.CENTER })

  notifCluster.append(timeNotifIcon)
  notifCluster.append(timeNotifCount)

  timeContent.append(notifCluster)
  timeContent.append(timeSep)
  timeContent.append(timeLabel)

  const timeBtn = new Gtk.Button({
    css_classes: ["bar-time-btn"],
    child: timeContent,
    valign: Gtk.Align.CENTER,
    height_request: 32,
    focusable: false,
    can_focus: false,
    focus_on_click: false
  })

  const timeAccessor = createPoll("...", 1000, "date +'%a %b %d  %H:%M'", (out) => out.trim())
  timeAccessor.subscribe(() => { timeLabel.label = timeAccessor.get() })
  timeLabel.label = timeAccessor.get()

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    getServiceSafe(() => AstalNotifd.get_default(), "Notifd (Bar)").then(notifd => {
      if (!notifd) return;
      const sync = () => {
        const count = notifd.notifications.length
        const dnd = notifd.dont_disturb
        const anyNotif = count > 0 || dnd
        if (!anyNotif) { notifCluster.set_visible(false); return }
        notifCluster.set_visible(true)
        timeNotifIcon.icon_name = dnd ? "notifications-disabled-symbolic" : "notifications-symbolic"
        timeNotifIcon.set_visible(true)
        if (count > 0) {
          timeNotifCount.label = count.toString()
          timeNotifCount.set_visible(true)
        } else {
          timeNotifCount.set_visible(false)
        }
      }
      notifd.connect("notify::notifications", sync)
      notifd.connect("notify::dont-disturb", sync)
      sync()
    }).catch(e => console.error("[Bar] Notifd fetch failed:", e))
    return GLib.SOURCE_REMOVE
  })

  timeBtn.connect("clicked", () => { (app as any).DistroIA?.toggleCC() })

  // Discrete Floating Capsules (Phase F) 💊
  const ResourcePill = new Gtk.Box({
    css_classes: ["bar-right"],
    valign: Gtk.Align.CENTER,
    height_request: 32,
    focusable: false,
    can_focus: false
  })
  ResourcePill.append(SystemResources())

  const TrayPill = new Gtk.Box({
    css_classes: ["bar-right"],
    valign: Gtk.Align.CENTER,
    height_request: 32,
    focusable: false,
    can_focus: false
  })
  TrayPill.append(Tray())

  const TimePill = new Gtk.Box({
    css_classes: ["bar-right"],
    valign: Gtk.Align.CENTER,
    height_request: 32,
    focusable: false,
    can_focus: false
  })
  TimePill.append(timeBtn)

  const rightSide = new Gtk.Box({
    spacing: 8,
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
    hexpand: false,
    focusable: false,
    can_focus: false
  })
  rightSide.append(ResourcePill)
  rightSide.append(TrayPill)
  rightSide.append(TimePill)

  centerBox.set_start_widget(leftSide)
  centerBox.set_center_widget(centerSide)
  centerBox.set_end_widget(rightSide)

  win.set_child(centerBox)
  win.present()

  return win
}
