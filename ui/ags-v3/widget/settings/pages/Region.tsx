import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
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

/** Builds a live preview string using the current regionConfig format. */
function clockPreview(): string {
    try {
        const fmt = regionConfig.getClockFormat()
        const [, bytes] = GLib.spawn_command_line_sync(`date +${fmt}`)
        return new TextDecoder().decode(bytes ?? new Uint8Array()).trim()
    } catch {
        return "—"
    }
}

export default function RegionPage() {
    const page = pageBox("region-page")
    page.append(pageHeader("Idioma y Región", "Formato de hora, fecha y zona horaria del sistema"))

    // ── Hora ──────────────────────────────────────────────────────────────────
    const { box: timeBox, listBox: timeList } = listGroup("Hora")

    // Time format dropdown
    const timeFmts = Object.keys(TIME_FORMAT_LABELS) as TimeFormat[]
    const timeDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    timeFmts.forEach(k => timeDrp.append_text(TIME_FORMAT_LABELS[k]))
    timeDrp.active = timeFmts.indexOf(regionConfig.timeFormat)
    timeDrp.connect("changed", () => {
        const v = timeFmts[timeDrp.active]
        if (v) regionConfig.setTimeFormat(v)
    })
    timeList.append(createRow("Formato de hora", "Cómo se muestra la hora en la barra", timeDrp))

    // Timezone — show current + text entry to change
    const tzDetected = regionConfig.timezone || regionConfig.detectTimezone() || "UTC"
    const tzLabel = staticLabel(tzDetected)
    timeList.append(createRow("Zona horaria activa", "Zona horaria del sistema", tzLabel))

    const tzEntry = new Gtk.Entry({
        text: tzDetected,
        placeholder_text: "Ej: Europe/Madrid",
        valign: Gtk.Align.CENTER,
        width_chars: 22,
    })
    const tzApplyBtn = new Gtk.Button({
        label: "Aplicar",
        css_classes: ["suggested-action"],
        valign: Gtk.Align.CENTER,
    })
    tzApplyBtn.connect("clicked", () => {
        const tz = tzEntry.text.trim()
        if (!tz) return
        regionConfig.setTimezone(tz)
        tzLabel.label = tz
    })

    const tzBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    tzBox.append(tzEntry)
    tzBox.append(tzApplyBtn)
    timeList.append(createRow(
        "Cambiar zona horaria",
        "Nombre de zona IANA (requiere permisos de administrador)",
        tzBox
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

    // Live preview — updates when regionConfig changes
    const previewLabel = staticLabel(clockPreview())
    dateList.append(createRow("Vista previa", "Cómo aparecerá en la barra", previewLabel))

    const regionSigId = regionConfig.connect("changed", () => {
        previewLabel.label = clockPreview()
        timeDrp.active = timeFmts.indexOf(regionConfig.timeFormat)
        dateDrp.active = dateFmts.indexOf(regionConfig.dateFormat)
    })
    page.connect("unrealize", () => { try { regionConfig.disconnect(regionSigId) } catch {} })

    dateBox.append(dateList)
    page.append(dateBox)

    // ── Idioma del sistema ────────────────────────────────────────────────────
    const { box: localeBox, listBox: localeList } = listGroup("Idioma del sistema")

    // Show current locale async
    const langLabel = staticLabel("…")
    localeList.append(createRow("Locale activo", "Variable LANG del sistema", langLabel))
    const kbLabel = staticLabel("…")
    localeList.append(createRow("Distribución de teclado", "Layout X11 activo", kbLabel))

    // Single localectl call — parse both LANG and X11 Layout from the same output
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

    // Note: locale changes require session restart
    const noteRow = createRow(
        "Nota",
        "Cambiar el idioma del sistema requiere reiniciar la sesión y configurar el locale con localectl.",
        new Gtk.Image({ icon_name: "dialog-information-symbolic", pixel_size: 18, opacity: 0.6, valign: Gtk.Align.CENTER })
    )
    localeList.append(noteRow)

    localeBox.append(localeList)
    page.append(localeBox)

    return page
}
