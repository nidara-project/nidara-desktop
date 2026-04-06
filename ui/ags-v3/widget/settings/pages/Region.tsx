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
    "short": "Corto — Lun 06 Abr",
    "long":  "Largo — Lunes, 06 Abr",
    "iso":   "ISO 8601 — 2026-04-06",
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

    // ── Idioma del sistema ────────────────────────────────────────────────────
    const { box: localeBox, listBox: localeList } = listGroup("Idioma del sistema")

    const langLabel = staticLabel("…")
    localeList.append(createRow("Locale activo", "Variable LANG del sistema", langLabel))

    const kbLabel = staticLabel("…")
    localeList.append(createRow("Distribución de teclado", "Layout X11 activo", kbLabel))

    // Single localectl call — parse both fields from same output
    execAsync(["localectl", "status"])
        .then(out => {
            const langMatch = out.match(/System Locale:\s*LANG=(\S+)/)
            langLabel.label = langMatch ? langMatch[1] : (GLib.getenv("LANG") || "Desconocido")
            const kbMatch = out.match(/X11 Layout:\s*(\S+)/)
            kbLabel.label = kbMatch ? kbMatch[1] : "—"
        })
        .catch(() => {
            langLabel.label = GLib.getenv("LANG") || "Desconocido"
            kbLabel.label = "—"
        })

    localeList.append(createRow(
        "Nota",
        "Cambiar el idioma requiere reiniciar la sesión y configurar el locale con localectl.",
        new Gtk.Image({ icon_name: "dialog-information-symbolic", pixel_size: 18, opacity: 0.6, valign: Gtk.Align.CENTER })
    ))

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
