import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Theme from "../../../core/ThemeManager"
import { NidaraButton, NidaraFontButton, makeHSlider } from "../../../../lib/nidara-kit"
import NightLight from "../../../core/NightLightManager"
import Wallpaper, { TRANSITION_LABELS, type TransitionType } from "../../../core/WallpaperManager"
import { getBundledWallpapers } from "../../../../lib/wallpaper"
import { ACCENT_PALETTE, GLASS_RANGE, type AccentKey, type ShellAppearance } from "../../../core/NidaraTheme"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { listGroup, createRow, toggleRow, dropdownRow, sliderRow, pageBox, bindWhileRealized } from "../SettingsHelpers"
import { attachTooltip } from "../../../common/Tooltip"
import { safeDisconnect } from "../../../core/signals"

export default function AppearancePage() {
    const page = pageBox("appearance-page")

    // Live external-sync for everything on this page that ThemeManager owns.
    //
    // 🔑 It PRIMES — `apply(read())` before connecting — and that is the whole point,
    // not a nicety. Every consumer arms it through `bindWhileRealized`, which re-runs
    // on each realize; a hook that only subscribes comes back listening but still
    // showing what it was built with, and this page is built ONCE per Settings window.
    // Measured 2026-08-16 on the version this replaces: `setConfig
    // appearance.shellAppearance dark` moved the bar and the dock while the dropdown
    // two inches away still read "Follow system", for the rest of the session.
    //
    // The writers are real and none of them are this page: `setConfig` (appearance.*
    // is agent-writable), the Control Center's dark-mode widget, and the OTHER
    // Settings window — there is one per monitor, all editing the same ThemeManager.
    const onTheme = <T,>(read: () => T) => (apply: (v: T) => void) => {
        apply(read())
        const id = Theme.connect("changed", () => apply(read()))
        return () => safeDisconnect(Theme, id)
    }

    // 1. General style
    const styleGroup = listGroup(t("settings.appearance.group.base-style"))
    const darkSwitch = new Gtk.Switch({ active: Theme.isDark, valign: Gtk.Align.CENTER })
    let syncingDark = false
    darkSwitch.connect("state-set", (_: any, state: boolean) => {
        if (!syncingDark) {
            syncingDark = true
            Theme.setDarkMode(state).finally(() => {
                syncingDark = false
            })
        }
        return false
    })
    onTheme(() => Theme.isDark)((dark) => {
        if (darkSwitch.get_active() !== dark) {
            syncingDark = true
            darkSwitch.set_active(dark)
            syncingDark = false
        }
    })
    styleGroup.listBox.append(createRow(
        t("settings.appearance.dark-mode"),
        t("settings.appearance.dark-mode.desc"),
        darkSwitch,
    ))

    // Bar + dock appearance, independent of the system mode — pin to dark/light so
    // chrome text stays legible over any wallpaper (light text reads on most; dark
    // text needs a brighter glass, hence the floor + this escape hatch).
    const SHELL_APPEARANCES: ShellAppearance[] = ["system", "dark", "light"]
    const apprLabel = (k: ShellAppearance) => t(`settings.appearance.shell-appearance.${k}`)
    styleGroup.listBox.append(dropdownRow(
        t("settings.appearance.shell-appearance"),
        t("settings.appearance.shell-appearance.desc"),
        apprLabel(Theme.shellAppearance),
        SHELL_APPEARANCES.map(apprLabel),
        (label) => {
            const key = SHELL_APPEARANCES.find(k => apprLabel(k) === label)
            if (key) Theme.setShellAppearance(key)
        },
        onTheme(() => apprLabel(Theme.shellAppearance)),
    ))
    page.append(styleGroup.box)

    // 2. Wallpaper
    const wallGroup = listGroup(t("settings.appearance.group.wallpaper"))

    // Preview
    const preview = new Gtk.Picture({
        width_request: 320,
        height_request: 180,
        content_fit: Gtk.ContentFit.COVER,
        css_classes: ["wallpaper-preview"],
        halign: Gtk.Align.CENTER,
    })
    const updatePreview = (path: string) => {
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return
        try {
            // GdkPixbuf handles GIFs (first frame) and all common formats uniformly.
            // Decode at 2× the preview box, NOT full size — a full wallpaper is ~17 MB
            // decoded and Settings hides (never destroys), so it would stay resident.
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 640, 360, true)
            if (pixbuf) preview.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
        } catch (_) {
            preview.set_filename(path) // fallback
        }
    }
    updatePreview(Wallpaper.current)
    Wallpaper.refreshFromDaemon()

    const previewCenter = new Gtk.CenterBox({
        center_widget: preview,
        hexpand: true,
    })
    const previewRow = new Gtk.ListBoxRow({
        css_classes: ["nidara-row", "wallpaper-preview-row"],
        activatable: false,
        selectable: false,
    })
    previewRow.set_child(previewCenter)
    wallGroup.listBox.append(previewRow)

    // Bundled wallpapers gallery
    const bundled = getBundledWallpapers().filter(p => !p.includes("wallpaper-greeter"))
    if (bundled.length > 0) {
        const thumbBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            css_classes: ["wallpaper-thumbnails-box"],
        })

        const thumbButtons: { path: string; btn: Gtk.Button }[] = []

        const refreshThumbActive = (currentPath: string) => {
            const curBase = currentPath ? currentPath.split("/").pop() : ""
            for (const item of thumbButtons) {
                const itemBase = item.path.split("/").pop()
                if (item.path === currentPath || (curBase && itemBase === curBase)) {
                    item.btn.add_css_class("active")
                } else {
                    item.btn.remove_css_class("active")
                }
            }
        }

        for (const wallPath of bundled) {
            const thumbPic = new Gtk.Picture({
                width_request: 80,
                height_request: 45,
                content_fit: Gtk.ContentFit.COVER,
            })
            try {
                const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(wallPath, 160, 90, true)
                if (pixbuf) thumbPic.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
            } catch (_) {
                thumbPic.set_filename(wallPath)
            }

            const btn = new Gtk.Button({
                css_classes: ["wallpaper-thumb-btn"],
                valign: Gtk.Align.CENTER,
            })
            btn.set_child(thumbPic)
            btn.connect("clicked", () => {
                Wallpaper.setWallpaper(wallPath)
                updatePreview(wallPath)
                refreshThumbActive(wallPath)
            })

            thumbBox.append(btn)
            thumbButtons.push({ path: wallPath, btn })
        }

        refreshThumbActive(Wallpaper.current)
        Wallpaper.connect("changed", () => refreshThumbActive(Wallpaper.current))

        const centerBox = new Gtk.CenterBox({
            center_widget: thumbBox,
            hexpand: true,
        })
        const galleryRow = new Gtk.ListBoxRow({
            css_classes: ["nidara-row", "wallpaper-gallery-row"],
            activatable: false,
            selectable: false,
        })
        galleryRow.set_child(centerBox)
        wallGroup.listBox.append(galleryRow)
    }

    // Transition selector
    const transitions = Object.keys(TRANSITION_LABELS) as TransitionType[]
    const transLabels = transitions.map(k => TRANSITION_LABELS[k])
    const transRow = dropdownRow(
        t("settings.appearance.transition"),
        t("settings.appearance.transition.desc"),
        TRANSITION_LABELS[Wallpaper.transition],
        transLabels,
        (label) => {
            const key = transitions.find(k => TRANSITION_LABELS[k] === label)
            if (key) Wallpaper.previewTransition(key)
        },
    )
    wallGroup.listBox.append(transRow)

    // File picker row
    const changeBtn = NidaraButton({
        label: t("settings.appearance.browse"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    changeBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: t("settings.appearance.dialog.wallpaper"),
            modal: true,
        })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/gif")
        filter.add_mime_type("image/webp")
        filter.add_mime_type("image/avif")
        filter.set_name(t("settings.appearance.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)

        dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()))

        // Parent the dialog to the Settings window so it opens modal/centered over
        // it (like the font picker) instead of as an unparented, tiled toplevel.
        dialog.open(changeBtn.get_root() as Gtk.Window, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const path = file?.get_path()
                if (path) {
                    Wallpaper.setWallpaper(path)
                    updatePreview(path)
                }
            } catch (_) { /* user cancelled */ }
        })
    })
    wallGroup.listBox.append(createRow(
        t("settings.appearance.image"),
        t("settings.appearance.image.desc"),
        changeBtn,
    ))

    Wallpaper.connect("changed", () => updatePreview(Wallpaper.current))
    page.append(wallGroup.box)

    // 3. Theme — accent + glass opacity
    const fcGroup = listGroup(t("settings.appearance.group.theme"))

    // Accent Color Picker
    const accentPicker = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
    const accentButtons: Record<string, Gtk.Button> = {}

    Object.keys(ACCENT_PALETTE).forEach(key => {
        const { name } = ACCENT_PALETTE[key as AccentKey]
        const btn = new Gtk.Button({
            css_classes: [`accent-${key}`, "accent-circle-btn"],
            width_request: 28,
            height_request: 28,
        })
        attachTooltip(btn, name, { chrome: false })
        if (Theme.accentColor === key) btn.add_css_class("selected")
        btn.connect("clicked", () => Theme.setAccentColor(key as AccentKey))
        accentPicker.append(btn)
        accentButtons[key] = btn
    })

    fcGroup.listBox.append(createRow(t("settings.appearance.accent"), t("settings.appearance.accent.desc"), accentPicker))

    // Opacity model: ONE master "Glass" slider governs bar + overlays + dock + window
    // together; an "Advanced" disclosure (below) breaks them apart. All are plain
    // opacities (higher = more opaque) over ONE `GLASS_RANGE`, imported rather than
    // retyped — the bounds used to be five literals here plus a sixth in
    // `clampOpacity`, which is five chances to offer a value the clamp refuses.
    //
    // ⚠️ This range used to be [0.05, 0.80] and was documented as "WYSIWYG — no
    // floor". The floor is now 0.24 and that is not a reversal of the WYSIWYG idea:
    // 5% glass was never 5% of anything (the compositor was adding 20% of body
    // under it), so the old bottom of the range was the honest 24% all along. The
    // reasoning, the numbers and what a floor does NOT buy you are on GLASS_RANGE.
    const OPACITY_OPTS = { pct: true, icons: [Icons.minus, Icons.plus] as [Gio.FileIcon, Gio.FileIcon] }
    // Live external-sync so the master and the advanced sliders stay consistent when
    // either changes the underlying value (guarded against the cb→set→changed→cb loop
    // by makeSlider, which ignores onExtChange while dragging). safeDisconnect: see #12.
    //
    // ⚠️ The four advanced sliders live inside a Revealer that starts CLOSED, so they
    // are unmapped — and therefore unrealized — until it is opened. Their subscription
    // is armed on realize, i.e. on the way in: with a hook that did not prime, dragging
    // the master while "Advanced" was collapsed and then opening it showed four sliders
    // still at the value they were built with, contradicting the master right above
    // them. `onTheme` primes, so opening the disclosure re-reads.
    // The master governs the SAME four surfaces it writes (setGlassOpacity), so it must
    // read all four — proxying one axis let *only* the overlay slider move it, and a mean
    // is a number nobody set that also implies the surfaces are uniform when they aren't.
    // Instead it's an INDETERMINATE control (Figma "Mixed" / macOS dash): when the four
    // agree it shows that %, when they diverge it reads "—" and mutes, and dragging it
    // re-unifies them. Built inline (not sliderRow) for that custom, mixed-aware label.
    const glassSurfaces = () => [Theme.barOpacity, Theme.overlayOpacity, Theme.dockOpacity, Theme.windowOpacity]
    const glassUniform = () => { const s = glassSurfaces(); return s.every(v => Math.abs(v - s[0]) < 0.005) }
    const glassRepr = () => Math.max(...glassSurfaces())   // thumb at the peak while mixed

    const masterValue = new Gtk.Label({ css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const masterSlider = makeHSlider({
        min: GLASS_RANGE.min, max: GLASS_RANGE.max, value: glassRepr(),
        onChange: (v) => Theme.setGlassOpacity(v),
        onValueChanged: (v) => { masterValue.label = `${Math.round(v * 100)}%` }, // drag unifies → show %
        onExtChange: onTheme(glassRepr),
        debounce: 32,
        width_request: 140,
    })
    // Runs AFTER makeSlider's own %-label sync (connected earlier, during construction),
    // so the "—" / mute wins whenever the surfaces disagree.
    const syncMaster = () => {
        const uni = glassUniform()
        masterValue.label = uni ? `${Math.round(glassRepr() * 100)}%` : "—"
        masterSlider.opacity = uni ? 1 : 0.55
    }
    bindWhileRealized(masterSlider, () => {
        syncMaster()
        const masterSyncId = Theme.connect("changed", syncMaster)
        return () => safeDisconnect(Theme, masterSyncId)
    })

    const masterBox = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER, hexpand: false })
    const mkGlassEnd = (icon: Gio.FileIcon) => new Gtk.Image({ gicon: icon, pixel_size: 16, opacity: 0.5, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER })
    masterBox.append(mkGlassEnd(Icons.minus))
    masterBox.append(masterSlider)
    masterBox.append(mkGlassEnd(Icons.plus))
    masterBox.append(masterValue)
    fcGroup.listBox.append(createRow(t("settings.appearance.glass"), t("settings.appearance.glass.desc"), masterBox))

    // Advanced — per-surface glass. It belongs INSIDE the same "Theme" card, not as a
    // detached block below it: the toggle is a plain nidara-row (with a disclosure
    // chevron) and the four sliders reveal as further rows of the very card whose master
    // they refine. The revealer rides in a passive wrapper row so the slide-down happens
    // within the card; row-activated on the shared ListBox drives the toggle.
    const advChevron = new Gtk.Image({ gicon: Icons.chevronRight, pixel_size: 16, css_classes: ["nd-icon"] })
    const advToggleRow = createRow(t("settings.appearance.advanced"), "", advChevron)
    fcGroup.listBox.append(advToggleRow)

    const advInner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    advInner.append(sliderRow(
        t("settings.appearance.bar-opacity"), t("settings.appearance.bar-opacity.desc"),
        Theme.barOpacity, GLASS_RANGE.min, GLASS_RANGE.max, (v) => Theme.setBarOpacity(v),
        { ...OPACITY_OPTS, onExtChange: onTheme(() => Theme.barOpacity) },
    ))
    advInner.append(sliderRow(
        t("settings.appearance.overlay-opacity"), t("settings.appearance.overlay-opacity.desc"),
        Theme.overlayOpacity, GLASS_RANGE.min, GLASS_RANGE.max, (v) => Theme.setOverlayOpacity(v),
        { ...OPACITY_OPTS, onExtChange: onTheme(() => Theme.overlayOpacity) },
    ))
    advInner.append(sliderRow(
        t("settings.appearance.dock-opacity"), t("settings.appearance.dock-opacity.desc"),
        Theme.dockOpacity, GLASS_RANGE.min, GLASS_RANGE.max, (v) => Theme.setDockOpacity(v),
        { ...OPACITY_OPTS, onExtChange: onTheme(() => Theme.dockOpacity) },
    ))
    advInner.append(sliderRow(
        t("settings.appearance.window-glass"), t("settings.appearance.window-glass.desc"),
        Theme.windowOpacity, GLASS_RANGE.min, GLASS_RANGE.max, (v) => Theme.setWindowOpacity(v),
        { ...OPACITY_OPTS, onExtChange: onTheme(() => Theme.windowOpacity) },
    ))
    const advRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN, reveal_child: false })
    advRevealer.set_child(advInner)
    const advRevealerRow = new Gtk.ListBoxRow({ activatable: false, selectable: false, css_classes: ["settings-adv-revealer-row"] })
    advRevealerRow.set_child(advRevealer)
    fcGroup.listBox.append(advRevealerRow)

    fcGroup.listBox.connect("row-activated", (_: Gtk.ListBox, row: Gtk.ListBoxRow) => {
        if (row !== advToggleRow) return
        const open = !advRevealer.reveal_child
        advRevealer.reveal_child = open
        advChevron.gicon = open ? Icons.chevronDown : Icons.chevronRight
    })
    page.append(fcGroup.box)

    // 4. Night Light
    //
    // ⚠️ Every control here has a TWIN in the Control Center: the night-light widget's
    // detail panel (`widgets/night-light.ts`) is the same switch, the same temperature
    // slider and the same schedule over the same NightLightManager. The twin re-read
    // and this page did not — measured 2026-08-16: with Settings open on this page,
    // `setConfig nightlight.temperature 3200` left the slider reading 4910 K, while the
    // switch one row above followed `nightlight.enabled` in the same tick. Whoever
    // touched the slider next would then have written the stale number back.
    const nlGroup = listGroup(t("settings.appearance.group.night-light"))

    const onNightLight = <T,>(read: () => T) => (apply: (v: T) => void) => {
        apply(read())
        const id = NightLight.connect("changed", () => apply(read()))
        return () => safeDisconnect(NightLight, id)
    }

    // Manual toggle — insensitive when schedule controls it
    const nlSwitch = new Gtk.Switch({ active: NightLight.enabled, valign: Gtk.Align.CENTER, sensitive: !NightLight.scheduleEnabled })
    nlSwitch.connect("state-set", (_: any, v: boolean) => { NightLight.setEnabled(v); return false })
    nlGroup.listBox.append(createRow(
        t("settings.appearance.night-light"),
        t("settings.appearance.night-light.desc"),
        nlSwitch,
    ))

    nlGroup.listBox.append(sliderRow(
        t("settings.appearance.night-light-temp"),
        t("settings.appearance.night-light-temp.desc"),
        NightLight.temperature, 2700, 6500,
        (v) => NightLight.setTemperature(v),
        { unit: "K", icons: [Icons.minus, Icons.plus], onExtChange: onNightLight(() => NightLight.temperature) },
    ))

    // Schedule toggle
    const schedSwitch = new Gtk.Switch({ active: NightLight.scheduleEnabled, valign: Gtk.Align.CENTER })
    schedSwitch.connect("state-set", (_: any, v: boolean) => {
        NightLight.setScheduleEnabled(v)
        nlSwitch.sensitive = !v
        schedTimeRow.visible = v
        return false
    })
    nlGroup.listBox.append(createRow(
        t("settings.appearance.night-light-schedule"),
        t("settings.appearance.night-light-schedule.desc"),
        schedSwitch,
    ))

    // Time pickers helper
    const timePicker = (initial: string, onChange: (t: string) => void) => {
        const [ih, im] = initial.split(":").map(Number)
        const safeH = isNaN(ih) ? 20 : Math.max(0, Math.min(23, ih))
        const safeM = isNaN(im) ? 0  : Math.max(0, Math.min(59, im))

        const makeSpin = (lo: number, hi: number, val: number) => {
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({ lower: lo, upper: hi, step_increment: 1, value: val }),
                width_chars: 2, wrap: true, numeric: true, digits: 0,
                valign: Gtk.Align.CENTER,
                css_classes: ["time-spin"],
            })
            spin.connect("output", () => {
                spin.set_text(String(Math.round(spin.value)).padStart(2, "0"))
                return true
            })
            return spin
        }

        const hSpin = makeSpin(0, 23, safeH)
        const mSpin = makeSpin(0, 59, safeM)

        // `syncing` is not belt-and-braces: writing a spin to DISPLAY a value fires
        // `value-changed`, which would commit it straight back — the same "showing a
        // value is the same thing as setting it" that had opening Settings rewrite the
        // file the login reads (#154). Here it would re-save the schedule on every
        // refresh of a page that refreshes itself.
        let syncing = false
        const emit = () => {
            if (syncing) return
            const h = String(Math.round(hSpin.value)).padStart(2, "0")
            const m = String(Math.round(mSpin.value)).padStart(2, "0")
            onChange(`${h}:${m}`)
        }
        hSpin.connect("value-changed", emit)
        mSpin.connect("value-changed", emit)

        const box = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER })
        box.append(hSpin)
        box.append(new Gtk.Label({ label: ":", css_classes: ["nidara-row-subtitle"] }))
        box.append(mSpin)
        const sync = (time: string) => {
            const [h, m] = time.split(":").map(Number)
            if (isNaN(h) || isNaN(m)) return
            syncing = true
            hSpin.value = h
            mSpin.value = m
            syncing = false
        }
        return { box, sync }
    }

    const schedTimeBox = new Gtk.Box({ spacing: 24, valign: Gtk.Align.CENTER })

    const from = timePicker(NightLight.scheduleFrom, (v) => NightLight.setScheduleFrom(v))
    const to   = timePicker(NightLight.scheduleTo,   (v) => NightLight.setScheduleTo(v))

    const fromBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    fromBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-from"), halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))
    fromBox.append(from.box)

    const toBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    toBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-to"), halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))
    toBox.append(to.box)

    schedTimeBox.append(fromBox)
    schedTimeBox.append(toBox)

    const schedTimeRow = createRow("", "", schedTimeBox)
    schedTimeRow.visible = NightLight.scheduleEnabled
    nlGroup.listBox.append(schedTimeRow)

    // Keep manual toggle in sync when schedule fires — and when the schedule fired
    // while the user was on another page (this one is cached, so it must re-read).
    const syncNightLight = () => {
        nlSwitch.active    = NightLight.enabled
        nlSwitch.sensitive = !NightLight.scheduleEnabled
        schedSwitch.active = NightLight.scheduleEnabled
        schedTimeRow.visible = NightLight.scheduleEnabled
        from.sync(NightLight.scheduleFrom)
        to.sync(NightLight.scheduleTo)
    }
    bindWhileRealized(page, () => {
        syncNightLight()
        const nlChangedId = NightLight.connect("changed", syncNightLight)
        return () => safeDisconnect(NightLight, nlChangedId)
    })

    page.append(nlGroup.box)

    // 5. System Assets
    const assetsGroup = listGroup(t("settings.appearance.group.resources"))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.gtk-theme"), t("settings.appearance.gtk-theme.desc"),
        Theme.themeFamily, Theme.getAvailableGtkThemes(), (v) => Theme.setGtkTheme(v),
        onTheme(() => Theme.themeFamily),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.icons"), t("settings.appearance.icons.desc"),
        Theme.iconTheme, Theme.getAvailableIconThemes(), (v) => Theme.setIconTheme(v),
        onTheme(() => Theme.iconTheme),
    ))
    // Cursor THEME only. Its SIZE used to sit right here as a second dropdown and
    // moved to Accessibility on 2026-08-16 — one setting, one control, and pointer
    // size is an accessibility affordance in GNOME and macOS alike. What a cursor
    // looks like is appearance; how big it needs to be to be findable is not.
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.cursor"), t("settings.appearance.cursor.desc"),
        Theme.cursorTheme, Theme.getAvailableCursorThemes(), (v) => Theme.setCursorTheme(v),
        onTheme(() => Theme.cursorTheme),
    ))
    page.append(assetsGroup.box)

    // 6. Fonts
    const fontsGroup = listGroup(t("settings.appearance.group.fonts"))

    const interfaceFontBtn = NidaraFontButton({
        font: Theme.interfaceFont,
        title: t("settings.appearance.interface-font"),
        onFontSet: (f) => Theme.setFont(f),
        onExtChange: onTheme(() => Theme.interfaceFont),
    })
    fontsGroup.listBox.append(createRow(
        t("settings.appearance.interface-font"),
        t("settings.appearance.interface-font.desc"),
        interfaceFontBtn,
    ))

    const monoFontBtn = NidaraFontButton({
        font: Theme.monoFont,
        title: t("settings.appearance.mono-font"),
        onFontSet: (f) => Theme.setMonoFont(f),
        onExtChange: onTheme(() => Theme.monoFont),
    })
    fontsGroup.listBox.append(createRow(
        t("settings.appearance.mono-font"),
        t("settings.appearance.mono-font.desc"),
        monoFontBtn,
    ))
    // Text scaling lives in Accessibility → Vision (single source); not duplicated here.

    page.append(fontsGroup.box)

    // State sync for the two controls that are not rows with their own hook: the
    // dark-mode switch and the accent swatches. Through `bindWhileRealized` like
    // everything else on the page, so it re-reads on the way back in rather than
    // relying on having been listening at the moment something changed.
    const updateThemeState = () => {
        syncingDark = true
        darkSwitch.active = Theme.isDark
        syncingDark = false
        const currentAccent = Theme.accentColor
        Object.keys(accentButtons).forEach(key => {
            accentButtons[key].remove_css_class("selected")
            if (key === currentAccent) accentButtons[key].add_css_class("selected")
        })
    }
    bindWhileRealized(page, () => {
        updateThemeState()
        const id = Theme.connect("changed", updateThemeState)
        return () => safeDisconnect(Theme, id)
    })

    return page
}
