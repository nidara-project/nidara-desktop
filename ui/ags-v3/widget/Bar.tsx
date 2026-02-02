import { Astal, Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { createPoll } from "ags/time"
import app from "ags/gtk4/app"
import AstalHyprland from "gi://AstalHyprland"
import Gtk4LayerShell from "gi://Gtk4LayerShell"

// Native Premium Imports
import AstalBattery from "gi://AstalBattery"
import AstalNetwork from "gi://AstalNetwork"

const hyprland = AstalHyprland.get_default()

/**
 * App Menu Module (Left) 🍎
 * Shows the Active App Name + Mock Menus
 */
function AppMenu() {
  const box = new Gtk.Box({
    name: "bar-app-menu",
    css_classes: ["bar-app-menu"],
    spacing: 16
  })

  const appName = new Gtk.Label({
    name: "bar-app-name",
    css_classes: ["bar-app-name"],
    label: "Desktop"
  })

  // Mock Menus
  const menus = ["Archivo", "Editar", "Ver", "Ir", "Ventana", "Ayuda"]
  const mockBox = new Gtk.Box({ spacing: 14 })

  menus.forEach(m => {
    const lbl = new Gtk.Label({
      label: m,
      css_classes: ["bar-menu-item"]
    })
    mockBox.append(lbl)
  })

  const sync = () => {
    const client = hyprland.focused_client
    appName.label = client ? (client.class || "App") : "Finder"
  }

  hyprland.connect("notify::focused-client", sync)
  sync()

  box.append(appName)
  box.append(mockBox)
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

  const sync = () => {
    let child = box.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      box.remove(child)
      child = next
    }

    const workspaces = hyprland.get_workspaces().sort((a, b) => a.id - b.id)
    workspaces.forEach(ws => {
      if (ws.id < 0) return
      const active = hyprland.focused_workspace.id === ws.id

      const dot = new Gtk.Button({
        css_classes: ["bar-ws-dot", active ? "active" : ""],
        cursor: Gdk.Cursor.new_from_name("pointer", null),
        action_name: `hyprland.dispatch`,
      })
      // Manual click handler since Gtk.Action is complex
      dot.connect("clicked", () => {
        hyprland.dispatch("workspace", ws.id.toString())
      })

      box.append(dot)
    })
  }

  hyprland.connect("notify::focused-workspace", sync)
  hyprland.connect("workspace-added", sync)
  hyprland.connect("workspace-removed", sync)
  sync()

  return box
}

/**
 * System Status Modules (Right) 🔋📶🔊
 */
