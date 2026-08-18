import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import { execAsync } from "../../../../lib/process"
import { listGroup, createRow, toggleRow, pageBox, staticLabel, bindWhileRealized } from "../SettingsHelpers"
import regionConfig, { TimeFormat, DateFormat } from "../../../core/RegionConfig"
import { t } from "../../../core/i18n"
import { safeDisconnect } from "../../../core/signals"
import { NidaraButton, NidaraDropDown } from "../../../../lib/nidara-kit"

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
        return regionConfig.formatClock()
    } catch {
        return "—"
    }
}

export default function RegionPage() {
    const page = pageBox("region-page")

    // ── Live Clock Preview ─────────────────────────────────────────────────────
    const clockLabel = new Gtk.Label({
        label: clockPreview(),
        css_classes: ["region-clock-preview"],
        halign: Gtk.Align.CENTER,
    })

    const clockSubLabel = new Gtk.Label({
        label: t("settings.region.preview"),
        css_classes: ["nidara-row-subtitle"],
        halign: Gtk.Align.CENTER,
    })

    const previewBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        halign: Gtk.Align.CENTER,
        css_classes: ["region-preview-box"],
        margin_bottom: 8,
    })
    previewBox.append(clockLabel)
    previewBox.append(clockSubLabel)
    page.append(previewBox)

    // The 1s tick is armed in bindWhileRealized at the bottom of the page, so it
    // really does run only "while the page is visible" — and, crucially, is armed
    // AGAIN when the user comes back. Created here it survived exactly one visit.

    // ── Hora ──────────────────────────────────────────────────────────────────
    const { box: timeBox, listBox: timeList } = listGroup(t("settings.region.time.group"))

    const tFmtsDict = TIME_FORMAT_LABELS()
    const timeFmts = Object.keys(tFmtsDict) as TimeFormat[]
    const timeLabels = timeFmts.map(k => tFmtsDict[k])
    const timeModel = new Gtk.StringList({ strings: timeLabels })
    const timeDrp = NidaraDropDown({ model: timeModel, valign: Gtk.Align.CENTER })
    timeDrp.selected = Math.max(0, timeFmts.indexOf(regionConfig.timeFormat))
    timeDrp.connect("notify::selected", () => {
        const v = timeFmts[timeDrp.selected]
        if (v) regionConfig.setTimeFormat(v)
    })
    timeList.append(createRow(t("settings.region.time.format"), t("settings.region.time.format.desc"), timeDrp))

    timeList.append(toggleRow(
        t("settings.region.time.seconds"),
        t("settings.region.time.seconds.desc"),
        regionConfig.showSeconds,
        (v) => regionConfig.setShowSeconds(v),
    ))

    page.append(timeBox)

    // ── Fecha ─────────────────────────────────────────────────────────────────
    const { box: dateBox, listBox: dateList } = listGroup(t("settings.region.date.group"))

    const dFmtsDict = DATE_FORMAT_LABELS()
    const dateFmts = Object.keys(dFmtsDict) as DateFormat[]
    const dateLabels = dateFmts.map(k => dFmtsDict[k])
    const dateModel = new Gtk.StringList({ strings: dateLabels })
    const dateDrp = NidaraDropDown({ model: dateModel, valign: Gtk.Align.CENTER })
    dateDrp.selected = Math.max(0, dateFmts.indexOf(regionConfig.dateFormat))
    dateDrp.connect("notify::selected", () => {
        const v = dateFmts[dateDrp.selected]
        if (v) regionConfig.setDateFormat(v)
    })
    dateList.append(createRow(t("settings.region.date.format"), t("settings.region.date.format.desc"), dateDrp))

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

    const tzApplyBtn = NidaraButton({
        label: t("settings.region.tz.apply"),
        variant: "primary",
        pill: true,
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

    page.append(tzBox)

    // ── Idioma y formatos ─────────────────────────────────────────────────────
    const { box: localeBox, listBox: localeList } = listGroup(t("settings.region.locale.group"))

    // --- 1. Locale (LANG) ---
    // A dropdown, not a text entry: `localectl list-locales` is the closed set of
    // locales this system can actually switch to (the GENERATED ones — 13 on a stock
    // install, not the ~800 of the full glibc catalogue), so there is nothing to type
    // that the list cannot offer. `langValues` shadows the model because the model is
    // the only thing the widget knows and we need the string back on selection.
    //
    // The Apply button stays — unlike the regional-format dropdown below (our own JSON
    // config, instant), this one shells out to `pkexec localectl`, and a control that
    // raises a polkit password prompt the moment the selection moves is a trap. Same
    // rule as the timezone row above: root gets an Apply, our own config does not.
    const langValues: string[] = []
    const langModel = new Gtk.StringList({ strings: [] })
    const langDrp = NidaraDropDown({ model: langModel, valign: Gtk.Align.CENTER })

    const applyLangBtn = NidaraButton({ label: t("settings.region.tz.apply"), variant: "primary", pill: true, valign: Gtk.Align.CENTER })
    const langRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    langRow.append(langDrp)
    langRow.append(applyLangBtn)

    localeList.append(createRow(t("settings.region.locale.lang"), t("settings.region.locale.lang.desc"), langRow))

    // The keyboard layout used to have a second control right here — an entry whose
    // Apply called `inputConfig.setKbLayout(kb)` with ONE argument, so `variant`
    // defaulted back to "" and silently dropped a Dvorak/Colemak choice made in
    // Devices. Settings → Devices is the single owner now (its dropdown carries the
    // variant), which is also where macOS and GNOME put it.

    // --- 2. Regional Format (LC_TIME, LC_NUMERIC, etc.) ---
    // A single locale choice that sets all "format" LC_* variables at once.
    // Populated from `locale -a`; "" means "same as LANG".
    //
    // ⚠️ This group holds TWO DIFFERENT SCOPES, which is why its title is neutral
    // ("Language & formats") and each row states its own reach in the subtitle:
    // Language writes /etc/locale.conf (system-wide), Regional format writes
    // ~/.config/environment.d/nidara-locale.conf (THIS user only, re-read by the
    // systemd user manager at each login). A group title that named either scope
    // would be a lie about the other row.
    //
    // 🔑 "System-wide" deliberately does NOT promise the login screen. The greeter
    // has its OWN language picker (`ui/greeter/widget/LocaleBar.ts` → `greeter-prefs
    // .json`), and `detectLocale()` in `ui/greeter/lib/i18n.ts` reads that FIRST —
    // /etc/locale.conf is only its fallback, for a machine nobody has picked on yet.
    // So this row governs the greeter until someone touches that picker, and never
    // again after. The first draft of this subtitle said "login screen included"
    // and was wrong for every machine whose greeter had been used once.
    const regionalValues: string[] = [""]
    const regionalModel = new Gtk.StringList({ strings: [t("settings.region.locale.regional.same")] })
    const regionalDrp = NidaraDropDown({ model: regionalModel, valign: Gtk.Align.CENTER })

    // Set while the dropdown is being told what the config ALREADY says. Without
    // it, showing the current value writes it: `selected = idx` emits
    // `notify::selected`, the handler calls setRegionalLocale, and that rewrites
    // ~/.config/environment.d/nidara-locale.conf. Settings builds all 21 top-level
    // pages eagerly, so this ran on every OPEN of the window, whatever page the
    // user actually wanted. (Same shape as the profile sync in Power.tsx.)
    let syncingRegional = false

    execAsync(["locale", "-a"]).then(output => {
        const locales = output.trim().split("\n")
            .map(l => l.trim())
            .filter(l => l.includes(".") && l !== "C.utf8" && l !== "POSIX")
            .map(l => l.replace(/\.utf8$/i, ".UTF-8"))
            .sort()
        locales.forEach(l => {
            regionalValues.push(l)
            regionalModel.append(l)
        })
        // A saved locale the system no longer lists is SHOWN, not silently dropped.
        // `indexOf` returns -1 for it and the fallback was index 0 — "same as LANG"
        // — so the row REPORTED a setting the config did not hold, for a locale that
        // `locale -a` merely stopped listing (dropped from locale.gen, or spelled
        // differently before the .utf8 → .UTF-8 normalisation above). Measured: the
        // file is not rewritten in that state, because index 0 is where the dropdown
        // already was and GObject emits no notify for an unchanged property — so it
        // is a display lie rather than data loss. Which is only luck: the same
        // fallback with any other saved value writes.
        const current = regionConfig.regionalLocale
        if (current && !regionalValues.includes(current)) {
            regionalValues.push(current)
            regionalModel.append(current)
        }
        const idx = current ? regionalValues.indexOf(current) : 0
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            syncingRegional = true
            regionalDrp.selected = idx >= 0 ? idx : 0
            syncingRegional = false
            return GLib.SOURCE_REMOVE
        })
    }).catch(console.error)

    regionalDrp.connect("notify::selected", () => {
        if (syncingRegional) return
        const idx = regionalDrp.selected
        if (idx < regionalValues.length)
            regionConfig.setRegionalLocale(regionalValues[idx])
    })

    localeList.append(createRow(
        t("settings.region.locale.regional"),
        t("settings.region.locale.regional.desc"),
        regionalDrp,
    ))

    // Initialization: fill the locale list, THEN select the live LANG in it.
    // Nested on purpose — the selection is only meaningful once the model has rows,
    // and `localectl status` is what knows which row is the current one.
    execAsync(["localectl", "list-locales"]).then(list => {
        list.trim().split("\n").forEach(l => {
            const v = l.trim()
            if (!v) return
            // Drop the C/POSIX family. `localectl list-locales` lists C.UTF-8 FIRST,
            // so without this it is the top entry of a control labelled "Language" —
            // and it is not a language: it is the POSIX "no localization" locale
            // (untranslated messages, byte-order collation, C date format, no
            // currency). Regional format below has always filtered it; this list
            // did not, which is the inconsistency this filter closes.
            // Not the same as hiding it if it is already ACTIVE — a LANG the list
            // does not contain gets appended below, so a machine really running
            // C.UTF-8 still shows the truth instead of a neighbouring row.
            if (/^(C|POSIX)(\.|$)/.test(v)) return
            langValues.push(v)
            langModel.append(v)
        })

        return execAsync(["localectl", "status"]).then(out => {
            const current = out.match(/System Locale:\s*LANG=(\S+)/)?.[1]
            if (!current) return
            // A LANG that is set but not generated (someone edited /etc/locale.conf by
            // hand) is not in list-locales. Show the truth rather than a neighbouring
            // row that would silently become the value on the next Apply.
            let idx = langValues.indexOf(current)
            if (idx < 0) { langValues.push(current); langModel.append(current); idx = langValues.length - 1 }
            // idle_add for the same reason as the regional dropdown below: setting
            // `selected` in the same tick the model grew does not stick.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                langDrp.selected = idx
                return GLib.SOURCE_REMOVE
            })
        })
    }).catch(console.error)

    const applyLang = () => {
        const lang = langValues[langDrp.selected]
        if (!lang) return
        applyLangBtn.sensitive = false
        execAsync(["pkexec", "localectl", "set-locale", `LANG=${lang}`])
            .finally(() => applyLangBtn.sensitive = true)
    }

    applyLangBtn.connect("clicked", applyLang)

    page.append(localeBox)

    const syncFromConfig = () => {
        clockLabel.label = clockPreview()
        // `selected`, not `active` — `active` is Gtk.ComboBox's property and setting it
        // on a Gtk.DropDown did nothing at all, so an external change to the time or
        // date format never moved these two. Found by the typechecker on the way past.
        timeDrp.selected = Math.max(0, timeFmts.indexOf(regionConfig.timeFormat))
        dateDrp.selected = Math.max(0, dateFmts.indexOf(regionConfig.dateFormat))
    }

    bindWhileRealized(page, () => {
        syncFromConfig()   // the formats may have changed while the page was away
        const clockTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            clockLabel.label = clockPreview()
            return GLib.SOURCE_CONTINUE
        })
        const regionSigId = regionConfig.connect("changed", syncFromConfig)
        return () => {
            GLib.source_remove(clockTimerId)
            // Transient "✓ / ✗" button reset; it also self-clears (SOURCE_REMOVE),
            // so null it here or leaving twice removes an id that is already gone.
            if (tzStatusTimerId) { GLib.source_remove(tzStatusTimerId); tzStatusTimerId = 0 }
            safeDisconnect(regionConfig, regionSigId)
        }
    })

    return page
}
