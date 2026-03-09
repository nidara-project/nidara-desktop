import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import AstalWp from "gi://AstalWp"
import AstalBattery from "gi://AstalBattery"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import GObject from "gi://GObject"
// @ts-ignore
import Pango from "gi://Pango?version=1.0"
import appService from "../../core/AppService"
import Theme from "../../core/ThemeManager"
import { ACCENT_PALETTE } from "../../core/FluidCrystal"
import { drawSquircle, createSquirclePath } from "../common/DrawingUtils"
import SquircleContainer from "../common/SquircleContainer"

export default function ControlCenter(gdkmonitor: Gdk.Monitor) {
    const notifd = AstalNotifd.get_default()
    const mpris = AstalMpris.get_default()
    const network = AstalNetwork.get_default()
    const bluetooth = AstalBluetooth.get_default()
    const battery = AstalBattery.get_default()

    const win = new Gtk.Window({
        name: "crystal-control-center",
        application: app,
        css_classes: ["control-center-win", "background"],
        visible: false,
        // @ts-ignore
        focus_visible: false
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "control-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
        // @ts-ignore
        win.gdkmonitor = gdkmonitor
    } catch (e) { }

    const keyController = new Gtk.EventControllerKey()
    keyController.connect("key-pressed", (_, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            win.set_visible(false)
            return true
        }
        return false
    })
    win.add_controller(keyController)

    const overlay = new Gtk.Overlay({
        css_classes: ["cc-window-root"],
        hexpand: true,
        vexpand: true
    })

    overlay.add_overlay(new Gtk.Box({
        width_request: 1,
        height_request: 1,
        can_target: false,
        opacity: 0,
        css_classes: ["sacrificial-widget"]
    }))

    win.set_child(overlay)

    const catcher = new Gtk.Box({
        hexpand: true,
        vexpand: true,
        can_focus: false
    })
    overlay.set_child(catcher)

    const clickGesture = new Gtk.GestureClick()
    clickGesture.connect("pressed", () => {
        win.visible = false
    })
    catcher.add_controller(clickGesture)

    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["control-center"],
        vexpand: true,
        hexpand: true,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL
    })

    const ccContainer = new Gtk.Box({
        css_classes: ["cc-islands-container"],
        hexpand: false,
        vexpand: true,
        width_request: 380 // 📐 Adjusted width
    })
    ccContainer.append(contentBox)

    ccContainer.halign = Gtk.Align.END
    ccContainer.valign = Gtk.Align.FILL
    ccContainer.margin_top = 8
    ccContainer.margin_end = 8
    ccContainer.margin_bottom = 8
    ccContainer.margin_start = 8

    overlay.add_overlay(ccContainer)

    const mainBox = contentBox

    /* --- HELPERS --- */
    const createToggle = (iconName: string, title: string, sub: string, active: boolean, onClick: () => void) => {
        let isActive = active
        let isHovered = false

        const container = new Gtk.Box({
            hexpand: true,
            vexpand: false,
            css_classes: ["cc-toggle-container"],
            height_request: 64
        })

        const da = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: false
        })
        da.set_draw_func((_, cr, w, h) => {
            const accentHex = ACCENT_PALETTE[Theme.accentColor].color
            const accent = {
                r: parseInt(accentHex.slice(1, 3), 16) / 255,
                g: parseInt(accentHex.slice(3, 5), 16) / 255,
                b: parseInt(accentHex.slice(5, 7), 16) / 255
            }
            const neutral = { r: 1, g: 1, b: 1 }

            cr.setSourceRGBA(0, 0, 0, 0); cr.paint()

            const radius = 16
            const border = { r: 1, g: 1, b: 1, a: 0.08 }

            if (isActive) {
                drawSquircle(cr, w, h, undefined, 0.2, false, accent, radius, false, border)
            } else {
                if (isHovered) drawSquircle(cr, w, h, undefined, 0.08, false, neutral, radius, false, border)
            }
        })

        const contentOverlay = new Gtk.Overlay()
        contentOverlay.set_child(da)

        const box = new Gtk.Box({
            spacing: 12,
            css_classes: ["cc-toggle-content"],
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            margin_start: 12
        })

        const iconBox = new Gtk.Box({
            css_classes: ["cc-toggle-icon-box"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            width_request: 38, height_request: 38
        })
        const icon = new Gtk.Image({
            icon_name: iconName, pixel_size: 18,
            css_classes: ["cc-toggle-icon"],
            hexpand: true, vexpand: true
        })
        iconBox.append(icon)

        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
        const l = new Gtk.Label({ label: title, css_classes: ["cc-toggle-label"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 18 })
        const sl = new Gtk.Label({ label: sub, css_classes: ["cc-toggle-sublabel"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 18 })
        text.append(l); text.append(sl)

        box.append(iconBox); box.append(text)
        contentOverlay.add_overlay(box)
        container.append(contentOverlay)

        const click = new Gtk.GestureClick()
        click.connect("pressed", () => onClick())
        container.add_controller(click)

        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => { isHovered = true; da.queue_draw() })
        motion.connect("leave", () => { isHovered = false; da.queue_draw() })
        container.add_controller(motion)

        const setActive = (state: boolean) => {
            isActive = state
            da.queue_draw()
            if (state) { l.add_css_class("active-text"); icon.add_css_class("active-icon") }
            else { l.remove_css_class("active-text"); icon.remove_css_class("active-icon") }
        }
            ; (container as any).setActive = setActive

        if (isActive) { l.add_css_class("active-text"); icon.add_css_class("active-icon") }

        return { btn: container, icon, label: l, subLabel: sl, iconBox, setActive }
    }

    /* --- ISLAND 1: Connectivity & Network --- */
    const connectivityContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["cc-connectivity-content"],
        margin_top: 16, margin_start: 16, margin_end: 16, margin_bottom: 16
    })

    const connectivityIsland = SquircleContainer({
        child: connectivityContent,
        radius: 32,
        n: 4.5,
        css_classes: ["cc-island", "cc-connectivity-island"],
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
    })
    mainBox.append(connectivityIsland)

    // Battery Row (Conditional 🔋)
    const statusRow = new Gtk.Box({ spacing: 12, margin_bottom: 4, css_classes: ["cc-status-row"] })
    const battIcon = new Gtk.Image({ icon_name: "battery-level-100-charged-symbolic", pixel_size: 14 })
    const battLabel = new Gtk.Label({ label: "100%", css_classes: ["cc-status-label"] })
    statusRow.append(battIcon); statusRow.append(battLabel)
    connectivityContent.append(statusRow)

    if (battery && battery.is_present) {
        statusRow.visible = true
        const updateBatt = () => {
            battIcon.icon_name = battery.battery_icon_name
            battLabel.label = `${Math.floor(battery.percentage * 100)}%`
        }
        battery.connect("notify::percentage", updateBatt)
        battery.connect("notify::battery-icon-name", updateBatt)
        updateBatt()
    } else {
        statusRow.visible = false
    }

    const grid = new Gtk.Grid({
        column_spacing: 12,
        row_spacing: 12,
        css_classes: ["cc-grid"],
        column_homogeneous: true,
        hexpand: true,
        halign: Gtk.Align.FILL
    })
    connectivityContent.append(grid)

    // WI-FI Toggle
    const wifiToggle = createToggle("network-wireless-offline-symbolic", "Wi-Fi", "...", false, () => {
        if (network?.wifi) network.wifi.enabled = !network.wifi.enabled
    })
    const updateNetwork = () => {
        let icon = "network-wireless-offline-symbolic"
        let label = "Network"
        let sub = "Desconectado"
        let active = false

        if (network?.primary === AstalNetwork.Primary.WIRED) {
            icon = network.wired?.icon_name || "network-wired-symbolic"
            label = "Ethernet"
            sub = "Conectado"
            active = true
        } else if (network?.wifi) {
            icon = network.wifi.icon_name
            label = "Wi-Fi"
            sub = network.wifi.ssid || "Desconectado"
            active = network.wifi.enabled
        }

        wifiToggle.icon.icon_name = icon
        wifiToggle.label.label = label
        wifiToggle.subLabel.label = sub
        wifiToggle.setActive(active)
    }
    grid.attach(wifiToggle.btn, 0, 0, 1, 1)
    if (network) network.connect("notify::primary", updateNetwork)
    if (network?.wifi) {
        network.wifi.connect("notify::enabled", updateNetwork)
        network.wifi.connect("notify::ssid", updateNetwork)
    }
    updateNetwork()

    // BLUETOOTH Toggle
    const btToggle = createToggle("bluetooth-disabled-symbolic", "Bluetooth", "...", false, () => {
        if (bluetooth) bluetooth.is_powered = !bluetooth.is_powered
    })
    const updateBT = () => {
        if (!bluetooth) return
        const powered = bluetooth.is_powered
        btToggle.icon.icon_name = powered ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic"
        btToggle.subLabel.label = powered ? "Encendido" : "Apagado"
        btToggle.setActive(powered)
    }
    grid.attach(btToggle.btn, 1, 0, 1, 1)
    if (bluetooth) bluetooth.connect("notify::is-powered", updateBT)
    updateBT()

    // DND Toggle
    const dndToggle = createToggle("notifications-symbolic", "No molestar", "...", false, () => {
        if (notifd) notifd.dont_disturb = !notifd.dont_disturb
    })
    const updateDND = () => {
        if (!notifd) return
        const state = notifd.dont_disturb
        dndToggle.icon.icon_name = state ? "notifications-disabled-symbolic" : "notifications-symbolic"
        dndToggle.subLabel.label = state ? "Activado" : "Desactivado"
        dndToggle.setActive(state)
    }
    grid.attach(dndToggle.btn, 0, 1, 1, 1)
    if (notifd) notifd.connect("notify::dont-disturb", updateDND)
    updateDND()

    // POWER Toggle
    const pwrToggle = createToggle("system-shutdown-symbolic", "Sesión", "Power Menu", false, () => {
        (app as any).DistroIA?.togglePower();
        (app as any).DistroIA?.toggleCC();
    })
    grid.attach(pwrToggle.btn, 1, 1, 1, 1)

    /* --- ISLAND 2: Sliders --- */
    const slidersContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-sliders-content"],
        margin_top: 16, margin_start: 16, margin_end: 16, margin_bottom: 16
    })

    const slidersIsland = SquircleContainer({
        child: slidersContent,
        radius: 32,
        n: 4.5,
        css_classes: ["cc-island", "cc-sliders-island"],
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
    })
    mainBox.append(slidersIsland)

    const volScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 2, page_increment: 10 })
    })

    const brightScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 2, page_increment: 10 })
    })

    const createSlider = (iconName: string, scale: Gtk.Scale, onChanged: (v: number) => void) => {
        scale.set_size_request(-1, 48)
        scale.add_css_class("cc-pill-slider")

        const icon = new Gtk.Image({
            icon_name: iconName,
            pixel_size: 16,
            css_classes: ["cc-pill-slider-icon"],
            can_target: false,
            halign: Gtk.Align.START, valign: Gtk.Align.CENTER,
            margin_start: 16
        })

        const sliderOverlay = new Gtk.Overlay({ css_classes: ["cc-slider-overlay"], hexpand: true })
        sliderOverlay.set_child(scale)
        sliderOverlay.add_overlay(icon)

        // Command implementation
        scale.connect("value-changed", () => {
            onChanged(scale.get_value() / 100)
        })

        // Scroll implementation 🖱️
        const scroll = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
        scroll.connect("scroll", (_, __, dy) => {
            const cur = scale.get_value()
            const step = 5
            const next = dy < 0 ? Math.min(100, cur + step) : Math.max(0, cur - step)
            scale.set_value(next)
            return true
        })
        sliderOverlay.add_controller(scroll)

        return sliderOverlay
    }

    const volSlider = createSlider("audio-volume-high-symbolic", volScale, (v) => {
        execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v.toFixed(2)}`).catch(() => { })
    })

    const brightSlider = createSlider("display-brightness-symbolic", brightScale, (v) => {
        execAsync(`brightnessctl s ${Math.floor(v * 100)}%`).catch(() => { })
    })

    slidersContent.append(volSlider)

    // Check for backlight device 💡
    execAsync("brightnessctl -l").then(out => {
        if (out.includes("backlight")) {
            slidersContent.append(brightSlider)
            brightSlider.visible = true
        } else {
            brightSlider.visible = false
        }
    }).catch(() => {
        brightSlider.visible = false
    })

    const syncLevels = () => {
        // Force volume sync via wpctl (Source of Truth)
        execAsync("wpctl get-volume @DEFAULT_AUDIO_SINK@").then(out => {
            const match = out.match(/Volume: (\d+\.\d+)/)
            if (match) {
                const vol = parseFloat(match[1]) * 100
                volScale.set_value(vol)
            }
        }).catch(() => { })

        // Force brightness sync
        execAsync("brightnessctl g").then(curr => {
            execAsync("brightnessctl m").then(max => {
                const val = (parseInt(curr) / parseInt(max)) * 100
                brightScale.set_value(val)
            })
        }).catch(() => { })
    }

    /* --- ISLAND 3: Media --- */
    const mediaContainer = new Gtk.Box({
        css_classes: ["cc-media"],
        orientation: Gtk.Orientation.VERTICAL
    })
    mainBox.append(mediaContainer)

    let lastPlayer: AstalMpris.Player | null = null
    let playerSignals: number[] = []

    const updateMedia = () => {
        const players = mpris.get_players()
        if (players.length === 0) {
            mediaContainer.get_first_child()?.unparent()
            if (lastPlayer) { playerSignals.forEach(id => lastPlayer?.disconnect(id)); playerSignals = []; lastPlayer = null }
            return
        }

        const player = players[0]
        if (lastPlayer !== player) {
            if (lastPlayer) { playerSignals.forEach(id => lastPlayer?.disconnect(id)); playerSignals = [] }
            lastPlayer = player
            playerSignals.push(player.connect("notify::playback-status", updateMedia))
            playerSignals.push(player.connect("notify::title", updateMedia))
            playerSignals.push(player.connect("notify::artist", updateMedia))
            playerSignals.push(player.connect("notify::cover-art", updateMedia))
        }

        mediaContainer.get_first_child()?.unparent()

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            css_classes: ["cc-media-content"],
            margin_top: 16, margin_start: 16, margin_end: 16, margin_bottom: 16
        })

        const topRow = new Gtk.Box({ spacing: 16, halign: Gtk.Align.CENTER })
        const art = new Gtk.Box({ css_classes: ["cc-media-art"], valign: Gtk.Align.CENTER })
        const artDa = new Gtk.DrawingArea({ css_classes: ["cc-media-art-da"], valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })

        let artPixbuf: any = null
        if (player.cover_art && GLib.file_test(player.cover_art, GLib.FileTest.EXISTS)) {
            try {
                artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(player.cover_art, 80, 80, true)
                if (artPixbuf) artDa.set_size_request(artPixbuf.width, artPixbuf.height)
            } catch (e) { }
        } else {
            artDa.set_size_request(80, 80)
        }

        artDa.set_draw_func((_, cr, w, h) => {
            if (artPixbuf) {
                cr.save()
                createSquirclePath(cr, 0, 0, w, h, 16, 4.5)
                cr.clip()
                Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0)
                cr.paint()
                cr.restore()
            }
        })
        art.append(artDa)

        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER, spacing: 2 })
        info.append(new Gtk.Label({ label: player.title || "Unknown", css_classes: ["cc-media-title"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3 }))
        info.append(new Gtk.Label({ label: player.artist || "Unknown", css_classes: ["cc-media-artist"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3 }))

        topRow.append(art); topRow.append(info)
        content.append(topRow)

        const ctrl = new Gtk.Box({ css_classes: ["cc-media-controls"], spacing: 24, halign: Gtk.Align.CENTER })
        const prev = new Gtk.Button({
            child: new Gtk.Image({ icon_name: "media-skip-backward-symbolic" }),
            css_classes: ["cc-media-btn", "flat"],
            has_frame: false
        })
        prev.connect("clicked", () => player.previous())
        const play = new Gtk.Button({
            child: new Gtk.Image({ icon_name: player.playback_status === AstalMpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic" : "media-playback-start-symbolic" }),
            css_classes: ["cc-media-btn", "flat"],
            has_frame: false
        })
        play.connect("clicked", () => player.play_pause())
        const next = new Gtk.Button({
            child: new Gtk.Image({ icon_name: "media-skip-forward-symbolic" }),
            css_classes: ["cc-media-btn", "flat"],
            has_frame: false
        })
        next.connect("clicked", () => player.next())

        ctrl.append(prev); ctrl.append(play); ctrl.append(next)
        content.append(ctrl)

        const card = SquircleContainer({
            child: content,
            radius: 32,
            n: 4.5,
            css_classes: ["cc-island", "cc-media-card"],
            alpha: 0.15,
            gloss: true,
            borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
        })
        mediaContainer.append(card)
    }
    mpris.connect("notify::players", updateMedia)
    updateMedia()

    // @ts-ignore
    win.toggle = () => {
        win.set_visible(!win.get_visible())
        if (win.get_visible()) {
            win.present()
            win.set_focus(null)
            syncLevels()
        }
    }

    // Initial Sync
    syncLevels()

    return win
}
