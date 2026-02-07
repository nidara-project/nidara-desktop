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
import { getWordmark } from "../utils"

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

  // Restore signal-based logic but fully decoupled from the main loop
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    getServiceSafe(() => AstalTray.get_default(), "Tray").then(tray => {
      if (!tray) return;

      // Sync initial set
      tray.items.forEach(item => createItem(tray, item.item_id))

      tray.connect("item-added", (_, id) => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          createItem(tray, id); return GLib.SOURCE_REMOVE;
        })
      })
      tray.connect("item-removed", (_, id) => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          removeItem(id); return GLib.SOURCE_REMOVE;
        })
      })
    })
    return GLib.SOURCE_REMOVE
  })

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
    css_classes: ["bar-app-menu"],
    spacing: 16
  })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    getServiceSafe(() => AstalHyprland.get_default(), "Hyprland").then(hyprland => {
      if (!hyprland) return;

      const appName = new Gtk.Label({
        name: "bar-app-name",
        css_classes: ["bar-app-name"],
        label: "Finder"
      })


      let lastClient: AstalHyprland.Client | null = null;

      const sync = () => {
        const client = hyprland.focused_client

        // V127: Robust Title Sync
        const title = getWordmark(client, hyprland)
        appName.label = title || "Finder"

        // If client changed, we need to listen to ITS title changes too
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

      box.append(appName)
    })
    return GLib.SOURCE_REMOVE
  })

  return box
}

/**
 * Workspace Indicator (Center) ⚪️
 */
function Workspaces() {
  const box = new Gtk.Box({
    name: "bar-workspaces",
    css_classes: ["bar-workspaces"],
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    hexpand: false // Prevent unwanted expansion! 🛡️
  })

  // 1. Permanent Pill Structure
  const label = new Gtk.Label({ label: "1", css_classes: ["bar-ws-pill"] })
  const pillBox = new Gtk.Box({
    spacing: 8,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER
  })
  pillBox.append(new Gtk.Image({ icon_name: "computer-symbolic", pixel_size: 16 }))
  pillBox.append(label)

  const btn = new Gtk.Button({
    css_classes: ["bar-ws-btn"],
    child: pillBox,
    cursor: Gdk.Cursor.new_from_name("pointer", null),
    hexpand: false, // Strict bounding! 🛡️
    vexpand: false
  })

  box.append(btn)

  // 2. Data & Cockpit Initialization
  getServiceSafe(() => AstalHyprland.get_default(), "Hyprland (WS)").then(hyprland => {
    if (!hyprland) return;

    // Standalone Cockpit Window (Surface-Isolation)
    const monitor = (btn.get_root() as any)?.gdk_monitor ||
      (btn.get_root() as any)?.gdkmonitor ||
      app.get_monitors()[0]
    const cockpit = WorkspaceOverview(monitor, hyprland)
    app.add_window(cockpit) // Register with app! 🛡️🚨

    const updateUI = () => {
      const id = hyprland.focused_workspace?.id || 1
      label.label = id.toString()
    }

    // Explicit Triggers
    btn.connect("clicked", () => {
      const target = !cockpit.get_visible()
      console.log(`[Cockpit] Toggle visibility to: ${target}`)
      cockpit.set_visible(target)
      if (target) cockpit.present()
    })

    let hoverTimeout: number | null = null
    const motion = new Gtk.EventControllerMotion()
    motion.connect("enter", () => {
      if (hoverTimeout) GLib.source_remove(hoverTimeout)
      hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        hoverTimeout = null
        if (!cockpit.get_visible()) {
          cockpit.set_visible(true)
          cockpit.present()
        }
        return GLib.SOURCE_REMOVE
      })
    })
    motion.connect("leave", () => {
      if (hoverTimeout) {
        GLib.source_remove(hoverTimeout)
        hoverTimeout = null
      }
    })
    btn.add_controller(motion)

    hyprland.connect("notify::focused-workspace", updateUI)
    updateUI()
  })

  return box
}

/**
 * System Status Modules (Right) 🔋📶🔊🔔🎛️🕒
 */
