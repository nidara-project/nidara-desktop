import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
// import AstalBluetooth from "gi://AstalBluetooth" // Still missing on system
import GLib from "gi://GLib"
import { execAsync } from "ags/process"

function Media() {
    const mpris = AstalMpris.get_default()

    const box = new Gtk.Box({
        css_classes: ["cc-media"],
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8
    })

    const sync = () => {
        let child = box.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            box.remove(child)
            child = next
        }

        const players = mpris.players.filter(p => p.playback_status !== AstalMpris.PlaybackStatus.STOPPED).slice(0, 1)
        if (players.length === 0) {
            box.append(new Gtk.Label({ label: "No hay nada sonando", css_classes: ["cc-media-empty"] }))
            box.set_visible(false)
            return
        }

        box.set_visible(true)
        const p = players[0]
        const playerBox = new Gtk.Box({ spacing: 12, css_classes: ["cc-media-player"] })

        const art = new Gtk.Box({
            css_classes: ["cc-media-art"],
            valign: Gtk.Align.CENTER
        })
        if (p.cover_art) {
            art.set_css_classes(["cc-media-art", "with-cover"])
            art.append(new Gtk.Image({ file: p.cover_art, pixel_size: 54 }))
        } else {
            art.append(new Gtk.Image({ icon_name: "audio-x-generic-symbolic", pixel_size: 32 }))
        }

        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
        info.append(new Gtk.Label({
            label: p.title || "Unknown Title",
            css_classes: ["cc-media-title"],
            halign: Gtk.Align.START,
            ellipsize: 3,
            max_width_chars: 20
        }))
        info.append(new Gtk.Label({
            label: p.artist || "Unknown Artist",
            css_classes: ["cc-media-artist"],
            halign: Gtk.Align.START,
            ellipsize: 3
        }))

        const controls = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END })

        const prev = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-backward-symbolic" }), css_classes: ["cc-media-btn"] })
        prev.connect("clicked", () => p.previous())

        const play = new Gtk.Button({
            child: new Gtk.Image({ icon_name: p.playback_status === AstalMpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic" : "media-playback-start-symbolic" }),
            css_classes: ["cc-media-btn"]
        })
        play.connect("clicked", () => p.play_pause())

        const nextBtn = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-forward-symbolic" }), css_classes: ["cc-media-btn"] })
        nextBtn.connect("clicked", () => p.next())

        controls.append(prev)
        controls.append(play)
        controls.append(nextBtn)

        playerBox.append(art)
        playerBox.append(info)
        playerBox.append(controls)
        box.append(playerBox)
    }

    mpris.connect("notify::players", sync)
    sync()

    return box
}

function GridControls() {
    let network;
    let bluetooth;

    try {
        network = AstalNetwork.get_default()
    } catch (e) { console.warn("[CC] Network service unavailable:", e) }

    /* Bluetooth disabled - AstalBluetooth missing
    try {
        bluetooth = AstalBluetooth.get_default()
    } catch (e) { console.warn("[CC] Bluetooth service unavailable:", e) }
    */

    const grid = new Gtk.Grid({
        column_spacing: 12,
        row_spacing: 12,
        css_classes: ["cc-grid"]
    })

    const createToggle = (iconName: string, label: string, active: boolean, onClick: () => void) => {
        const box = new Gtk.Box({
            spacing: 8,
            css_classes: ["cc-toggle", active ? "active" : ""]
        })
        const btn = new Gtk.Button({ child: box })
        btn.connect("clicked", onClick)

        const i = new Gtk.Image({ icon_name: iconName, pixel_size: 18, css_classes: ["cc-toggle-icon"] })
        const l = new Gtk.Label({ label: label, css_classes: ["cc-toggle-label"] })

        box.append(i)
        box.append(l)
        return btn
    }

    let col = 0
    let row = 0

    // WiFi Real Toggle - Only if hardware present
    if (network && network.wifi) {
        const wifi = createToggle(network.wifi.icon_name, "Wi-Fi", network.wifi.enabled, () => {
            network.wifi.enabled = !network.wifi.enabled
        })
        grid.attach(wifi, col++, row, 1, 1)
    }

    // Bluetooth Toggle - DISABLED
    /*
    if (bluetooth && bluetooth.is_powered !== undefined) {
        try {
            const btActive = bluetooth.is_powered
            const bt = createToggle(
                btActive ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic",
                "Bluetooth",
                btActive,
                () => {
                    try {
                        bluetooth.is_powered = !bluetooth.is_powered
                    } catch (e) {
                        console.error("[CC] Bluetooth toggle failed:", e)
                    }
                }
            )
            grid.attach(bt, col++, row, 1, 1)
        } catch (e) {
            console.warn("[CC] Bluetooth toggle creation failed:", e)
        }
    }
    */

    // If no toggles were added, hide the grid
    if (col === 0 && row === 0) {
        grid.set_visible(false)
    }

    return grid
}

