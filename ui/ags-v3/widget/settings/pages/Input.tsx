import { Gtk } from "ags/gtk4"
import { listGroup, pageHeader, pageBox, toggleRow, sliderRow, dropdownRow } from "../SettingsHelpers"
import inputConfig from "../../../core/InputConfig"
import { t } from "../../../core/i18n"

export default function InputPage() {
    const page = pageBox("input-page")
    page.append(pageHeader(t("settings.input.title"), t("settings.input.subtitle")))

    // ── Mouse ─────────────────────────────────────────────────────────────────
    const { box: mouseBox, listBox: mouseList } = listGroup(t("settings.input.mouse.group"))

    mouseList.append(sliderRow(
        t("settings.input.mouse.speed"),
        t("settings.input.mouse.speed.desc"),
        inputConfig.pointerSpeed,
        -1.0,
        1.0,
        (v) => inputConfig.setPointerSpeed(v),
        { icons: ["input-mouse-symbolic", "input-mouse-symbolic"], pct: true }
    ))

    const accelProfiles = ["adaptive", "flat"]
    mouseList.append(dropdownRow(
        t("settings.input.mouse.accel"),
        t("settings.input.mouse.accel.desc"),
        inputConfig.accelProfile,
        accelProfiles,
        (v) => inputConfig.setAccelProfile(v)
    ))

    mouseBox.append(mouseList)
    page.append(mouseBox)

    // ── Touchpad ──────────────────────────────────────────────────────────────
    const { box: touchBox, listBox: touchList } = listGroup(t("settings.input.touchpad.group"))

    touchList.append(toggleRow(
        t("settings.input.touchpad.natural"),
        t("settings.input.touchpad.natural.desc"),
        inputConfig.touchpadNaturalScroll,
        (v) => inputConfig.setTouchpadNaturalScroll(v)
    ))

    touchList.append(toggleRow(
        t("settings.input.touchpad.tap"),
        t("settings.input.touchpad.tap.desc"),
        inputConfig.touchpadTap,
        (v) => inputConfig.setTouchpadTap(v)
    ))

    touchBox.append(touchList)
    page.append(touchBox)

    // ── Keyboard ──────────────────────────────────────────────────────────────
    const { box: kbBox, listBox: kbList } = listGroup(t("settings.input.keyboard.group"))

    kbList.append(toggleRow(
        t("settings.input.keyboard.numlock"),
        t("settings.input.keyboard.numlock.desc"),
        inputConfig.numlockOnBoot,
        (v) => inputConfig.setNumlockOnBoot(v)
    ))

    kbBox.append(kbList)
    page.append(kbBox)

    // ── Signals Sync ──────────────────────────────────────────────────────────
    // The inputs could potentially change from outside
    const sigId = inputConfig.connect("changed", () => {
        // Simple UI rebinding would go here if needed, but since users interact with
        // this page directly it's fine. For full reactive binding on the slider, etc,
        // it requires GObject properties. For now we only handle initial state injection.
    })

    page.connect("unrealize", () => {
        try { inputConfig.disconnect(sigId) } catch {}
    })

    return page
}
