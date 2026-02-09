import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
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

    mpris.connect("player-added", (_, p) => {
        p.connect("notify::playback-status", sync)
        p.connect("notify::metadata", sync)
        sync()
    })
    mpris.connect("player-closed", sync)
    mpris.players.forEach(p => {
        p.connect("notify::playback-status", sync)
        p.connect("notify::metadata", sync)
    })
    sync()

    return box
}

function GridControls() {
    let network: AstalNetwork.Network | null = null;
    let bluetooth: AstalBluetooth.Bluetooth | null = null;

    try { network = AstalNetwork.get_default() } catch (e) { }
    try { bluetooth = AstalBluetooth.get_default() } catch (e) { }

    const grid = new Gtk.Grid({
        column_spacing: 12,
        row_spacing: 12,
        css_classes: ["cc-grid"]
    })

    const createToggle = (iconName: string | null, label: string, sublabel: string, active: boolean, onClick: () => void) => {
        const box = new Gtk.Box({
            spacing: 12,
            css_classes: ["cc-toggle", active ? "active" : ""]
        })
        const btn = new Gtk.Button({ child: box, hexpand: true })
        btn.connect("clicked", onClick)

        const i = new Gtk.Image({ icon_name: iconName || "network-wired-symbolic", pixel_size: 20, css_classes: ["cc-toggle-icon"] })
        const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
        const l = new Gtk.Label({ label: label, css_classes: ["cc-toggle-label"], halign: Gtk.Align.START })
        const sl = new Gtk.Label({ label: sublabel, css_classes: ["cc-toggle-sublabel"], halign: Gtk.Align.START, ellipsize: 3 })

        textStack.append(l)
        textStack.append(sl)

        box.append(i)
        box.append(textStack)

        // Add a signal handler to update the box class when active changes
        // (Simplified for this version, we will re-render on service sync if needed)

        return btn
    }

    const update = () => {
        // Clear grid
        let child = grid.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            grid.remove(child)
            child = next
        }

        let col = 0
        let row = 0

        // 📶 Network Widget
        if (network) {
            let label = "Red"
            let sublabel = "Desconectado"
            let icon = "network-offline-symbolic"
            let active = false

            if (network.wired && network.wired.state === 100) {
                label = "Ethernet"
                sublabel = "Conectado"
                icon = network.wired.icon_name || "network-wired-symbolic"
                active = true
            } else if (network.wifi) {
                label = "Wi-Fi"
                sublabel = network.wifi.active_access_point?.ssid || (network.wifi.enabled ? "Buscando..." : "Desactivado")
                icon = network.wifi.icon_name || "network-wireless-signal-excellent-symbolic"
                active = network.wifi.enabled
            }

            const netBtn = createToggle(icon, label, sublabel, active, () => {
                if (network!.wifi) network!.wifi.enabled = !network!.wifi.enabled
            })
            grid.attach(netBtn, col++, row, 1, 1)
        }

        //  Bluetooth Widget
        if (bluetooth) {
            const active = bluetooth.is_powered
            const label = "Bluetooth"
            const sublabel = active ? (bluetooth.devices.find(d => d.connected)?.name || "Activado") : "Desactivado"
            const icon = active ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic"

            const btBtn = createToggle(icon, label, sublabel, active, () => {
                bluetooth!.is_powered = !bluetooth!.is_powered
            })
            grid.attach(btBtn, col++, row, 1, 1)
        }
    }

    if (network) {
        network.connect("notify::wifi", update)
        network.connect("notify::wired", update)
    }
    if (bluetooth) {
        bluetooth.connect("notify::is-powered", update)
        bluetooth.connect("notify::devices", update)
    }

    update()
    return grid
}

