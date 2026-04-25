import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import Theme from "../../../core/ThemeManager"
import { listGroup, createRow, toggleRow, sliderRow, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })

function getCursorSize(): number {
    try { return iface.get_int("cursor-size") } catch { return 24 }
}
function setCursorSize(size: number) {
    try { iface.set_int("cursor-size", Math.round(size)) } catch (e) {
        console.error("[Accessibility] cursor-size:", e)
    }
}
function getAnimations(): boolean {
    try { return iface.get_boolean("enable-animations") } catch { return true }
}
function setAnimations(v: boolean) {
    try { iface.set_boolean("enable-animations", v) } catch (e) {
        console.error("[Accessibility] enable-animations:", e)
    }
}

export default function AccessibilityPage() {
    const page = pageBox("accessibility-page")
    page.append(pageHeader(t("settings.accessibility.title"), t("settings.accessibility.subtitle")))

    // ── Vision ────────────────────────────────────────────────────────────────
    const visionGroup = listGroup(t("settings.accessibility.group.vision"))

    visionGroup.listBox.append(sliderRow(
        t("settings.accessibility.text-scale"),
        t("settings.accessibility.text-scale.desc"),
        Theme.textScaling, 0.75, 2.0,
        (v) => Theme.setTextScaling(v),
        { decimals: 2, icons: ["font-x-generic-symbolic", "font-x-generic-symbolic"] },
    ))

    visionGroup.listBox.append(sliderRow(
        t("settings.accessibility.cursor-size"),
        t("settings.accessibility.cursor-size.desc"),
        getCursorSize(), 16, 96,
        (v) => setCursorSize(v),
        { unit: "px", icons: ["input-mouse-symbolic", "input-mouse-symbolic"] },
    ))

    page.append(visionGroup.box)

    // ── Motion ────────────────────────────────────────────────────────────────
    const motionGroup = listGroup(t("settings.accessibility.group.motion"))

    motionGroup.listBox.append(toggleRow(
        t("settings.accessibility.animations"),
        t("settings.accessibility.animations.desc"),
        getAnimations(),
        (v) => setAnimations(v),
    ))

    page.append(motionGroup.box)

    return page
}
