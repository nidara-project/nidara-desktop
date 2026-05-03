import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { execAsync } from "ags/process"
import { listGroup, createRow, toggleRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import regionConfig, { TimeFormat, DateFormat } from "../../../core/RegionConfig"
import inputConfig from "../../../core/InputConfig"
import { t } from "../../../core/i18n"

const TIME_FORMAT_LABELS = (): Record<TimeFormat, string> => ({
    "24h": t("settings.region.time.24h"),
    "12h": t("settings.region.time.12h"),
})

const DATE_FORMAT_LABELS = (): Record<DateFormat, string> => ({
    "none":       t("settings.region.date.none"),
    "short":      t("settings.region.date.short"),
    "short-year": t("settings.region.date.short-year"),
    "long":       t("settings.region.date.long"),
    "numeric":    t("settings.region.date.numeric"),
    "iso":        t("settings.region.date.iso"),
})

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
    page.append(pageHeader(t("settings.region.title"), t("settings.region.subtitle")))

    // ── Live Clock Preview ─────────────────────────────────────────────────────
    const clockLabel = new Gtk.Label({
        label: clockPreview(),
        css_classes: ["region-clock-preview"],
        halign: Gtk.Align.CENTER,
    })

    const clockSubLabel = new Gtk.Label({
        label: t("settings.region.preview"),
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
    const { box: timeBox, listBox: timeList } = listGroup(t("settings.region.time.group"))

    const tFmtsDict = TIME_FORMAT_LABELS()
    const timeFmts = Object.keys(tFmtsDict) as TimeFormat[]
    const timeDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    timeFmts.forEach(k => timeDrp.append_text(tFmtsDict[k]))
    timeDrp.active = timeFmts.indexOf(regionConfig.timeFormat)
    timeDrp.connect("changed", () => {
        const v = timeFmts[timeDrp.active]
        if (v) regionConfig.setTimeFormat(v)
    })
    timeList.append(createRow(t("settings.region.time.format"), t("settings.region.time.format.desc"), timeDrp))

    timeList.append(toggleRow(
        t("settings.region.time.seconds"),
        t("settings.region.time.seconds.desc"),
        regionConfig.showSeconds,
        (v) => regionConfig.setShowSeconds(v),
    ))

    timeBox.append(timeList)
    page.append(timeBox)

    // ── Fecha ─────────────────────────────────────────────────────────────────
    const { box: dateBox, listBox: dateList } = listGroup(t("settings.region.date.group"))

    const dFmtsDict = DATE_FORMAT_LABELS()
    const dateFmts = Object.keys(dFmtsDict) as DateFormat[]
    const dateDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    dateFmts.forEach(k => dateDrp.append_text(dFmtsDict[k]))
    dateDrp.active = dateFmts.indexOf(regionConfig.dateFormat)
    dateDrp.connect("changed", () => {
        const v = dateFmts[dateDrp.active]
        if (v) regionConfig.setDateFormat(v)
    })
    dateList.append(createRow(t("settings.region.date.format"), t("settings.region.date.format.desc"), dateDrp))

    dateBox.append(dateList)
    page.append(dateBox)

    // ── Zona Horaria ──────────────────────────────────────────────────────────
    const { box: tzBox, listBox: tzList } = listGroup(t("settings.region.tz.group"))

    const tzDetected = regionConfig.timezone || regionConfig.detectTimezone() || "UTC"
    const tzCurrentLabel = staticLabel(tzDetected)
    tzList.append(createRow(t("settings.region.tz.active"), t("settings.region.tz.active.desc"), tzCurrentLabel))

    // Text entry with EntryCompletion backed by timedatectl list-timezones
    const tzEntry = new Gtk.Entry({
        text: tzDetected,
        placeholder_text: t("settings.region.tz.placeholder"),
        valign: Gtk.Align.CENTER,
        width_chars: 24,
    })

    const completion = new Gtk.EntryCompletion()
    const tzModel = new Gtk.ListStore()
    // @ts-ignore
    tzModel.set_column_types([GObject.TYPE_STRING])
    completion.set_model(tzModel)
    completion.set_text_column(0)
    completion.set_minimum_key_length(2)
    completion.set_inline_completion(true)
    tzEntry.set_completion(completion)

    execAsync(["timedatectl", "list-timezones"]).then(output => {
        output.trim().split("\n").forEach(tz => {
            if (!tz) return
            const iter = tzModel.append()
            // @ts-ignore
            tzModel.set(iter, [0], [tz])
        })
    }).catch(() => {})

    let tzStatusTimerId = 0

    const tzApplyBtn = new Gtk.Button({
        label: t("settings.region.tz.apply"),
        css_classes: ["suggested-action"],
        valign: Gtk.Align.CENTER,
    })

    const applyTimezone = () => {
        const tz = tzEntry.text.trim()
        if (!tz) return

        tzApplyBtn.sensitive = false
        tzApplyBtn.label = "…"

        regionConfig.setTimezone(tz)

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            const success = regionConfig.timezone === tz
            tzApplyBtn.label = success ? "✓" : "✗"
            if (success) tzCurrentLabel.label = tz

            if (tzStatusTimerId) GLib.source_remove(tzStatusTimerId)
            tzStatusTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                tzApplyBtn.label = t("settings.region.tz.apply")
                tzApplyBtn.sensitive = true
                tzStatusTimerId = 0
                return GLib.SOURCE_REMOVE
            })
            return GLib.SOURCE_REMOVE
        })
    }

    tzApplyBtn.connect("clicked", applyTimezone)
    tzEntry.connect("activate", applyTimezone)

    const tzEntryRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    tzEntryRow.append(tzEntry)
    tzEntryRow.append(tzApplyBtn)
    tzList.append(createRow(
        t("settings.region.tz.change"),
        t("settings.region.tz.change.desc"),
        tzEntryRow,
    ))

    tzBox.append(tzList)
    page.append(tzBox)

    // ── Idioma del sistema y Teclado ──────────────────────────────────────────
    const { box: localeBox, listBox: localeList } = listGroup(t("settings.region.locale.group"))

    // --- 1. Locale (LANG) ---
    const langEntry = new Gtk.Entry({ placeholder_text: t("settings.region.locale.lang.placeholder"), width_chars: 20, valign: Gtk.Align.CENTER })
    const langCompletion = new Gtk.EntryCompletion()
    const langModel = new Gtk.ListStore()
    // @ts-ignore
    langModel.set_column_types([GObject.TYPE_STRING])
    langCompletion.set_model(langModel)
    langCompletion.set_text_column(0)
    langCompletion.set_inline_completion(true)
    langCompletion.set_minimum_key_length(1)
    langEntry.set_completion(langCompletion)

    const applyLangBtn = new Gtk.Button({ label: t("settings.region.tz.apply"), css_classes: ["suggested-action"], valign: Gtk.Align.CENTER })
    const langEntryRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    langEntryRow.append(langEntry)
    langEntryRow.append(applyLangBtn)
    
    localeList.append(createRow(t("settings.region.locale.lang"), t("settings.region.locale.lang.desc"), langEntryRow))

    // --- 2. Keyboard Layout ---
    const kbEntry = new Gtk.Entry({ placeholder_text: t("settings.region.locale.kb.placeholder"), width_chars: 20, valign: Gtk.Align.CENTER })
    const kbCompletion = new Gtk.EntryCompletion()
    const kbModel = new Gtk.ListStore()
    // @ts-ignore
    kbModel.set_column_types([GObject.TYPE_STRING])
    kbCompletion.set_model(kbModel)
    kbCompletion.set_text_column(0)
    kbCompletion.set_inline_completion(true)
    kbCompletion.set_minimum_key_length(1)
    kbEntry.set_completion(kbCompletion)

    const applyKbBtn = new Gtk.Button({ label: t("settings.region.tz.apply"), css_classes: ["suggested-action"], valign: Gtk.Align.CENTER })
    const kbEntryRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    kbEntryRow.append(kbEntry)
    kbEntryRow.append(applyKbBtn)
    
    localeList.append(createRow(t("settings.region.locale.kb"), t("settings.region.locale.kb.desc"), kbEntryRow))

    // --- 2. Regional Format (LC_TIME, LC_NUMERIC, etc.) ---
    // A single locale choice that sets all "format" LC_* variables at once.
    // Populated from `locale -a`; "" means "same as LANG".
    const regionalValues: string[] = [""]
    const regionalDrp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    regionalDrp.append_text(t("settings.region.locale.regional.same"))

    execAsync(["locale", "-a"]).then(output => {
        const locales = output.trim().split("\n")
            .map(l => l.trim())
            .filter(l => l.includes(".") && l !== "C.utf8" && l !== "POSIX")
            .map(l => l.replace(/\.utf8$/i, ".UTF-8"))
            .sort()
        locales.forEach(l => {
            regionalValues.push(l)
            regionalDrp.append_text(l)
        })
        const current = regionConfig.regionalLocale
        const idx = current ? regionalValues.indexOf(current) : 0
        // Block signal while setting initial value
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            regionalDrp.active = idx >= 0 ? idx : 0
            return GLib.SOURCE_REMOVE
        })
    }).catch(console.error)

    regionalDrp.connect("changed", () => {
        const idx = regionalDrp.active
        if (idx >= 0 && idx < regionalValues.length)
            regionConfig.setRegionalLocale(regionalValues[idx])
    })

    localeList.append(createRow(
        t("settings.region.locale.regional"),
        t("settings.region.locale.regional.desc"),
        regionalDrp,
    ))

    // Initialization: parse current values and populate lists
    execAsync(["localectl", "status"]).then(out => {
        const langMatch = out.match(/System Locale:\s*LANG=(\S+)/)
        if (langMatch) langEntry.text = langMatch[1]

        execAsync(["localectl", "list-locales"]).then(list => {
            list.trim().split("\n").forEach(l => {
                if (!l) return
                const iter = langModel.append()
                // @ts-ignore
                langModel.set(iter, [0], [l])
            })
        }).catch(console.error)

        kbEntry.text = inputConfig.kbLayout || out.match(/X11 Layout:\s*(\S+)/)?.[1] || "us"

        execAsync(["localectl", "list-x11-keymap-layouts"]).then(list => {
            list.trim().split("\n").forEach(k => {
                if (!k) return
                const iter = kbModel.append()
                // @ts-ignore
                kbModel.set(iter, [0], [k])
            })
        }).catch(console.error)
    }).catch(console.error)

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
        inputConfig.setKbLayout(kb)
    }

    applyLangBtn.connect("clicked", applyLang)
    langEntry.connect("activate", applyLang)
    
    applyKbBtn.connect("clicked", applyKb)
    kbEntry.connect("activate", applyKb)

    localeBox.append(localeList)
    page.append(localeBox)

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
