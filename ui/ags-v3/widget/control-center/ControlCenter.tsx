import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalMpris from "gi://AstalMpris"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import AstalWp from "gi://AstalWp" // Standard architecture 🏛️
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import GObject from "gi://GObject"
// @ts-ignore
import Pango from "gi://Pango?version=1.0"
import appService from "../../core/AppService"
import { drawSquircle } from "../common/DrawingUtils"
import SquircleContainer from "../common/SquircleContainer"

export default function ControlCenter(gdkmonitor: Gdk.Monitor) {
    const notifd = AstalNotifd.get_default()
    const mpris = AstalMpris.get_default()
    const network = AstalNetwork.get_default()
    const bluetooth = AstalBluetooth.get_default()
    const audio = AstalWp.get_default()?.audio

    const win = new Gtk.Window({
        name: "crystal-control-center",
        application: app,
        css_classes: ["control-center-win"],
        visible: false,
        // @ts-ignore
        focus_visible: false // V305: Force Disable Focus Ring
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

    // Root container covering the whole screen
    const overlay = new Gtk.Overlay({
        css_classes: ["cc-window-root"],
        hexpand: true,
        vexpand: true
    })

    // SACRIFICIAL WIDGET ⚔️ (Global Root)
    // We add a dummy 1x1 transparent box as the first overlay child.
    overlay.add_overlay(new Gtk.Box({
        width_request: 1,
        height_request: 1,
        can_target: false,
        opacity: 0,
        css_classes: ["sacrificial-widget"]
    }))

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

    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16, // Global Spacing between Islands 📏
        css_classes: ["control-center"], // Layout-only container ️
        margin_top: 0,
        margin_start: 0,
        margin_end: 0,
        margin_bottom: 0,
        vexpand: true,
        hexpand: true,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL
    })

    const ccContainer = new Gtk.Box({
        css_classes: ["cc-panel-structure"], // The ONLY source of background/border �
        hexpand: false,
        vexpand: true,
        width_request: 420
    })
    ccContainer.append(contentBox)

    // Layout Properties (moved from Box to Container)
    ccContainer.halign = Gtk.Align.END
    ccContainer.valign = Gtk.Align.FILL
    ccContainer.margin_top = 8
    ccContainer.margin_end = 8 // Restore 8px distance from screen edge 🛡️
    ccContainer.margin_bottom = 8
    ccContainer.margin_start = 8

    overlay.add_overlay(ccContainer)

    // Alias for compatibility with rest of the code that appends to mainBox
    const mainBox = contentBox

    // Standard buttons and sliders will now correctly receive 
    // events as they are in the overlay layer above the catcher.

    const topSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-fixed-container"],
        hexpand: true,
        halign: Gtk.Align.FILL,
        margin_top: 16, // Top Island spacing 📐
        margin_start: 16,
        margin_end: 16
    })

    mainBox.append(topSection)

    /* --- Grid Controls --- */
    const grid = new Gtk.Grid({
        column_spacing: 12, // Keep 12 for touch targets, 8 is too tight for toggles
        row_spacing: 12,
        css_classes: ["cc-grid"],
        column_homogeneous: true, // Force full width alignment (196px per btn) 📏
        hexpand: true,
        halign: Gtk.Align.FILL // Ensure grid stretches to container limits 📏
    })
    topSection.append(grid)

    const createToggle = (iconName: string, title: string, sub: string, active: boolean, onClick: () => void) => {
        let isActive = active
        let isHovered = false

        // Dimensions preserved from original button layout
        const container = new Gtk.Box({
            hexpand: true,
            vexpand: false, // Prevent "Giant Square" expansion 🛡️
            css_classes: ["cc-toggle-container"],
            height_request: 64 // Explicitly restore height 🛡️
        })

        const da = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: false // Ensure drawing area doesn't force expansion either
        })
        da.set_draw_func((_, cr, w, h) => {
            // Apple System Blue: #0A84FF -> R:0.039 G:0.517 B:1.0
            const blue = { r: 0.039, g: 0.517, b: 1.0 }
            // Inactive: Quaternary White (Solid, Low Alpha)
            const neutral = { r: 1, g: 1, b: 1 }

            cr.setSourceRGBA(0, 0, 0, 0); cr.paint()

            const radius = 16 // Nested Radius Rule (24-8=16) 📐
            const border = { r: 1, g: 1, b: 1, a: 0.08 } // Subtle internal border

            if (isActive) {
                drawSquircle(cr, w, h, undefined, 1.0, false, blue, radius, false, border)
            } else {
                // Inactive State: 10% Opacity White (Quaternary)
                if (isHovered) drawSquircle(cr, w, h, undefined, 0.15, false, neutral, radius, false, border)
                else drawSquircle(cr, w, h, undefined, 0.10, false, neutral, radius, false, border)
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
            width_request: 38, height_request: 38 // Preserved Dimensions 🛡️
        })
        const icon = new Gtk.Image({
            icon_name: iconName, pixel_size: 18,
            css_classes: ["cc-toggle-icon"],
            hexpand: true, vexpand: true
        })
        iconBox.append(icon)

        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
        const l = new Gtk.Label({ label: title, css_classes: ["cc-toggle-label"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 28 })
        const sl = new Gtk.Label({ label: sub, css_classes: ["cc-toggle-sublabel"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 28 })
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

        // API Compatibility 🛡️
        const setActive = (state: boolean) => {
            isActive = state
            da.queue_draw()
            if (state) { l.add_css_class("active-text"); icon.add_css_class("active-icon") }
            else { l.remove_css_class("active-text"); icon.remove_css_class("active-icon") }
        }
            ; (container as any).setActive = setActive

        // Initial State
        if (isActive) { l.add_css_class("active-text"); icon.add_css_class("active-icon") }

        // Adapter: Expose setActive directly
        return { btn: container, icon, label: l, subLabel: sl, iconBox, setActive }
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

        wifiToggle.setActive(active);
        (wifiToggle.btn as any)._isActive = active
    }

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

        btToggle.setActive(powered)
    }
    const btToggle = createToggle("bluetooth-disabled-symbolic", "Bluetooth", "...", false, () => {
        if (bluetooth) bluetooth.is_powered = !bluetooth.is_powered
    })
    grid.attach(btToggle.btn, 1, 0, 1, 1)
    if (bluetooth) bluetooth.connect("notify::is-powered", updateBT)
    updateBT()

    // Resilient Icon Logic 🛡️
    const getDNDIcon = () => {
        const dnd = notifd?.dont_disturb || false
        if (dnd) return "notifications-disabled-symbolic" // This seems to work for the user

        // Fallback chain for "Active" state
        const candidates = [
            "notifications-symbolic",
            "preferences-system-notifications-symbolic",
            "alarm-symbolic", // Confirmed existence via find
            "dialog-information-symbolic" // Absolute fallback
        ]

        // Check theme for existence
        const display = Gdk.Display.get_default()
        const theme = Gtk.IconTheme.get_for_display(display!) // GTK4 API

        for (const name of candidates) {
            if (theme.has_icon(name)) return name
        }
        return "dialog-information-symbolic"
    }

    const updateDND = () => {
        const dnd = notifd?.dont_disturb || false
        const icon = getDNDIcon()

        const sub = dnd ? "Silencio" : "Normal"
        const hasActive = dndToggle.btn.has_css_class("active")

        if (dndToggle.icon.icon_name !== icon) dndToggle.icon.icon_name = icon
        if (dndToggle.subLabel.label !== sub) dndToggle.subLabel.label = sub

        dndToggle.setActive(dnd)
    }
    // Restore preferred default, getDNDIcon will fix it anyway
    const dndToggle = createToggle("preferences-system-notifications-symbolic", "No molestar", "...", false, () => {
        if (notifd) {
            notifd.dont_disturb = !notifd.dont_disturb
            updateDND()
        }
    })
    grid.attach(dndToggle.btn, 0, 1, 1, 1)

    if (notifd) notifd.connect("notify::dont-disturb", updateDND)
    updateDND()

    const pwrToggle = createToggle("system-shutdown-symbolic", "Sesión", "Power Menu", false, () => {
        (app as any).DistroIA?.togglePower();
        (app as any).DistroIA?.toggleCC();
    })
    grid.attach(pwrToggle.btn, 1, 1, 1, 1)

    /* --- Sliders --- */
    const slidersContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        css_classes: ["cc-sliders-content"],
        margin_top: 16, // Balanced symmetry 📏
        margin_start: 16,
        margin_end: 16,
        margin_bottom: 16
    })

    const sliders = SquircleContainer({
        child: slidersContent,
        radius: 16, // Nested Radius Rule (24-8=16) 📐
        css_classes: ["cc-sliders-structure"], // Clean Structure Only 🎚️
        color: { r: 0, g: 0, b: 0 },
        alpha: 0.2,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
    })
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
        // V450: BULLETPROOF CAIRO 🛡️
        // Draw EVERYTHING (Plate, Level, Icon) in one context to avoid flickers.
        const da = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: false, // V451: Mandatory for visibility 📏
            height_request: 48,
            can_focus: false,
        })

        // PRE-LOAD ICON (Symbolic)
        let iconPixbuf: any = null
        try {
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
            const info = theme.lookup_icon(iconName, [], 20, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SYMBOLIC)
            if (info) {
                const file = info.get_file()
                if (file) {
                    iconPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(file.get_path(), 20, 20, true)
                }
            }
        } catch (e) { }

        da.set_draw_func((_, cr, w, h) => {
            const r = 24
            const insY = 2
            const insX = 2 // V540: RESTORE ORIGINAL 2PX INSET 🍎
            const x1 = insX
            const y1 = insY
            const w1 = w - insX * 2
            const h1 = h - insY * 2
            const safe_r = Math.min(r, h1 / 2)

            const drawPill = (x: number, y: number, width: number, height: number, radius: number) => {
                cr.newPath()
                cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0)
                cr.lineTo(x + width, y + height - radius)
                cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2)
                cr.lineTo(x + radius, y + height)
                cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI)
                cr.lineTo(x, y + radius)
                cr.arc(x + radius, y + radius, radius, Math.PI, 3 * Math.PI / 2)
                cr.lineTo(x + width - radius, y)
                cr.closePath()
            }

            // 1. Background Plate (Pill 💊)
            cr.save()
            cr.setSourceRGBA(1, 1, 1, 0.1) // 10% White Plate
            drawPill(x1, y1, w1, h1, safe_r)
            cr.fill()
            cr.restore()

            // 2. Level Fill (Smooth Growth 🛡️)
            const value = scale.get_value() / 100
            const fillWidth = w1 * value
            if (fillWidth > 0) {
                cr.save()
                cr.setSourceRGBA(1, 1, 1, 1) // Pure White Fill ⚪

                // CLIP TO MAIN PILL
                drawPill(x1, y1, w1, h1, safe_r)
                cr.clip()

                // DRAW FILL AS DYNAMIC PILL (avoids "pop" at 0%)
                // V570: Radius grows with width until it hits full height
                const curRadius = Math.min(safe_r, fillWidth / 2)
                drawPill(x1, y1, fillWidth, h1, curRadius)
                cr.fill()
                cr.restore()
            }

            // 3. Icon Rendering (Clean Split 🍎)
            if (iconPixbuf) {
                const iconX = 16 // Standardized for 32px Total Alignment (16+16) 📐
                const iconY = (h - 20) / 2
                const invertX = x1 + fillWidth

                const drawIconStencil = (color: { r: number, g: number, b: number, a: number }) => {
                    cr.save()
                    Gdk.cairo_set_source_pixbuf(cr, iconPixbuf, iconX, iconY)
                    let maskPattern = cr.getSource()
                    cr.setSourceRGBA(color.r, color.g, color.b, color.a)
                    cr.mask(maskPattern)
                    cr.restore()
                }

                // A. White State (Only where NOT covered by fill)
                cr.save()
                cr.rectangle(invertX, 0, w - invertX, h)
                cr.clip()
                drawIconStencil({ r: 1, g: 1, b: 1, a: 0.9 }) // Consistent 90% White
                cr.restore()

                // B. Dark State (Only where covered by fill)
                if (invertX > iconX) {
                    cr.save()
                    cr.rectangle(0, 0, invertX, h)
                    cr.clip()
                    drawIconStencil({ r: 0, g: 0, b: 0, a: 0.6 }) // Consistent 60% Black
                    cr.restore()
                }
            }
        })

        // Value Change -> Redraw
        scale.connect("value-changed", () => da.queue_draw())

        const sliderOverlay = new Gtk.Overlay({
            css_classes: ["cc-slider-overlay"],
            hexpand: true
        })

        // V511: SWAP ORDER - Visuals on top! 🛡️
        scale.hexpand = true
        scale.set_size_request(-1, 48)
        scale.add_css_class("cc-slider-scale-input")

        sliderOverlay.set_child(scale) // Base: Input
        sliderOverlay.add_overlay(da) // Overlay: Visuals
        da.can_target = false // Click-thru
        da.hexpand = true

        return sliderOverlay
    }

    slidersContent.append(createSlider("audio-volume-high-symbolic", volScale))
    slidersContent.append(createSlider("display-brightness-symbolic", brightScale))

    const syncLevels = () => {
        execAsync("wpctl get-volume @DEFAULT_AUDIO_SINK@").then(out => {
            const match = out.match(/Volume: (\d+\.\d+)/)
            if (match) volScale.set_value(parseFloat(match[1]) * 100)
        }).catch(() => { })
    }

    /* --- Media --- */
    const mediaContainer = new Gtk.Box({
        css_classes: ["cc-media"],
        orientation: Gtk.Orientation.VERTICAL,
        margin_start: 16, // Standard Island Symmetry 📏
        margin_end: 16
    })
    mainBox.append(mediaContainer) // V580: MEDIA AS INDEPENDENT ISLAND 🏝️

    // Media State Management 🎵
    let lastPlayer: AstalMpris.Player | null = null
    let playerSignals: number[] = []

    const updateMedia = () => {
        const players = mpris.get_players()

        // 1. No players? Cleanup and return.
        if (players.length === 0) {
            mediaContainer.get_first_child()?.unparent()
            if (lastPlayer) {
                playerSignals.forEach(id => lastPlayer?.disconnect(id))
                playerSignals = []
                lastPlayer = null
            }
            return
        }

        const player = players[0]

        // 2. New player detected? Re-bind signals.
        if (lastPlayer !== player) {
            if (lastPlayer) {
                playerSignals.forEach(id => lastPlayer?.disconnect(id))
                playerSignals = []
            }
            lastPlayer = player
            // Bind to critical properties for instant updates ⚡
            playerSignals.push(player.connect("notify::playback-status", updateMedia))
            playerSignals.push(player.connect("notify::title", updateMedia))
            playerSignals.push(player.connect("notify::artist", updateMedia))
            playerSignals.push(player.connect("notify::cover-art", updateMedia))
        }

        const stateKey = `${player.bus_name}-${player.playback_status}-${player.title}-${player.artist}-${player.cover_art}`
        if ((mediaContainer as any)._lastState === stateKey) return
        (mediaContainer as any)._lastState = stateKey

        mediaContainer.get_first_child()?.unparent()

        // Content (Inner Layout)
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 16,
            css_classes: ["cc-media-content"],
            margin_top: 16,
            margin_start: 16,
            margin_end: 16,
            margin_bottom: 16
        })

        const topRow = new Gtk.Box({
            spacing: 16,
            halign: Gtk.Align.CENTER // Center Art + Info unit 🎯
        })
        const art = new Gtk.Box({ css_classes: ["cc-media-art"], valign: Gtk.Align.CENTER })
        // V455: BULLETPROOF MEDIA ART 🛡️
        // Use DrawingArea for image to avoid flickering.
        const artDa = new Gtk.DrawingArea({
            css_classes: ["cc-media-art-da"],
            valign: Gtk.Align.CENTER, // Center vertically in row 🎯
            halign: Gtk.Align.CENTER
        })

        let artPixbuf: any = null
        if (player.cover_art && GLib.file_test(player.cover_art, GLib.FileTest.EXISTS)) {
            try {
                // Scaling: Max 80x80 while preserving aspect ratio 📏
                artPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(player.cover_art, 80, 80, true)
                if (artPixbuf) {
                    artDa.set_size_request(artPixbuf.width, artPixbuf.height)
                }
                art.add_css_class("with-cover")
            } catch (e) { }
        } else {
            // Default size if no art
            artDa.set_size_request(80, 80)
        }

        artDa.set_draw_func((_, cr, w, h) => {
            if (artPixbuf) {
                cr.save()
                // Clip to nested squircle
                const r = 16
                cr.newPath()
                cr.arc(w - r, r, r, -Math.PI / 2, 0)
                cr.arc(w - r, h - r, r, 0, Math.PI / 2)
                cr.arc(r, h - r, r, Math.PI / 2, Math.PI)
                cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2)
                cr.closePath()
                cr.clip()
                Gdk.cairo_set_source_pixbuf(cr, artPixbuf, 0, 0)
                cr.paint()
                cr.restore()
            } else {
                // Fallback icon drawn in Cairo
                cr.save()
                cr.setSourceRGBA(1, 1, 1, 0.1)
                cr.newPath()
                cr.arc(w / 2, h / 2, 16, 0, 2 * Math.PI)
                cr.fill()
                cr.restore()
            }
        })
        art.append(artDa)

        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER, spacing: 2 })
        info.append(new Gtk.Label({ label: player.title || "Unknown", css_classes: ["cc-media-title"], halign: Gtk.Align.START, xalign: 0, max_width_chars: 30, ellipsize: 3 }))
        info.append(new Gtk.Label({ label: player.artist || "Unknown", css_classes: ["cc-media-artist"], halign: Gtk.Align.START, xalign: 0, max_width_chars: 30, ellipsize: 3 }))

        topRow.append(art); topRow.append(info)
        content.append(topRow)

        const ctrl = new Gtk.Box({ css_classes: ["cc-media-controls"], spacing: 32, halign: Gtk.Align.CENTER })
        const prev = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-backward-symbolic" }), css_classes: ["cc-media-btn"] })
        prev.connect("clicked", () => player.previous())
        const play = new Gtk.Button({ child: new Gtk.Image({ icon_name: player.playback_status === AstalMpris.PlaybackStatus.PLAYING ? "media-playback-pause-symbolic" : "media-playback-start-symbolic" }), css_classes: ["cc-media-btn"] })
        play.connect("clicked", () => player.play_pause())
        const next = new Gtk.Button({ child: new Gtk.Image({ icon_name: "media-skip-forward-symbolic" }), css_classes: ["cc-media-btn"] })
        next.connect("clicked", () => player.next())

        ctrl.append(prev); ctrl.append(play); ctrl.append(next)
        content.append(ctrl)

        // Card Container (Squircle)
        const card = SquircleContainer({
            child: content,
            radius: 16, // Standalone 'Island' Card ️
            css_classes: ["cc-media-card"],
            color: { r: 0, g: 0, b: 0 },
            alpha: 0.2, // Darker card background
            borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
        })

        mediaContainer.append(card)
    }
    mpris.connect("notify::players", updateMedia)
    updateMedia()

    /* --- Notifications Section --- */
    /* --- Notifications Section --- */
    const notifSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["cc-notifs-section"],
        vexpand: true,
        hexpand: true,
        halign: Gtk.Align.FILL,
        margin_bottom: 16 // Bottom panel padding
    })
    mainBox.append(notifSection)

    const header = new Gtk.Box({
        spacing: 12,
        css_classes: ["cc-notifs-header"],
        margin_start: 16, // Explicit Island Gutter 📐
        margin_end: 16
    })
    header.append(new Gtk.Label({ label: "Notificaciones", css_classes: ["cc-section-title"], hexpand: true, halign: Gtk.Align.START }))
    const clear = new Gtk.Button({ label: "Borrar", css_classes: ["cc-clear-btn"] })
    header.append(clear)
    notifSection.append(header)

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        overlay_scrolling: true,
        css_classes: ["cc-scroll"],
        margin_end: 0 // NO negative margins anymore! Hits 0px edge 🛡️
    })
    notifSection.append(scroll)

    const notifList = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8, // Standardized Island Gap 🏝️
        css_classes: ["cc-notifications-list"],
        margin_start: 16,
        margin_end: 16, // Symmetry for the internal cards
        margin_bottom: 0,
        halign: Gtk.Align.FILL,
        hexpand: true
    })
    scroll.set_child(notifList)

    // Notification History Management 📜
    const HISTORY_KEY = "notification_history"
    // Simple in-memory history for now (could be persisted to file if needed)
    // We merge active notifications with history

    // We need a way to track which notifications are "active" vs "history"
    // But for the user request: "all notifications... appear through cc"
    // The issue is likely that they auto-dismiss and disappear.

    // We will maintain a local list of "StoredNotifications"
    interface StoredNotification {
        id: number
        app_name: string
        app_icon: string
        summary: string
        body: string
        time: number
        image?: string
    }

    // Use a Ref-like pattern or just a variable since we rebuild UI on update
    // Actually, we can just use a static list at module level or a closure variable if we want it to persist across re-renders of the widget function (which shouldn't happen often)
    // But better to attach it to the app or essentially just rely on notifd ensuring we don't auto-dismiss them?

    // BETTER FIX: prevent auto-dismissal?
    // AstalNotifd doesn't seem to have a "persist" flag.
    // The "NotificationPopups" dismisses them visually, but doesn't call dismiss() on the object unless clicked.
    // BUT the daemon (AGS) might expire them based on "expire_timeout".

    // Let's create a robust history array
    const notifHistory: StoredNotification[] = []

    const updateNotifs = () => {
        // Sync active notifications into history if not already present
        notifd.notifications.forEach(n => {
            if (!notifHistory.some(h => h.id === n.id)) {
                notifHistory.unshift({
                    id: n.id,
                    app_name: n.app_name,
                    app_icon: n.app_icon,
                    summary: n.summary,
                    body: n.body,
                    time: Date.now(),
                    image: n.image
                })
            }
        })

        while (notifList.get_first_child()) {
            notifList.get_first_child()?.unparent()
        }

        if (notifHistory.length === 0) {
            notifList.append(new Gtk.Label({ label: "No hay notificaciones recientes", css_classes: ["cc-notifs-empty"], halign: Gtk.Align.CENTER, margin_top: 24 }))
            return
        }

        notifHistory.forEach(n => {
            const content = new Gtk.Box({
                spacing: 16,
                halign: Gtk.Align.FILL,
                hexpand: true,
                margin_top: 16, // Unified Internal Padding 📐
                margin_start: 16,
                margin_end: 16,
                margin_bottom: 16
            })
            const iconBox = new Gtk.Box({ css_classes: ["nc-notif-icon-box"], valign: Gtk.Align.START })

            // V460: BULLETPROOF NOTIF ICON 🛡️
            const iconDa = new Gtk.DrawingArea({
                width_request: 48,
                height_request: 48,
                css_classes: ["nc-notif-da"]
            })

            // Hardened icon logic using AppService
            const getIcon = () => {
                if (n.image) return { file: n.image }

                const resolved = appService.getIconName(n.app_icon || n.app_name || "")
                if (resolved) {
                    if (resolved.startsWith("/") || resolved.startsWith("file://")) return { file: resolved.replace("file://", "") }
                    return { iconName: resolved }
                }

                const iconName = n.app_icon || "dialog-information-symbolic"
                return { iconName }
            }

            const res = getIcon()
            let iconPixbuf: any = null
            try {
                if (res.file) {
                    iconPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(res.file, 48, 48, true)
                } else if (res.iconName) {
                    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default()!)
                    const info = theme.lookup_icon(res.iconName, [], 32, 1, Gtk.TextDirection.NONE, Gtk.IconLookupFlags.FORCE_SYMBOLIC)
                    if (info) {
                        const file = info.get_file()
                        if (file) iconPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(file.get_path(), 32, 32, true)
                    }
                }
            } catch (e) { }

            iconDa.set_draw_func((_, cr, w, h) => {
                if (iconPixbuf) {
                    cr.save()
                    // If it's a small symbolic icon, center it
                    const iw = iconPixbuf.get_width()
                    const ih = iconPixbuf.get_height()
                    const ix = (w - iw) / 2
                    const iy = (h - ih) / 2

                    Gdk.cairo_set_source_pixbuf(cr, iconPixbuf, ix, iy)
                    cr.paint()
                    cr.restore()
                }
            })
            iconBox.append(iconDa)

            const bodyBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
            const timeAgo = Math.floor((Date.now() - n.time) / 60000)
            const timeStr = timeAgo < 1 ? "Ahora" : `${timeAgo}m`

            const titleBox = new Gtk.Box({ spacing: 8 })
            titleBox.append(new Gtk.Label({
                label: n.summary,
                use_markup: true, // Render bold, italics etc 🎨
                css_classes: ["nc-notif-title"],
                halign: Gtk.Align.START,
                xalign: 0,
                max_width_chars: 25,
                ellipsize: 3
            }))
            titleBox.append(new Gtk.Label({ label: timeStr, css_classes: ["nc-notif-time"], halign: Gtk.Align.END, hexpand: true }))

            bodyBox.append(titleBox)
            bodyBox.append(new Gtk.Label({
                label: n.body || "",
                use_markup: true, // Finalize "Clean" look 🛡️
                css_classes: ["nc-notif-body"],
                halign: Gtk.Align.START,
                xalign: 0,
                wrap: true,
                lines: 2,
                max_width_chars: 35,
                ellipsize: 3
            }))

            const cls = new Gtk.Button({
                child: new Gtk.Image({ icon_name: "window-close-symbolic" }),
                css_classes: ["nc-notif-close"],
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.END
            })
            cls.connect("clicked", () => {
                const idx = notifHistory.indexOf(n)
                if (idx > -1) {
                    notifHistory.splice(idx, 1)
                    // Also try to dismiss from daemon if it exists
                    notifd.notifications.find(an => an.id === n.id)?.dismiss()
                    updateNotifs()
                }
            })

            content.append(iconBox)
            content.append(bodyBox)
            content.append(cls)

            // Wrap in Squircle "Card"
            const item = SquircleContainer({
                child: content,
                radius: 16, // Nested Radius Rule (24-8=16) 📐
                css_classes: ["nc-notif-item"],
                hexpand: true,
                color: { r: 0, g: 0, b: 0 },
                alpha: 0.2, // Darker notification item background
                hoverAlpha: 0.3, // Slightly brighter on hover
                borderColor: { r: 1, g: 1, b: 1, a: 0.05 }
            })

            notifList.append(item)
        })
    }

    clear.connect("clicked", () => {
        // Clear all history
        notifHistory.length = 0
        // Dismiss all active
        notifd.notifications.forEach(n => n.dismiss())
        updateNotifs()
    })

    notifd.connect("notified", updateNotifs)
    // We do NOT listen to "resolved" to remove items, so they stay in history!
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
