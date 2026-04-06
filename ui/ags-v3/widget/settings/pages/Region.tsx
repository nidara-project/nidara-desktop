import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { execAsync } from "ags/process"
import { listGroup, createRow, toggleRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import regionConfig, { TimeFormat, DateFormat } from "../../../core/RegionConfig"

const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
    "24h": "24 horas",
    "12h": "12 horas (AM/PM)",
}

const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
    "none":       "Solo hora — sin fecha",
    "short":      "Corto — Lun 06 Abr",
    "short-year": "Corto con año — Lun 06 Abr 2026",
    "long":       "Largo — Lunes, 06 Abr",
    "numeric":    "Numérico — 06/04/2026",
    "iso":        "ISO 8601 — 2026-04-06",
}

function clockPreview(): string {
    try {
        const fmt = regionConfig.getClockFormat()
        const [, bytes] = GLib.spawn_command_line_sync(`date +"${fmt}"`)
        return new TextDecoder().decode(bytes ?? new Uint8Array()).trim()
    } catch {
        return "—"
    }
}

export default function RegionPage() {
    const page = pageBox("region-page")
    page.append(pageHeader("Idioma y Región", "Formato de hora, fecha y zona horaria del sistema"))

    // ── Live Clock Preview ─────────────────────────────────────────────────────
    const clockLabel = new Gtk.Label({
        label: clockPreview(),
        css_classes: ["region-clock-preview"],
        halign: Gtk.Align.CENTER,
    })

    const clockSubLabel = new Gtk.Label({
        label: "Vista previa en vivo",
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.CENTER,
    })

    const previewBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        css_classes: ["region-preview-box"],
        margin_bottom: 8,
    })
    previewBox.append(clockLabel)
    previewBox.append(clockSubLabel)
    page.append(previewBox)

    // Live update timer — 1s tick while page is visible
    const clockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        clockLabel.label = clockPreview()
        return GLib.SOURCE_CONTINUE
    })

    // ── Hora ──────────────────────────────────────────────────────────────────
    const { box: timeBox, listBox: timeList } = listGroup("Hora")

    const timeFmts = Object.keys(TIME_FORMAT_LABELS) as TimeFormat[]
    const timeDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    timeFmts.forEach(k => timeDrp.append_text(TIME_FORMAT_LABELS[k]))
    timeDrp.active = timeFmts.indexOf(regionConfig.timeFormat)
    timeDrp.connect("changed", () => {
        const v = timeFmts[timeDrp.active]
        if (v) regionConfig.setTimeFormat(v)
    })
    timeList.append(createRow("Formato de hora", "Cómo se muestra la hora en la barra", timeDrp))

    timeList.append(toggleRow(
        "Mostrar segundos",
        "Incluye los segundos en el reloj de la barra",
        regionConfig.showSeconds,
        (v) => regionConfig.setShowSeconds(v),
    ))

    timeBox.append(timeList)
    page.append(timeBox)

    // ── Fecha ─────────────────────────────────────────────────────────────────
    const { box: dateBox, listBox: dateList } = listGroup("Fecha")

    const dateFmts = Object.keys(DATE_FORMAT_LABELS) as DateFormat[]
    const dateDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    dateFmts.forEach(k => dateDrp.append_text(DATE_FORMAT_LABELS[k]))
    dateDrp.active = dateFmts.indexOf(regionConfig.dateFormat)
    dateDrp.connect("changed", () => {
        const v = dateFmts[dateDrp.active]
        if (v) regionConfig.setDateFormat(v)
    })
    dateList.append(createRow("Formato de fecha", "Cómo se muestra la fecha en la barra", dateDrp))

    dateBox.append(dateList)
    page.append(dateBox)

    // ── Zona Horaria ──────────────────────────────────────────────────────────
    const { box: tzBox, listBox: tzList } = listGroup("Zona Horaria")

    const tzDetected = regionConfig.timezone || regionConfig.detectTimezone() || "UTC"
    const tzCurrentLabel = staticLabel(tzDetected)
    tzList.append(createRow("Zona activa", "Zona horaria del sistema", tzCurrentLabel))

    // Text entry with EntryCompletion backed by timedatectl list-timezones
    const tzEntry = new Gtk.Entry({
        text: tzDetected,
        placeholder_text: "Ej: Europe/Madrid",
        valign: Gtk.Align.CENTER,
        width_chars: 24,
    })

    const completion = new Gtk.EntryCompletion()
    const tzModel = new Gtk.ListStore()
    // @ts-ignore — GObject.TYPE_STRING required for ListStore column types
    tzModel.set_column_types([GObject.TYPE_STRING])
    completion.set_model(tzModel)
    completion.set_text_column(0)
    completion.set_minimum_key_length(2)
    completion.set_inline_completion(true)
    tzEntry.set_completion(completion)

    // Populate timezone list asynchronously — no blocking the UI
    execAsync(["timedatectl", "list-timezones"]).then(output => {
        output.trim().split("\n").forEach(tz => {
            if (!tz) return
            const iter = tzModel.append()
            // @ts-ignore
            tzModel.set(iter, [0], [tz])
        })
    }).catch(() => {
        // timedatectl unavailable — completion just won't work, that's fine
    })

    // Status label — shows success/error after apply
    const tzStatus = new Gtk.Label({
        label: "",
        css_classes: ["settings-row-subtitle", "tz-status"],
        halign: Gtk.Align.END,
        valign: Gtk.Align.CENTER,
        visible: false,
    })

    let tzStatusTimerId = 0

    const applyTimezone = () => {
        const tz = tzEntry.text.trim()
        if (!tz) return

        tzApplyBtn.sensitive = false
        tzStatus.label = "Aplicando…"
        tzStatus.remove_css_class("tz-status-ok")
        tzStatus.remove_css_class("tz-status-err")
        tzStatus.visible = true

        regionConfig.setTimezone(tz)

        // timedatectl is async inside setTimezone — poll after 2s
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            const success = regionConfig.timezone === tz
            if (success) {
                tzStatus.label = "✓ Aplicado"
                tzStatus.add_css_class("tz-status-ok")
                tzCurrentLabel.label = tz
            } else {
                tzStatus.label = "✗ Error al aplicar — verifica el nombre de la zona"
                tzStatus.add_css_class("tz-status-err")
            }
            tzApplyBtn.sensitive = true

            // Auto-hide status after 5s
            if (tzStatusTimerId) GLib.source_remove(tzStatusTimerId)
            tzStatusTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                tzStatus.visible = false
                tzStatusTimerId = 0
                return GLib.SOURCE_REMOVE
            })
            return GLib.SOURCE_REMOVE
        })
    }

    const tzApplyBtn = new Gtk.Button({
        label: "Aplicar",
        css_classes: ["suggested-action"],
        valign: Gtk.Align.CENTER,
    })
    tzApplyBtn.connect("clicked", applyTimezone)

    // Also apply when pressing Enter in the entry
    tzEntry.connect("activate", applyTimezone)

    const tzEntryRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    tzEntryRow.append(tzEntry)
    tzEntryRow.append(tzApplyBtn)
    tzList.append(createRow(
        "Cambiar zona horaria",
        "Escribe o selecciona una zona IANA",
        tzEntryRow,
    ))

    // Status row — spans full width below the entry row
    const tzStatusRow = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
    const tzStatusPad = new Gtk.Box({ margin_start: 16, margin_end: 16, margin_bottom: 8 })
    tzStatusPad.append(tzStatus)
    tzStatusRow.set_child(tzStatusPad)
    tzList.append(tzStatusRow)

    tzBox.append(tzList)
    page.append(tzBox)

    // ── Idioma del sistema y Teclado ──────────────────────────────────────────
    const { box: localeBox, listBox: localeList } = listGroup("Idioma del sistema")

    // --- 1. Locale (LANG) ---
    const langEntry = new Gtk.Entry({ placeholder_text: "Ej: es_ES.UTF-8", width_chars: 20, valign: Gtk.Align.CENTER })
    const langCompletion = new Gtk.EntryCompletion()
    const langModel = new Gtk.ListStore()
    // @ts-ignore
    langModel.set_column_types([GObject.TYPE_STRING])
    langCompletion.set_model(langModel)
    langCompletion.set_text_column(0)
    langCompletion.set_inline_completion(true)
    langCompletion.set_minimum_key_length(1)
    langEntry.set_completion(langCompletion)

    const applyLangBtn = new Gtk.Button({ label: "Aplicar", css_classes: ["suggested-action"], valign: Gtk.Align.CENTER })
    const langEntryRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    langEntryRow.append(langEntry)
    langEntryRow.append(applyLangBtn)
    
    localeList.append(createRow("Idioma (Locale)", "El cambio requiere reiniciar sesión", langEntryRow))

    // --- 2. Keyboard Layout ---
    const kbEntry = new Gtk.Entry({ placeholder_text: "Ej: es", width_chars: 20, valign: Gtk.Align.CENTER })
    const kbCompletion = new Gtk.EntryCompletion()
    const kbModel = new Gtk.ListStore()
    // @ts-ignore
    kbModel.set_column_types([GObject.TYPE_STRING])
    kbCompletion.set_model(kbModel)
    kbCompletion.set_text_column(0)
    kbCompletion.set_inline_completion(true)
    kbCompletion.set_minimum_key_length(1)
    kbEntry.set_completion(kbCompletion)

    const applyKbBtn = new Gtk.Button({ label: "Aplicar", css_classes: ["suggested-action"], valign: Gtk.Align.CENTER })
    const kbEntryRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    kbEntryRow.append(kbEntry)
    kbEntryRow.append(applyKbBtn)
    
    localeList.append(createRow("Distribución de Teclado", "Se aplica instantáneamente", kbEntryRow))

    // Initialization: parse current values and populate lists
    execAsync(["localectl", "status"]).then(out => {
        const langMatch = out.match(/System Locale:\s*LANG=(\S+)/)
        if (langMatch) langEntry.text = langMatch[1]
        
        // Populate locales list
        execAsync(["localectl", "list-locales"]).then(list => {
            list.trim().split("\n").forEach(l => {
                if (!l) return
                const iter = langModel.append()
                // @ts-ignore
                langModel.set(iter, [0], [l])
            })
        }).catch(console.error)

        // Read Hyprland config specifically for current KB (more reliable than localectl for Wayland)
        execAsync(["bash", "-c", "grep 'kb_layout' ~/.config/hypr/hyprland-user.conf | awk '{print $3}' || echo ''"]).then(kb => {
            kbEntry.text = kb.trim() || out.match(/X11 Layout:\s*(\S+)/)?.[1] || "us"
        }).catch(err => console.error("Error reading hypr kb_layout:", err))

        // Populate kb layouts list
        execAsync(["localectl", "list-x11-keymap-layouts"]).then(list => {
            list.trim().split("\n").forEach(k => {
                if (!k) return
                const iter = kbModel.append()
                // @ts-ignore
                kbModel.set(iter, [0], [k])
            })
        }).catch(console.error)
    }).catch(console.error)

    // Actions
    const applyLang = () => {
        const lang = langEntry.text.trim()
        if (!lang) return
        applyLangBtn.sensitive = false
        execAsync(["pkexec", "localectl", "set-locale", `LANG=${lang}`])
            .finally(() => applyLangBtn.sensitive = true)
    }

    const applyKb = () => {
        const kb = kbEntry.text.trim()
        if (!kb) return
        applyKbBtn.sensitive = false
        // Update both the active Hyprland session and the user's persistent config file
        const cmd = `sed -i "s/\\(kb_layout\\s*=\\s*\\).*/\\1${kb}/" ~/.config/hypr/hyprland-user.conf && hyprctl keyword input:kb_layout ${kb}`
        execAsync(["bash", "-c", cmd])
            .finally(() => applyKbBtn.sensitive = true)
    }

    applyLangBtn.connect("clicked", applyLang)
    langEntry.connect("activate", applyLang)
    
    applyKbBtn.connect("clicked", applyKb)
    kbEntry.connect("activate", applyKb)

    localeBox.append(localeList)
    page.append(localeBox)

    // ── Signal sync — keep dropdowns and preview in sync with external changes ──
    const regionSigId = regionConfig.connect("changed", () => {
        clockLabel.label = clockPreview()
        timeDrp.active = timeFmts.indexOf(regionConfig.timeFormat)
        dateDrp.active = dateFmts.indexOf(regionConfig.dateFormat)
    })

    page.connect("unrealize", () => {
        GLib.source_remove(clockTimerId)
        if (tzStatusTimerId) GLib.source_remove(tzStatusTimerId)
        try { regionConfig.disconnect(regionSigId) } catch {}
    })

    return page
}