function Sliders() {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-sliders"]
    })

    const volRow = new Gtk.Box()
    const brtRow = new Gtk.Box()
    box.append(volRow)
    box.append(brtRow)

    const createSlider = (iconName: string, className: string, initialValue: number, onChange: (val: number) => void) => {
        const row = new Gtk.Box({ spacing: 12, css_classes: ["cc-slider-row", className] })
        const i = new Gtk.Image({ icon_name: iconName, pixel_size: 18, css_classes: ["cc-slider-icon"] })

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            draw_value: false
        })
        scale.set_range(0, 100)
        scale.set_value(initialValue)
        scale.connect("value-changed", () => onChange(scale.get_value()))

        row.append(i)
        row.append(scale)
        return row
    }

    // Volume Init 🔊
    execAsync("pamixer --get-volume").then(out => {
        const val = parseInt(out)
        volRow.append(createSlider("audio-volume-high-symbolic", "vol", val, (v) => execAsync(`pamixer --set-volume ${Math.floor(v)}`)))
    }).catch(() => {
        volRow.append(createSlider("audio-volume-high-symbolic", "vol", 50, (v) => execAsync(`pamixer --set-volume ${Math.floor(v)}`)))
    })

    // Brightness Init ☀️
    execAsync("brightnessctl g").then(curr => {
        execAsync("brightnessctl m").then(max => {
            const val = Math.floor((parseInt(curr) / parseInt(max)) * 100)
            brtRow.append(createSlider("display-brightness-symbolic", "brt", val, (v) => execAsync(`brightnessctl s ${Math.floor(v)}%`)))
        })
    }).catch(() => { })

    return box
}

export default function ControlCenter(gdkmonitor: Gdk.Monitor) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 20,
        css_classes: ["control-center"]
    })

    let initialized = false
    const ensureInit = () => {
        if (initialized) return

        // Phase 1: Atomic Sliders (Fast)
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try { box.append(Sliders()) } catch (e) { console.error("[CC] Sliders init failed:", e) }
            return GLib.SOURCE_REMOVE
        })

        // Phase 2: Atomic Network/BT (Can be slow)
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try { box.append(GridControls()) } catch (e) { console.error("[CC] Grid init failed:", e) }
            return GLib.SOURCE_REMOVE
        })

        // Phase 3: Media (Medium)
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try { box.append(Media()) } catch (e) { console.error("[CC] Media init failed:", e) }
            return GLib.SOURCE_REMOVE
        })

        initialized = true
    }

    const win = new Gtk.Window({
        name: "control-center-win",
        application: app,
        css_classes: ["control-center-win"],
        child: box,
        visible: false
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "control-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 54)
        Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 12)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) {
        console.error("[CC] LayerShell failed:", e)
    }

    // @ts-ignore
    win.toggle = () => {
        ensureInit()
        win.set_visible(!win.get_visible())
        if (win.get_visible()) win.present()
    }

    return win
}