function AudioSinks() {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["cc-audio-sinks"]
    })

    const sync = () => {
        execAsync("wpctl status").then(out => {
            // Remove old children
            let child = box.get_first_child()
            while (child) {
                const next = child.get_next_sibling()
                box.remove(child)
                child = next
            }

            // Simple parser for Sinks section
            const lines = out.split("\n")
            let inSinks = false
            const sinks: { id: string, name: string, active: boolean }[] = []

            for (const line of lines) {
                // Remove decoration characters and excessive spaces
                const clean = line.replace(/[│├─└\*]/g, " ").trim()
                if (clean.includes("Sinks:")) { inSinks = true; continue }
                if (inSinks && (clean.includes("Sources:") || clean === "")) {
                    inSinks = false;
                    if (clean.includes("Sources:")) break;
                    continue;
                }

                if (inSinks && clean.match(/^\d+\./)) {
                    const match = clean.match(/^(\d+)\.\s+(.*)/)
                    if (match) {
                        const active = line.includes("*")
                        const namePart = match[2].split("[")[0].trim()
                        sinks.push({ id: match[1], name: namePart, active })
                    }
                }
            }

            if (sinks.length > 0) {
                const title = new Gtk.Label({ label: "Salida de Audio", css_classes: ["cc-section-title"], halign: Gtk.Align.START })
                box.append(title)

                sinks.forEach(s => {
                    const row = new Gtk.Box({ spacing: 12, css_classes: ["cc-sink-item", s.active ? "active" : ""] })
                    const btn = new Gtk.Button({ child: row, hexpand: true })

                    const icon = new Gtk.Image({
                        icon_name: s.name.toLowerCase().includes("hdmi") ? "video-display-symbolic" : "audio-speakers-symbolic",
                        pixel_size: 16
                    })
                    const label = new Gtk.Label({ label: s.name, ellipsize: 3, hexpand: true, halign: Gtk.Align.START })
                    const check = new Gtk.Image({ icon_name: "object-select-symbolic", visible: s.active })

                    row.append(icon)
                    row.append(label)
                    row.append(check)

                    btn.connect("clicked", () => {
                        execAsync(`wpctl set-default ${s.id}`).then(() => sync())
                    })
                    box.append(btn)
                })
            }
        }).catch(err => console.error("[CC] AudioSinks error:", err))
    }

    sync()
    return box
}

function Sliders() {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-sliders"]
    })

    // V330: Audio Sinks Switcher
    box.append(AudioSinks())

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

    // Volume Placeholder
    const volSlider = createSlider("audio-volume-high-symbolic", "vol", 50, (v) => execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v / 100}`))
    volRow.append(volSlider)

    // Volume Init 🔊 (update placeholder)
    execAsync("wpctl get-volume @DEFAULT_AUDIO_SINK@").then(out => {
        const match = out.match(/Volume: (\d+\.\d+)/)
        const val = match ? Math.floor(parseFloat(match[1]) * 100) : 50
        const scale = volSlider.get_last_child() as Gtk.Scale
        if (scale) scale.set_value(val)
    }).catch(() => { })

    // Brightness Init ☀️ (check hardware first)
    execAsync("which brightnessctl").then(() => {
        const brtSlider = createSlider("display-brightness-symbolic", "brt", 50, (v) => execAsync(`brightnessctl s ${Math.floor(v)}%`))
        brtRow.append(brtSlider)
        execAsync("brightnessctl g").then(curr => {
            execAsync("brightnessctl m").then(max => {
                const val = Math.floor((parseInt(curr) / parseInt(max)) * 100)
                const scale = brtSlider.get_last_child() as Gtk.Scale
                if (scale) scale.set_value(val)
            })
        }).catch(() => { brtRow.set_visible(false) })
    }).catch(() => {
        brtRow.set_visible(false)
    })

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

        const p = GLib.PRIORITY_DEFAULT_IDLE || 200
        // Phase 1: Atomic Sliders (Fast)
        GLib.idle_add(p, () => {
            try { box.append(Sliders()) } catch (e) { console.error("[CC] Sliders init failed:", e) }
            return GLib.SOURCE_REMOVE
        })

        // Phase 2: Atomic Network/BT (Can be slow)
        GLib.idle_add(p, () => {
            try { box.append(GridControls()) } catch (e) { console.error("[CC] Grid init failed:", e) }
            return GLib.SOURCE_REMOVE
        })

        // Phase 3: Media (Medium)
        const priority = GLib.PRIORITY_DEFAULT_IDLE || 200
        GLib.idle_add(priority, () => {
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

    // V135: Initialize LayerShell first
    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) { }

    if (layerInit) {
        try {
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
    }

    // @ts-ignore
    win.toggle = () => {
        ensureInit()
        win.set_visible(!win.get_visible())
        if (win.get_visible()) win.present()
    }

    return win
}
