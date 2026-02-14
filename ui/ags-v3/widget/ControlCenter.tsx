import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import GObject from "gi://GObject"
// @ts-ignore
import Pango from "gi://Pango?version=1.0"
import appService from "../core/AppService"

export default function ControlCenter(gdkmonitor: Gdk.Monitor) {
    const notifd = AstalNotifd.get_default()
    const mpris = AstalMpris.get_default()
    const network = AstalNetwork.get_default()
    const bluetooth = AstalBluetooth.get_default()

    const win = new Gtk.Window({
        name: "crystal-control-center",
        application: app,
        css_classes: ["control-center-win"],
        visible: false
    })

    try {
        Gtk4LayerShell.init_for_window(win)
        Gtk4LayerShell.set_namespace(win, "control-center")
        Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
        // Set full screen anchor to detect clicks outside the panel
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
        Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
        Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
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

    // Root container covering the whole screen
    const overlay = new Gtk.Overlay({
        css_classes: ["cc-window-root"],
        hexpand: true,
        vexpand: true
    })
    win.set_child(overlay)

    // Transparent background catcher
    const catcher = new Gtk.Box({
        hexpand: true,
        vexpand: true,
        can_focus: false
    })
    overlay.set_child(catcher)

    const clickGesture = new Gtk.GestureClick()
    clickGesture.connect("pressed", () => {
        console.log("[CC] Background click detected, closing...")
        win.visible = false
    })
    catcher.add_controller(clickGesture)

    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["control-center"],
        width_request: 420, // Original Masterpiece 💎
        hexpand: false, // BLOQUEO ESTRUCTURAL: No estirar horizontalmente 🛡️
        halign: Gtk.Align.END,
        valign: Gtk.Align.FILL,
        vexpand: true,
        margin_top: 8,
        margin_end: 8,
        margin_bottom: 0
    })
    overlay.add_overlay(mainBox)

    // Standard buttons and sliders will now correctly receive 
    // events as they are in the overlay layer above the catcher.

    const topSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["cc-fixed-container"]
    })
    mainBox.append(topSection)

    /* --- Grid Controls --- */
    const grid = new Gtk.Grid({ column_spacing: 12, row_spacing: 12, css_classes: ["cc-grid"] })
    topSection.append(grid)

    const createToggle = (iconName: string, title: string, sub: string, active: boolean, onClick: () => void) => {
        const btn = new Gtk.Button({
            css_classes: ["cc-toggle"],
            hexpand: true,
            focusable: false,
            can_focus: false,
            focus_on_click: false
        })
        if (active) btn.add_css_class("active")

        const box = new Gtk.Box({ spacing: 12, css_classes: ["cc-toggle-content"], halign: Gtk.Align.START })
        const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 20, css_classes: ["cc-toggle-icon"] })
        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
        const l = new Gtk.Label({ label: title, css_classes: ["cc-toggle-label"], halign: Gtk.Align.START, focusable: false, can_focus: false })
        const sl = new Gtk.Label({ label: sub, css_classes: ["cc-toggle-sublabel"], halign: Gtk.Align.START, ellipsize: 3, focusable: false, can_focus: false })

        text.append(l); text.append(sl)
        box.append(icon); box.append(text)
        btn.set_child(box)
        btn.connect("clicked", onClick)
        return { btn, icon, label: l, subLabel: sl }
    }

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

        // 🛡️ Flicker Guard: Skip if nothing changed
        if (wifiToggle.icon.icon_name === icon &&
            wifiToggle.label.label === label &&
            wifiToggle.subLabel.label === sub &&
            wifiToggle.btn.has_css_class("active") === active) return

        if (wifiToggle.icon.icon_name !== icon) wifiToggle.icon.icon_name = icon
        if (wifiToggle.label.label !== label) wifiToggle.label.label = label
        if (wifiToggle.subLabel.label !== sub) wifiToggle.subLabel.label = sub

        const hasActive = wifiToggle.btn.has_css_class("active")
        if (active && !hasActive) wifiToggle.btn.add_css_class("active")
        else if (!active && hasActive) wifiToggle.btn.remove_css_class("active")
    }

    wifiToggle.btn.width_request = 180 // Original Restoration 🛡️
    grid.attach(wifiToggle.btn, 0, 0, 1, 1)
    if (network) {
        network.connect("notify::primary", updateNetwork)
        network.wifi?.connect("notify::enabled", updateNetwork)
        network.wifi?.connect("notify::ssid", updateNetwork)
        if (network.wired) network.wired.connect("notify::state", updateNetwork)
    }
    updateNetwork()

    const updateBT = () => {
        const powered = bluetooth?.is_powered || false
        const icon = powered ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic"
        const sub = powered ? "Encendido" : "Apagado"
        const hasActive = btToggle.btn.has_css_class("active")

        if (btToggle.icon.icon_name !== icon) btToggle.icon.icon_name = icon
        if (btToggle.subLabel.label !== sub) btToggle.subLabel.label = sub
        if (powered && !hasActive) btToggle.btn.add_css_class("active")
        else if (!powered && hasActive) btToggle.btn.remove_css_class("active")
    }
    const btToggle = createToggle("bluetooth-disabled-symbolic", "Bluetooth", "...", false, () => {
        if (bluetooth) bluetooth.is_powered = !bluetooth.is_powered
    })
    btToggle.btn.width_request = 180 // Original Restoration 🛡️
    grid.attach(btToggle.btn, 1, 0, 1, 1)
    if (bluetooth) bluetooth.connect("notify::is-powered", updateBT)
    updateBT()

    const updateDND = () => {
        const dnd = notifd?.dont_disturb || false
        const icon = dnd ? "notifications-disabled-symbolic" : "notifications-symbolic"
        const sub = dnd ? "Silencio" : "Normal"
        const hasActive = dndToggle.btn.has_css_class("active")

        if (dndToggle.icon.icon_name !== icon) dndToggle.icon.icon_name = icon
        if (dndToggle.subLabel.label !== sub) dndToggle.subLabel.label = sub
        if (dnd && !hasActive) dndToggle.btn.add_css_class("active")
        else if (!dnd && hasActive) dndToggle.btn.remove_css_class("active")
    }
    const dndToggle = createToggle("notifications-symbolic", "No molestar", "...", false, () => {
        if (notifd) notifd.dont_disturb = !notifd.dont_disturb
    })
    dndToggle.btn.width_request = 180 // Original Restoration 🛡️
    grid.attach(dndToggle.btn, 0, 1, 1, 1)
    if (notifd) notifd.connect("notify::dont-disturb", updateDND)
    updateDND()

    const pwrToggle = createToggle("system-shutdown-symbolic", "Sesión", "Power Menu", false, () => {
        (app as any).DistroIA?.togglePower();
        (app as any).DistroIA?.toggleCC();
    })
    pwrToggle.btn.width_request = 180 // Original Restoration 🛡️
    grid.attach(pwrToggle.btn, 1, 1, 1, 1)

    /* --- Sliders --- */
    const sliders = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, css_classes: ["cc-sliders"] })
    topSection.append(sliders)

    const volScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1, page_increment: 10 })
    })
    volScale.connect("value-changed", () => {
        execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${volScale.get_value() / 100}`).catch(() => { })
    })

    const brightScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        draw_value: false,
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, step_increment: 1, page_increment: 10 })
    })
    brightScale.connect("value-changed", () => {
        // Fallback to brightnessctl if available, else nothing for now
        execAsync(`brightnessctl s ${Math.floor(brightScale.get_value())}%`).catch(() => { })
    })

    const createSlider = (iconName: string, scale: Gtk.Scale) => {
        const row = new Gtk.Box({ spacing: 12, css_classes: ["cc-slider-row"] })
        const icon = new Gtk.Image({ icon_name: iconName, pixel_size: 18, css_classes: ["cc-slider-icon"] })
        row.append(icon)
        row.append(scale)
        return row
    }

    sliders.append(createSlider("audio-volume-high-symbolic", volScale))
    sliders.append(createSlider("display-brightness-symbolic", brightScale))

    const syncLevels = () => {
        execAsync("wpctl get-volume @DEFAULT_AUDIO_SINK@").then(out => {
            const match = out.match(/Volume: (\d+\.\d+)/)
            if (match) volScale.set_value(parseFloat(match[1]) * 100)
        }).catch(() => { })
    }

    /* --- Media --- */
    const mediaContainer = new Gtk.Box({ css_classes: ["cc-media"], orientation: Gtk.Orientation.VERTICAL })
    topSection.append(mediaContainer)

    const updateMedia = () => {
        const players = mpris.get_players()
        if (players.length === 0) {
            mediaContainer.get_first_child()?.unparent()
            return
        }

        const player = players[0]
        const stateKey = `${player.bus_name}-${player.playback_status}-${player.title}`
        if ((mediaContainer as any)._lastState === stateKey) return
        (mediaContainer as any)._lastState = stateKey

        mediaContainer.get_first_child()?.unparent()
        mediaContainer.append(new Gtk.Box({ css_classes: ["cc-separator"], height_request: 1, margin_top: 8, margin_bottom: 8 }))
        const pBox = new Gtk.Box({ css_classes: ["cc-media-player"], spacing: 16 })
        const art = new Gtk.Box({ css_classes: ["cc-media-art"], valign: Gtk.Align.CENTER })
        const img = new Gtk.Image({ pixel_size: 64, css_classes: ["cc-media-art-img"] })
        if (player.cover_art) { img.file = player.cover_art; art.add_css_class("with-cover") }
        else { img.icon_name = "audio-x-generic-symbolic"; img.pixel_size = 32 }
        art.append(img)

        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER })
        info.append(new Gtk.Label({ label: player.title || "Unknown", css_classes: ["cc-media-title"], halign: Gtk.Align.START, ellipsize: 3 }))
        info.append(new Gtk.Label({ label: player.artist || "Unknown", css_classes: ["cc-media-artist"], halign: Gtk.Align.START, ellipsize: 3 }))

        const ctrl = new Gtk.Box({ css_classes: ["cc-media-controls"], spacing: 24, halign: Gtk.Align.CENTER, margin_top: 8 })
        const prev = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-backward-symbolic" }), css_classes: ["cc-media-btn"] })
        prev.connect("clicked", () => player.previous())
        const play = new Gtk.Button({ child: new Gtk.Image({ icon_name: player.playback_status === AstalMpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic" : "media-playback-start-symbolic" }), css_classes: ["cc-media-btn"] })
        play.connect("clicked", () => player.play_pause())
        const next = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-forward-symbolic" }), css_classes: ["cc-media-btn"] })
        next.connect("clicked", () => player.next())

        ctrl.append(prev); ctrl.append(play); ctrl.append(next)
        info.append(ctrl)
        pBox.append(art); pBox.append(info)
        mediaContainer.append(pBox)
    }
    mpris.connect("notify::players", updateMedia)
    updateMedia()

    /* --- Notifications Section --- */
    const notifSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["cc-notifs-section"],
        vexpand: true,
        margin_top: 32 // Calibrated Section Separation 💎
    })
    mainBox.append(notifSection)

    const header = new Gtk.Box({ spacing: 12, css_classes: ["cc-notifs-header"] })
    header.append(new Gtk.Label({ label: "Notificaciones", css_classes: ["cc-section-title"], hexpand: true, halign: Gtk.Align.START }))
    const clear = new Gtk.Button({ label: "Borrar", css_classes: ["cc-clear-btn"] })
    header.append(clear)
    notifSection.append(header)

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        overlay_scrolling: true, // Symmetric Fix 💎
        css_classes: ["cc-scroll"]
    })
    notifSection.append(scroll)

    const notifList = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-notifications-list"],
        margin_bottom: 0,
        halign: Gtk.Align.FILL,
        hexpand: true
    })
    scroll.set_child(notifList)

    const updateNotifs = () => {
        while (notifList.get_first_child()) {
            notifList.get_first_child()?.unparent()
        }

        notifd.notifications.forEach(n => {
            const item = new Gtk.Box({
                css_classes: ["nc-notif-item"],
                spacing: 12,
                halign: Gtk.Align.FILL,
                hexpand: true
            })
            const iconBox = new Gtk.Box({ css_classes: ["nc-notif-icon-box"], valign: Gtk.Align.START })

            const img = new Gtk.Image({ pixel_size: 44, css_classes: ["nc-notif-image"] })

            // Hardened icon logic using AppService
            const getIcon = () => {
                if (n.image) return { file: n.image }
                if (n.gicon) return { gicon: n.gicon }

                // Try to resolve app icon via AppService
                const resolved = appService.getIconName(n.app_icon || n.app_name || "")
                if (resolved) {
                    if (resolved.startsWith("/") || resolved.startsWith("file://")) return { file: resolved.replace("file://", "") }
                    return { iconName: resolved }
                }

                const iconName = n.app_icon || "dialog-information-symbolic"
                return { iconName }
            }

            const res = getIcon()
            if (res.file) img.file = res.file
            else if (res.gicon) img.gicon = res.gicon
            else img.icon_name = res.iconName

            img.pixel_size = (res.file) ? 48 : 38
            iconBox.append(img)

            const bodyBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
            bodyBox.append(new Gtk.Label({ label: n.summary, css_classes: ["nc-notif-title"], halign: Gtk.Align.START, ellipsize: 3 }))
            bodyBox.append(new Gtk.Label({ label: n.body || "", css_classes: ["nc-notif-body"], halign: Gtk.Align.START, wrap: true, lines: 2, ellipsize: 3 }))

            const cls = new Gtk.Button({
                child: new Gtk.Image({ icon_name: "window-close-symbolic" }),
                css_classes: ["nc-notif-close"],
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.END
            })
            cls.connect("clicked", () => {
                console.log(`[CC] Dismissing notif: ${n.id}`)
                n.dismiss()
            })

            item.append(iconBox); item.append(bodyBox); item.append(cls)
            notifList.append(item)
        })

        if (notifd.notifications.length === 0) {
            notifList.append(new Gtk.Label({ label: "No hay notificaciones", css_classes: ["cc-notifs-empty"], halign: Gtk.Align.CENTER, margin_top: 24 }))
        }
    }

    clear.connect("clicked", () => {
        console.log("[CC] Clear All clicked")
        const toDismiss = [...notifd.notifications]
        toDismiss.forEach(n => n.dismiss())
        // Explicitly refresh logic
        updateNotifs()
    })

    notifd.connect("notified", updateNotifs)
    notifd.connect("resolved", updateNotifs)
    updateNotifs()

    // @ts-ignore
    win.toggle = () => {
        console.log("[CC] Toggle called. Vis:", win.get_visible())
        win.set_visible(!win.get_visible())
        if (win.get_visible()) {
            win.present()
            win.set_focus(null) // 🛡️ KILL First-Element-Focus Flicker
            syncLevels()
        }
    }

    return win
}