function SystemStatus() {
  const box = new Gtk.Box({
    name: "bar-status",
    css_classes: ["bar-status"],
    spacing: 16
  })

  // Native Network 📶
  const network = AstalNetwork.get_default()
  const netContent = new Gtk.Box({ spacing: 8 })
  const netIcon = new Gtk.Label({ label: "󰖩", css_classes: ["bar-status-icon"] })
  const netLabel = new Gtk.Label({ label: "Checking...", css_classes: ["bar-status-label"] })
  netContent.append(netIcon)
  netContent.append(netLabel)

  const netBtn = new Gtk.Button({
    css_classes: ["bar-status-btn"],
    child: netContent
  })

  const syncNet = () => {
    if (network.wifi) {
      netIcon.label = "󰖩"
      netLabel.label = network.wifi.ssid || "Wi-Fi"
    } else {
      netIcon.label = "󰖩"
      netLabel.label = "Ethernet"
    }
  }
  network.connect("notify::wifi", syncNet)
  syncNet()

  netBtn.connect("clicked", () => {
    execAsync("nm-connection-editor").catch(console.error)
  })

  // Native Battery 🔋
  const battery = AstalBattery.get_default()
  const batLabel = new Gtk.Label({ css_classes: ["bar-bat-label"] })

  const syncBat = () => {
    if (battery) {
      const icon = battery.charging ? "󰂄" : "󰁹"
      batLabel.label = `${icon}  ${Math.floor(battery.percentage * 100)}%`
      batLabel.set_visible(battery.is_present)
    }
  }
  if (battery) {
    battery.connect("notify::percentage", syncBat)
    battery.connect("notify::charging", syncBat)
    syncBat()
  } else {
    batLabel.set_visible(false)
  }

  // Volume (Shell Fallback for now) 🔊
  const volContent = new Gtk.Box({ spacing: 8 })
  const volIcon = new Gtk.Label({ label: "󰕾", css_classes: ["bar-status-icon"] })
  const volLabel = new Gtk.Label({ label: "0%", css_classes: ["bar-status-label"] })
  volContent.append(volIcon)
  volContent.append(volLabel)

  const volBtn = new Gtk.Button({
    css_classes: ["bar-status-btn"],
    child: volContent
  })

  const volAccessor = createPoll("0%", 1000, "pamixer --get-volume-human", (out) => out.trim())
  volAccessor.subscribe(() => {
    const val = volAccessor.get()
    if (val === "muted") {
      volIcon.label = "󰝟"
      volLabel.label = "Muted"
    } else {
      volIcon.label = "󰕾"
      volLabel.label = val
    }
  })

  // Initial sync
  const initialVol = volAccessor.get()
  volLabel.label = initialVol === "muted" ? "Muted" : initialVol

  volBtn.connect("clicked", () => {
    execAsync("pavucontrol").catch(console.error)
  })

  // Screenshot Button
  const screenshotBtn = new Gtk.Button({
    child: new Gtk.Image({ icon_name: "camera-photo-symbolic", pixel_size: 16 }),
    css_classes: ["bar-util-btn"],
    tooltip_text: "Captura de pantalla"
  })
  screenshotBtn.connect("clicked", () => {
    execAsync(`bash -c 'grim -g "$(slurp)" /tmp/screenshot_$(date +%Y%m%d_%H%M%S).png && notify-send "Captura realizada" "Guardada en /tmp"'`)
      .catch(e => {
        console.error("[Bar] Screenshot failed:", e)
        execAsync(`notify-send -u critical "Error de captura" "${e}"`)
      })
  })

  box.append(screenshotBtn)
  box.append(volBtn)
  box.append(netBtn)
  box.append(batLabel)
  return box
}

export default function Bar(gdkmonitor: Gdk.Monitor) {
  const win = new Gtk.Window({
    name: "crystal-bar",
    css_classes: ["crystal-bar"],
    application: app,
  })

  win.set_decorated(false)

  // Gtk4LayerShell Configuration
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
    css_classes: ["bar-centerbox"]
  })

  // LEFT: App + Menus
  const leftSide = new Gtk.Box({
    spacing: 12,
    halign: Gtk.Align.START,
    css_classes: ["bar-left"]
  })
  leftSide.append(AppMenu())

  // CENTER: Workspaces
  const centerSide = new Gtk.Box({
    halign: Gtk.Align.CENTER,
    css_classes: ["bar-center"]
  })
  centerSide.append(Workspaces())

  // RIGHT: Status + Clock
  const rightSide = new Gtk.Box({
    spacing: 20,
    halign: Gtk.Align.END,
    css_classes: ["bar-right"]
  })

  rightSide.append(SystemStatus())

  const timeLabel = new Gtk.Label({
    name: "bar-time",
    css_classes: ["bar-time"],
    label: "..."
  })

  const timeAccessor = createPoll("...", 1000, "date +'%a %b %d  %H:%M'", (out) => out.trim())
  timeAccessor.subscribe(() => {
    timeLabel.label = timeAccessor.get()
  })
  // Initial sync
  timeLabel.label = timeAccessor.get()

  rightSide.append(timeLabel)

  centerBox.set_start_widget(leftSide)
  centerBox.set_center_widget(centerSide)
  centerBox.set_end_widget(rightSide)

  win.set_child(centerBox)
  win.present()

  return win
}
