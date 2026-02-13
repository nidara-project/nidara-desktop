import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
// @ts-ignore
import Pango from "gi://Pango?version=1.0"

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
        ellipsize: (Pango as any).EllipsizeMode.END,
        lines: 1
    })
    const body = new Gtk.Label({
        label: n.body,
        css_classes: ["nc-notif-body"],
        halign: Gtk.Align.START,
        wrap: true,
        lines: 2,
        ellipsize: (Pango as any).EllipsizeMode.END,
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

    // Sub-widgets (Persistent)
    const artImage = new Gtk.Image({ pixel_size: 54, css_classes: ["cc-media-art-img"] })
    const art = new Gtk.Box({ css_classes: ["cc-media-art"], valign: Gtk.Align.CENTER })
    art.append(artImage)

    const titleLabel = new Gtk.Label({ label: "Title", css_classes: ["cc-media-title"], halign: Gtk.Align.START, ellipsize: (Pango as any).EllipsizeMode.END, max_width_chars: 20 })
    const artistLabel = new Gtk.Label({ label: "Artist", css_classes: ["cc-media-artist"], halign: Gtk.Align.START, ellipsize: (Pango as any).EllipsizeMode.END })
    const prevBtn = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-backward-symbolic" }), css_classes: ["cc-media-btn"], focusable: false, focus_on_click: false })
    const playBtn = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-playback-start-symbolic" }), css_classes: ["cc-media-btn"], focusable: false, focus_on_click: false })
    const nextBtn = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-forward-symbolic" }), css_classes: ["cc-media-btn"], focusable: false, focus_on_click: false })

    const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    info.append(titleLabel)
    info.append(artistLabel)

    const controls = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END })
    controls.append(prevBtn)
    controls.append(playBtn)
    controls.append(nextBtn)

    const playerBox = new Gtk.Box({ spacing: 12, css_classes: ["cc-media-player"] })
    playerBox.append(art)
    playerBox.append(info)
    playerBox.append(controls)
    box.append(playerBox)

    const sync = () => {
        const player = mpris.players.filter(p => p.playback_status !== AstalMpris.PlaybackStatus.STOPPED).slice(0, 1)[0]
        if (!player) {
            if (box.visible) box.set_visible(false)
            return
        }

        if (!box.visible) box.set_visible(true)

        // Strict dirty checking for labels
        if (titleLabel.label !== (player.title || "Unknown Title")) {
            titleLabel.label = player.title || "Unknown Title"
        }
        if (artistLabel.label !== (player.artist || "Unknown Artist")) {
            artistLabel.label = player.artist || "Unknown Artist"
        }

        // Persistent Art update
        if (player.cover_art) {
            if (artImage.file !== player.cover_art) artImage.file = player.cover_art
            if (artImage.pixel_size !== 54) artImage.pixel_size = 54
            art.set_css_classes(["cc-media-art", "with-cover"])
        } else {
            if (artImage.icon_name !== "audio-x-generic-symbolic") artImage.icon_name = "audio-x-generic-symbolic"
            if (artImage.pixel_size !== 32) artImage.pixel_size = 32
            art.set_css_classes(["cc-media-art"])
        }

        // Play/Pause icon update
        const playIcon = playBtn.get_child() as Gtk.Image
        const targetPlayIcon = player.playback_status === AstalMpris.PlaybackStatus.PLAYING
            ? "media-playback-pause-symbolic"
            : "media-playback-start-symbolic"
        if (playIcon && playIcon.icon_name !== targetPlayIcon) {
            playIcon.icon_name = targetPlayIcon
        }

        // Signals & Actions
        // @ts-ignore
        if (player._connected) return
        // @ts-ignore
        player._connected = true
        player.connect("notify::playback-status", sync)
        player.connect("notify::metadata", sync)
        prevBtn.connect("clicked", () => player.previous())
        playBtn.connect("clicked", () => player.play_pause())
        nextBtn.connect("clicked", () => player.next())
    }

    mpris.connect("player-added", sync)
    mpris.connect("player-closed", sync)
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
        css_classes: ["cc-grid"],
        hexpand: true,
        halign: Gtk.Align.FILL
    })

    const createToggle = (iconName: string | null, label: string, sublabel: string, active: boolean, onClick: () => void) => {
        const icon = new Gtk.Image({ icon_name: iconName || "network-wired-symbolic", pixel_size: 20, css_classes: ["cc-toggle-icon"] })
        const l = new Gtk.Label({ label: label, css_classes: ["cc-toggle-label"], halign: Gtk.Align.START })
        const sl = new Gtk.Label({ label: sublabel, css_classes: ["cc-toggle-sublabel"], halign: Gtk.Align.START, ellipsize: (Pango as any).EllipsizeMode.END })

        const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
        textStack.append(l)
        textStack.append(sl)

        const box = new Gtk.Box({
            spacing: 12,
            css_classes: ["cc-toggle-content"]
        })
        box.append(icon)
        box.append(textStack)

        const btn = new Gtk.Button({
            child: box,
            hexpand: true,
            focusable: false,
            focus_on_click: false,
            css_classes: ["cc-toggle", active ? "active" : ""]
        })
        btn.connect("clicked", onClick)

        // Add refs for in-place updates
        // @ts-ignore
        btn._refs = { icon, l, sl }

        return btn
    }

    const updateBtn = (btn: Gtk.Button, iconName: string, label: string, sublabel: string, active: boolean) => {
        // @ts-ignore
        const refs = btn._refs

        // Strict Zero-Churn Property Updates
        if (refs.icon.icon_name !== iconName) refs.icon.icon_name = iconName
        if (refs.l.label !== label) refs.l.label = label
        if (refs.sl.label !== sublabel) refs.sl.label = sublabel

        const classes = ["cc-toggle"]
        if (active) classes.push("active")

        // Only trigger CSS recalculation if classes actually changed
        const currentClasses = btn.get_css_classes()
        if (JSON.stringify(currentClasses) !== JSON.stringify(classes)) {
            btn.set_css_classes(classes)
        }
    }

    // Persistent buttons
    const netBtn = createToggle(null, "Red", "...", false, () => {
        if (network?.wifi) network.wifi.enabled = !network.wifi.enabled
    })
    const btBtn = createToggle(null, "Bluetooth", "...", false, () => {
        if (bluetooth) bluetooth.is_powered = !bluetooth.is_powered
    })
    const pwrBtn = createToggle("system-shutdown-symbolic", "Sesión", "Power Menu", false, () => {
        (app as any).DistroIA?.togglePower();
        (app as any).DistroIA?.toggleCC()
    })

    grid.attach(netBtn, 0, 0, 1, 1)
    grid.attach(btBtn, 1, 0, 1, 1)
    grid.attach(pwrBtn, 0, 1, 1, 1)

    const update = () => {
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
            updateBtn(netBtn, icon, label, sublabel, active)
        }

        if (bluetooth) {
            const active = bluetooth.is_powered
            const label = "Bluetooth"
            const sublabel = active ? (bluetooth.devices.find(d => d.connected)?.name || "Activado") : "Desactivado"
            const icon = active ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic"
            updateBtn(btBtn, icon, label, sublabel, active)
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
    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        css_classes: ["control-center"]
    })

    const fixedBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["cc-fixed-container"],
        margin_start: 24,
        margin_end: 24,
        margin_top: 24,
        margin_bottom: 12
    })

    const scrollBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["cc-notifications-container"],
        margin_start: 24,
        margin_end: 24,
        margin_bottom: 24
    })

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        child: scrollBox,
        css_classes: ["cc-scroll"]
    })

    mainBox.append(fixedBox)
    mainBox.append(scroll)

    let initialized = false
    const ensureInit = () => {
        if (initialized) return

        try { fixedBox.append(GridControls()) } catch (e) { console.error("[CC] GridControls failed:", e) }
        try { fixedBox.append(Sliders()) } catch (e) { console.error("[CC] Sliders failed:", e) }
        try { fixedBox.append(Media()) } catch (e) { console.error("[CC] Media failed:", e) }
        try {
            scrollBox.append(new Gtk.Separator({ css_classes: ["cc-separator"] }))
            scrollBox.append(Notifications())
        } catch (e) { console.error("[CC] Notifications failed:", e) }

        initialized = true
    }

    const win = new Gtk.Window({
        name: "crystal-control-center",
        application: app,
        css_classes: ["control-center-win"],
        child: mainBox,
        default_width: 420,
        default_height: -1,
        visible: false
    })
    win.set_decorated(false)
    // @ts-ignore
    win.app_paintable = true

    // GTK4: Force window transparency via display-level CSS provider (beats theme)
    try {
        const cssProvider = new Gtk.CssProvider()
        cssProvider.load_from_string(`
            window#crystal-control-center,
            window#crystal-control-center.control-center-win {
                background-color: transparent;
                background-image: none;
                background: none;
                border: none;
                box-shadow: none;
            }
            window#crystal-control-center decoration {
                background-color: transparent;
                background: none;
                box-shadow: none;
                border: none;
            }
        `)
        // @ts-ignore — GTK4 display-level provider, highest priority
        const display = Gdk.Display.get_default()
        if (display) {
            Gtk.StyleContext.add_provider_for_display(display, cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)
        }
    } catch (e) {
        console.error("[CC] Display CSS provider failed:", e)
    }

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
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, 48)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.RIGHT, 8)
            Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
            Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.BOTTOM, 10) // Dock exclusive zone (110px) already subtracted
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
