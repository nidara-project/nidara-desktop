import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"

function NotificationItem(n: any) {
    const box = new Gtk.Box({
        css_classes: ["nc-notif-item"],
        spacing: 12,
        valign: Gtk.Align.START
    })

    const iconBox = new Gtk.Box({
        css_classes: ["nc-notif-icon-box"],
        valign: Gtk.Align.START
    })
    const icon = new Gtk.Image({
        icon_name: n.app_icon || n.desktop_entry || "dialog-information-symbolic",
        pixel_size: 24
    })
    iconBox.append(icon)

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        valign: Gtk.Align.START
    })
    const title = new Gtk.Label({
        label: n.summary,
        css_classes: ["nc-notif-title"],
        halign: Gtk.Align.START,
        ellipsize: 3,
        lines: 1
    })
    const body = new Gtk.Label({
        label: n.body,
        css_classes: ["nc-notif-body"],
        halign: Gtk.Align.START,
        wrap: true,
        lines: 2,
        ellipsize: 3,
        max_width_chars: 42
    })

    content.append(title)
    content.append(body)

    const closeBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "window-close-symbolic" }),
        css_classes: ["nc-notif-close"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER
    })
    closeBtn.connect("clicked", () => n.dismiss())

    box.append(iconBox)
    box.append(content)
    box.append(closeBtn)

    return box
}

function Notifications() {
    const notifd = AstalNotifd.get_default()
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["cc-notifs-section"]
    })

    const header = new Gtk.Box({ css_classes: ["cc-notifs-header"], spacing: 12 })
    header.append(new Gtk.Label({ label: "Notificaciones", css_classes: ["cc-section-title"], hexpand: true, halign: Gtk.Align.START }))

    const clearBtn = new Gtk.Button({ label: "Borrar", css_classes: ["cc-clear-btn"] })
    header.append(clearBtn)

    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })

    const sync = () => {
        let child = list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            list.remove(child)
            child = next
        }

        if (!notifd) return
        const all = [...notifd.notifications].sort((a, b) => b.id - a.id)
        all.forEach(n => {
            try { list.append(NotificationItem(n)) } catch (e) { }
        })

        if (all.length === 0) {
            const empty = new Gtk.Label({ label: "No hay notificaciones", css_classes: ["cc-notifs-empty"] })
            list.append(empty)
        }
    }

    clearBtn.connect("clicked", () => {
        try { notifd?.notifications.forEach(n => n?.dismiss()) } catch (e) { }
    })
    if (notifd) {
        notifd.connect("notified", sync)
        notifd.connect("resolved", sync)
    }

    box.append(header)
    box.append(list)
    sync()
    return box
}

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
    let network: any = null;
    let bluetooth: any = null;

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

        return btn
    }

    const update = () => {
        let child = grid.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            grid.remove(child)
            child = next
        }

        let col = 0
        let row = 0

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

function Sliders() {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-sliders"]
    })

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

    const volSlider = createSlider("audio-volume-high-symbolic", "vol", 50, (v) => execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v / 100}`))
    box.append(volSlider)

    execAsync("wpctl get-volume @DEFAULT_AUDIO_SINK@").then(out => {
        const match = out.match(/Volume: (\d+\.\d+)/)
        const val = match ? Math.floor(parseFloat(match[1]) * 100) : 50
        const scale = volSlider.get_last_child() as Gtk.Scale
        if (scale) scale.set_value(val)
    }).catch(() => { })

    execAsync("which brightnessctl").then(() => {
        const brtSlider = createSlider("display-brightness-symbolic", "brt", 50, (v) => execAsync(`brightnessctl s ${Math.floor(v)}%`))
        box.append(brtSlider)
        execAsync("brightnessctl g").then(curr => {
            execAsync("brightnessctl m").then(max => {
                const val = Math.floor((parseInt(curr) / parseInt(max)) * 100)
                const scale = brtSlider.get_last_child() as Gtk.Scale
                if (scale) scale.set_value(val)
            })
        }).catch(() => { })
    }).catch(() => { })

    return box
}

export default function ControlCenter(gdkmonitor: Gdk.Monitor) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["control-center"]
    })

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        child: box,
        css_classes: ["cc-scroll"]
    })

    let initialized = false
    const ensureInit = () => {
        if (initialized) return

        try { box.append(GridControls()) } catch (e) { console.error("[CC] GridControls failed:", e) }
        try { box.append(Sliders()) } catch (e) { console.error("[CC] Sliders failed:", e) }
        try { box.append(Media()) } catch (e) { console.error("[CC] Media failed:", e) }
        try {
            box.append(new Gtk.Separator({ css_classes: ["cc-separator"] }))
            box.append(Notifications())
        } catch (e) { console.error("[CC] Notifications failed:", e) }

        initialized = true
    }

    const win = new Gtk.Window({
        name: "crystal-control-center",
        application: app,
        css_classes: ["control-center-win"],
        child: scroll,
        default_width: 480,
        default_height: 800,
        visible: false
    })

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
        console.log("[CC] Internal toggle called")
        ensureInit()
        win.set_visible(!win.get_visible())
        if (win.get_visible()) win.present()
    }

    return win
}