function SystemStatus() {
  const box = new Gtk.Box({
    name: "bar-status",
    css_classes: ["bar-status"],
    spacing: 12
  })

  // 1. Static Placeholders to force Order (Tray -> Net -> Vol -> Bat -> CC) 🏗️
  const trayBox = Tray()
  const netBox = new Gtk.Box({ spacing: 8 })
  const volBox = new Gtk.Box({ spacing: 8 })
  const batBox = new Gtk.Box({ spacing: 8 })
  const ccBox = new Gtk.Box({ spacing: 8 })

  box.append(trayBox)
  box.append(netBox)
  box.append(volBox)
  box.append(batBox)
  box.append(ccBox)

  // 2. Control Center Button (High Priority)
  const ccBtn = new Gtk.Button({
    css_classes: ["bar-util-btn", "cc-trigger"],
    child: new Gtk.Label({ label: "󰕮", css_classes: ["bar-cc-icon"] }),
    tooltip_text: "Centro de Control"
  })
  ccBtn.connect("clicked", () => {
    try { (globalThis as any).toggleControlCenter?.() } catch (e) { }
  })
  ccBox.append(ccBtn)

  // 3. Deferred Service Population 🏎️
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    // Network
    getServiceSafe(() => AstalNetwork.get_default(), "Network").then(net => {
      if (!net) return;
      const icon = new Gtk.Image({ pixel_size: 16 })
      const btn = new Gtk.Button({ css_classes: ["bar-status-btn"], child: icon })
      const syncStatus = () => {
        if (net.wifi) icon.icon_name = net.wifi.icon_name
        else if (net.wired) icon.icon_name = net.wired.icon_name
        else icon.icon_name = "network-offline-symbolic"
      }
      net.connect("notify::wifi", syncStatus); net.connect("notify::wired", syncStatus); syncStatus()
      netBox.append(btn)
    }).catch(() => { })

    // Volume
    try {
      const icon = new Gtk.Image({ icon_name: "audio-volume-high-symbolic", pixel_size: 16 })
      const btn = new Gtk.Button({ css_classes: ["bar-status-btn"], child: icon })
      const poll = createPoll("0%", 1000, "pamixer --get-volume-human", (out) => out.trim())
      poll.subscribe(() => {
        const val = poll.get()
        if (val === "muted") icon.icon_name = "audio-volume-muted-symbolic"
        else {
          const v = parseInt(val)
          if (v <= 33) icon.icon_name = "audio-volume-low-symbolic"
          else if (v <= 66) icon.icon_name = "audio-volume-medium-symbolic"
          else icon.icon_name = "audio-volume-high-symbolic"
        }
      })
      volBox.append(btn)
    } catch (e) { }

    // Battery
    getServiceSafe(() => AstalBattery.get_default(), "Battery").then(bat => {
      if (!bat) return;
      const bContent = new Gtk.Box({ spacing: 6 })
      const bIcon = new Gtk.Image({ icon_name: bat.icon_name, pixel_size: 16 })
      const bLabel = new Gtk.Label({ css_classes: ["bar-bat-label"] })
      bContent.append(bIcon); bContent.append(bLabel)
      const syncBat = () => {
        bIcon.icon_name = bat.icon_name
        bLabel.label = `${Math.floor(bat.percentage * 100)}%`
        bContent.set_visible(bat.is_present)
      }
      bat.connect("notify::percentage", syncBat); bat.connect("notify::charging", syncBat); syncBat()
      batBox.append(bContent)
    }).catch(() => { })

    return GLib.SOURCE_REMOVE
  })

  return box
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const win = new Gtk.Window({
    name: "crystal-bar",
    css_classes: ["crystal-bar"],
    application: app,
  })

  win.set_decorated(false)

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
      Gtk4LayerShell.set_exclusive_zone(win, 44)
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

  const leftSide = new Gtk.Box({ spacing: 12, halign: Gtk.Align.START, css_classes: ["bar-left"] })
  leftSide.append(AppMenu())

  const centerSide = new Gtk.Box({ halign: Gtk.Align.CENTER, hexpand: true, css_classes: ["bar-center"] })
  centerSide.append(Workspaces())

  const rightSide = new Gtk.Box({ spacing: 20, halign: Gtk.Align.END, css_classes: ["bar-right"] })
  rightSide.append(SystemStatus())

  const timeContent = new Gtk.Box({ spacing: 8 })
  const timeLabel = new Gtk.Label({ name: "bar-time-label", css_classes: ["bar-time"], label: "..." })
  const notifCluster = new Gtk.Box({ spacing: 6, css_classes: ["bar-notif-cluster"] })
  const timeNotifIcon = new Gtk.Image({ icon_name: "notifications-symbolic", pixel_size: 14 })
  const timeNotifCount = new Gtk.Label({ label: "", css_classes: ["bar-time-notif-count"] })

  notifCluster.append(timeNotifIcon)
  notifCluster.append(timeNotifCount)

  timeContent.append(notifCluster)
  timeContent.append(timeLabel)

  const timeBtn = new Gtk.Button({ css_classes: ["bar-time-btn"], child: timeContent })

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

        if (!anyNotif) {
          notifCluster.set_visible(false)
          return
        }

        notifCluster.set_visible(true)

        // Icon Logic: Prioritize DND icon if active
        timeNotifIcon.icon_name = dnd ? "notifications-disabled-symbolic" : "notifications-symbolic"
        timeNotifIcon.set_visible(true)

        // Count Logic: Always show if > 0
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
    })
    return GLib.SOURCE_REMOVE
  })

  timeBtn.connect("clicked", () => { (globalThis as any).toggleNotificationCenter?.() })
  rightSide.append(timeBtn)

  centerBox.set_start_widget(leftSide)
  centerBox.set_center_widget(centerSide)
  centerBox.set_end_widget(rightSide)

  win.set_child(centerBox)
  win.present()

  return win
}
