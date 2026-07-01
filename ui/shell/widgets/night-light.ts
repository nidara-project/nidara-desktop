import { Gtk } from "ags/gtk4"
import nightLight from "../core/NightLightManager"
import { makeHSlider } from "../common/Slider"
import { buildRoundContent, buildSplitCapsuleContent } from "../surfaces/control-center/Toggles"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { makeIconAction } from "./bar-helpers"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"

const subscribe = (sync: () => void) => {
    const id = nightLight.connect("changed", sync)
    return () => safeDisconnect(nightLight, id)
}

function buildBarContent() {
    return makeIconAction({
        // Dedicated icon (warm sunset) — distinct from dark-mode's moon/sun. On/off
        // is conveyed by the toggle's active state, not an icon swap.
        getIcon: () => Icons.sunset,
        onAction: () => nightLight.setEnabled(!nightLight.enabled),
        subscribe,
    })
}

const getIcon = () => Icons.sunset
const getSub = () => nightLight.enabled
    ? `${nightLight.temperature}K`
    : t("widget.night-light.sub.off")

// SINGLE keeps the toggle (every platform's compact quick-toggle stays a
// toggle — "open detail" is always a separate affordance, never a fallback on
// the same tap target, and there's no room for a second hit-region at 1×1).
// WIDE/SQUARE split: icon badge toggles, the rest of the capsule opens the
// detail panel — see [[project_cc_capsule_alignment]].
function buildContent(size: WidgetSize): Gtk.Widget {
    const toggle = () => nightLight.setEnabled(!nightLight.enabled)
    if (size === WidgetSize.SINGLE)
        return buildRoundContent(getIcon, () => nightLight.enabled, toggle, subscribe)
    return buildSplitCapsuleContent(getIcon, () => t("widget.night-light.name"), getSub, toggle, subscribe)
}

// ── CC detail panel: on/off switch + temperature slider + schedule ────────────
// Quick-access mirror of Settings → Appearance's Night Light group (same keys,
// same NightLightManager) — no new backend, just a compact echo for the CC.

function buildDetailPanel(_onClose: () => void): Gtk.Widget {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })

    const sw = new Gtk.Switch({ active: nightLight.enabled, valign: Gtk.Align.CENTER, sensitive: !nightLight.scheduleEnabled })
    sw.connect("state-set", (_s: Gtk.Switch, state: boolean) => { nightLight.setEnabled(state); return false })
    const switchRow = new Gtk.Box({ spacing: 8, margin_bottom: 4 })
    switchRow.append(new Gtk.Label({ label: t("widget.night-light.name"), css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true }))
    switchRow.append(sw)
    outer.append(switchRow)
    outer.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 2, margin_bottom: 2 }))

    const tempValueLabel = new Gtk.Label({ label: `${nightLight.temperature}K`, css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const tempSlider = makeHSlider({
        min: 2700, max: 6500, value: nightLight.temperature,
        onChange: (v) => nightLight.setTemperature(Math.round(v)),
        onValueChanged: (v) => { tempValueLabel.label = `${Math.round(v)}K` },
        onExtChange: (cb) => {
            const id = nightLight.connect("changed", () => cb(nightLight.temperature))
            return () => safeDisconnect(nightLight, id)
        },
        debounce: 24,
    })
    const tempRow = new Gtk.Box({ spacing: 8, margin_top: 6, margin_bottom: 6 })
    tempRow.append(new Gtk.Image({ gicon: Icons.minus, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    tempRow.append(tempSlider)
    tempRow.append(new Gtk.Image({ gicon: Icons.plus, pixel_size: 14, opacity: 0.5, css_classes: ["nd-icon"] }))
    tempRow.append(tempValueLabel)
    outer.append(tempRow)
    outer.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 2, margin_bottom: 2 }))

    const schedSwitch = new Gtk.Switch({ active: nightLight.scheduleEnabled, valign: Gtk.Align.CENTER })
    const schedRow = new Gtk.Box({ spacing: 8, margin_top: 4 })
    schedRow.append(new Gtk.Label({ label: t("settings.appearance.night-light-schedule"), css_classes: ["bar-popover-key"], halign: Gtk.Align.START, hexpand: true }))
    schedRow.append(schedSwitch)
    outer.append(schedRow)

    const makeSpin = (lo: number, hi: number, val: number) => {
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({ lower: lo, upper: hi, step_increment: 1, value: val }),
            width_chars: 2, wrap: true, numeric: true, digits: 0,
            valign: Gtk.Align.CENTER, css_classes: ["time-spin"],
        })
        spin.connect("output", () => { spin.set_text(String(Math.round(spin.value)).padStart(2, "0")); return true })
        return spin
    }

    const timePicker = (label: string, initial: string, onChange: (v: string) => void) => {
        const [ih, im] = initial.split(":").map(Number)
        const hSpin = makeSpin(0, 23, isNaN(ih) ? 20 : ih)
        const mSpin = makeSpin(0, 59, isNaN(im) ? 0 : im)
        const emit = () => onChange(`${String(Math.round(hSpin.value)).padStart(2, "0")}:${String(Math.round(mSpin.value)).padStart(2, "0")}`)
        hSpin.connect("value-changed", emit)
        mSpin.connect("value-changed", emit)

        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
        col.append(new Gtk.Label({ label, halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))
        const row = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER })
        row.append(hSpin)
        row.append(new Gtk.Label({ label: ":", css_classes: ["nidara-row-subtitle"] }))
        row.append(mSpin)
        col.append(row)
        return { col, sync: (v: string) => { const [h, m] = v.split(":").map(Number); hSpin.value = h; mSpin.value = m } }
    }

    const from = timePicker(t("settings.appearance.night-light-from"), nightLight.scheduleFrom, (v) => nightLight.setScheduleFrom(v))
    const to   = timePicker(t("settings.appearance.night-light-to"),   nightLight.scheduleTo,   (v) => nightLight.setScheduleTo(v))
    const timeRow = new Gtk.Box({ spacing: 16, margin_top: 6, margin_bottom: 6 })
    timeRow.append(from.col)
    timeRow.append(to.col)
    timeRow.visible = nightLight.scheduleEnabled
    outer.append(timeRow)

    schedSwitch.connect("state-set", (_s: Gtk.Switch, state: boolean) => {
        nightLight.setScheduleEnabled(state)
        sw.sensitive = !state
        timeRow.visible = state
        return false
    })

    const syncId = nightLight.connect("changed", () => {
        sw.active = nightLight.enabled
        sw.sensitive = !nightLight.scheduleEnabled
        schedSwitch.active = nightLight.scheduleEnabled
        timeRow.visible = nightLight.scheduleEnabled
        from.sync(nightLight.scheduleFrom)
        to.sync(nightLight.scheduleTo)
    })
    outer.connect("unrealize", () => safeDisconnect(nightLight, syncId))

    return outer
}

const nightLightWidget: AtomicWidget = {
    id: "night_light",
    category: "system",
    barOrder: 20,
    name: t("widget.night-light.name"),
    icon: Icons.sunset,
    locations: ["bar", "cc"],
    defaultInCc: false,   // off by default — optional/power feature; available to add
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, _budget) => buildContent(size),
    buildBarContent,
    buildCCDetail: buildDetailPanel,
    ccDetailRows: 4,
    getActive: () => nightLight.enabled,
    watchActive: subscribe,
}

export default nightLightWidget
