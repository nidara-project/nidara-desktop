import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import app from "ags/gtk4/app"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"

// Native Premium Imports
import AstalBattery from "gi://AstalBattery"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"

/**
 * Robust Service Fetcher 🛡️
 */
async function getServiceSafe<T>(getter: () => T, name: string): Promise<T | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const service = getter();
      if (service) return service;
    } catch (e) {
      console.warn(`[Bar] Service ${name} not ready (attempt ${i + 1}), retrying...`);
    }
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => { r(null); return GLib.SOURCE_REMOVE }));
  }
  return null;
}

/**
 * Wordmark Engine 🍎
 * Pretty names and sanitization for a premium look.
 */
function getWordmark(client: AstalHyprland.Client | null, hyprland: AstalHyprland.Hyprland): string {
  if (!client) {
    const ws = hyprland.focused_workspace
    return ws ? `Workspace ${ws.id}` : "Workspace"
  }

  const classMap: Record<string, string> = {
    "google-chrome": "Google Chrome",
    "chrome-google.com": "Google Chrome",
    "firefox": "Firefox",
    "code-url-handler": "Visual Studio Code",
    "code": "Visual Studio Code",
    "thunar": "Archivos",
    "foot": "Terminal",
    "kitty": "Terminal",
    "nautilus": "Archivos",
    "pavucontrol": "Ajustes de Sonido",
    "nm-connection-editor": "Red",
    "org.gnome.Settings": "Ajustes",
    "vlc": "VLC Player",
    "spotify": "Spotify",
    "discord": "Discord",
    "telegram-desktop": "Telegram",
    "org.gnome.Calendar": "Calendario"
  }

  // 1. Prioritize Title for specific dynamic context (like Browser tabs or Folders)
  let title = client.title || ""

  // 2. Clear known suffixes to keep it clean
  const suffixes = [
    " — Mozilla Firefox",
    " - Google Chrome",
    " - Visual Studio Code",
    " - VSCodium",
    " - Terminal",
    " - File Manager"
  ]
  suffixes.forEach(s => { if (title.endsWith(s)) title = title.replace(s, "") })

  // 3. If title is too generic or empty, use class mapping
  const genericTitles = ["New Tab", "Google Chrome", "Mozilla Firefox", "Untitled", "index.html", "Enter name of file", ""]
  if (genericTitles.includes(title) || title.length < 2) {
    return classMap[client.class.toLowerCase()] ||
      client.class.charAt(0).toUpperCase() + client.class.slice(1) ||
      "App"
  }

  return title
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
        appName.label = getWordmark(client, hyprland)

        // If client changed, we need to listen to ITS title changes too
        if (client !== lastClient) {
          if (lastClient) {
            try { lastClient.disconnect_by_func(sync) } catch (e) { }
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
    spacing: 8
  })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    getServiceSafe(() => AstalHyprland.get_default(), "Hyprland (WS)").then(hyprland => {
      if (!hyprland) return;

      const sync = () => {
        let child = box.get_first_child()
        while (child) {
          const next = child.get_next_sibling()
          box.remove(child)
          child = next
        }

        const workspaces = hyprland.get_workspaces() || []
        const occupied = new Set(workspaces.map(ws => ws.id))
        const focused = hyprland.focused_workspace
        const focusedId = focused ? focused.id : 1

        const maxWs = Math.max(5, focusedId, ...(Array.from(occupied) as number[]))

        for (let i = 1; i <= maxWs; i++) {
          const active = focusedId === i
          const hasWindows = occupied.has(i)

          const dot = new Gtk.Button({
            css_classes: ["bar-ws-dot", active ? "active" : "", hasWindows ? "occupied" : ""],
            cursor: Gdk.Cursor.new_from_name("pointer", null),
          })
          dot.connect("clicked", () => {
            hyprland.dispatch("workspace", i.toString())
          })
          box.append(dot)
        }
      }

      hyprland.connect("notify::focused-workspace", sync)
      hyprland.connect("workspace-added", sync)
      hyprland.connect("workspace-removed", sync)
      sync()
    })
    return GLib.SOURCE_REMOVE
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
    spacing: 16
  })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    getServiceSafe(() => AstalNetwork.get_default(), "Network").then(network => {
      if (!network) return;
      const netIcon = new Gtk.Label({ label: "󰖩", css_classes: ["bar-status-icon"] })
      const netBtn = new Gtk.Button({ css_classes: ["bar-status-btn"], child: netIcon })

      const syncNet = () => {
        if (network.wifi) {
          netIcon.label = "󰖩"
          netBtn.tooltip_text = network.wifi.ssid || "Wi-Fi"
        } else if (network.wired) {
          netIcon.label = "󰈀"
          netBtn.tooltip_text = "Ethernet"
        } else {
          netIcon.label = "󰖪"
          netBtn.tooltip_text = "Desconectado"
        }
      }
      network.connect("notify::wifi", syncNet)
      network.connect("notify::wired", syncNet)
      syncNet()
      netBtn.connect("clicked", () => execAsync("nm-connection-editor").catch(console.error))
      box.prepend(netBtn)
    })
    return GLib.SOURCE_REMOVE
  })

  const volContent = new Gtk.Box({ spacing: 8 })
  const volIcon = new Gtk.Label({ label: "󰕾", css_classes: ["bar-status-icon"] })
  const volLabel = new Gtk.Label({ label: "0%", css_classes: ["bar-status-label"] })
  volContent.append(volIcon); volContent.append(volLabel)
  const volBtn = new Gtk.Button({ css_classes: ["bar-status-btn"], child: volContent })
  const volAccessor = createPoll("0%", 1000, "pamixer --get-volume-human", (out) => out.trim())
  volAccessor.subscribe(() => {
    const val = volAccessor.get()
    if (val === "muted") { volIcon.label = "󰝟"; volLabel.label = "Muted" }
    else { volIcon.label = "󰕾"; volLabel.label = val }
  })
  volBtn.connect("clicked", () => execAsync("pavucontrol").catch(console.error))
  box.append(volBtn)

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
    getServiceSafe(() => AstalBattery.get_default(), "Battery").then(battery => {
      if (!battery) return;
      const batLabel = new Gtk.Label({ css_classes: ["bar-bat-label"] })
      const syncBat = () => {
        const icon = battery.charging ? "󰂄" : "󰁹"
        batLabel.label = `${icon}  ${Math.floor(battery.percentage * 100)}%`
        batLabel.set_visible(battery.is_present)
      }
      battery.connect("notify::percentage", syncBat)
      battery.connect("notify::charging", syncBat)
      syncBat()
      box.append(batLabel)
    })
    return GLib.SOURCE_REMOVE
  })



  const ccBtn = new Gtk.Button({
    css_classes: ["bar-util-btn"],
    child: new Gtk.Label({ label: "󰕮", css_classes: ["bar-cc-icon"] }),
    tooltip_text: "Centro de Control"
  })
  ccBtn.connect("clicked", () => { (globalThis as any).toggleControlCenter?.() })
  box.append(ccBtn)

  return box
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const win = new Gtk.Window({
    name: "crystal-bar",
    css_classes: ["crystal-bar"],
    application: app,
  })

  win.set_decorated(false)

  try {
    Gtk4LayerShell.init_for_window(win)
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

  const centerBox = new Gtk.CenterBox({
    name: "bar-centerbox",
    css_classes: ["bar-centerbox"],
    hexpand: true,
    halign: Gtk.Align.FILL,
    valign: Gtk.Align.FILL
  })

  const leftSide = new Gtk.Box({ spacing: 12, halign: Gtk.Align.START, css_classes: ["bar-left"] })
  leftSide.append(AppMenu())

  const centerSide = new Gtk.Box({ halign: Gtk.Align.CENTER, css_classes: ["bar-center"] })
  centerSide.append(Workspaces())

  const rightSide = new Gtk.Box({ spacing: 20, halign: Gtk.Align.END, css_classes: ["bar-right"] })
  rightSide.append(SystemStatus())

  const timeContent = new Gtk.Box({ spacing: 8 })
  const timeLabel = new Gtk.Label({ name: "bar-time-label", css_classes: ["bar-time"], label: "..." })
  const notifCluster = new Gtk.Box({ spacing: 6, css_classes: ["bar-notif-cluster"] })
  const timeNotifIcon = new Gtk.Label({ label: "", css_classes: ["bar-time-notif-icon"] })
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
        timeNotifIcon.label = dnd ? "󰂛" : "󰂚"
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
