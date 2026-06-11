import { Gtk } from "ags/gtk4"
import { listGroup, pageBox, toggleRow, sliderRow, dropdownRow } from "../SettingsHelpers"
import Icons from "../../../core/Icons"
import inputConfig from "../../../core/InputConfig"
import { t } from "../../../core/i18n"

export default function InputPage() {
    const page = pageBox("input-page")

    // Live external-sync factory: each control re-reads its value from InputConfig
    // whenever InputConfig emits "changed" — which it does on boot and, crucially, on
    // `config-reloaded` (an external `hyprctl reload` / a hyprland-user.lua edit). The
    // control applies the value through its own guarded setter (no `setX`, no loop) and
    // disconnects on unrealize. Closes the old no-op "changed" stub.
    const onCfg = <T,>(read: () => T) => (apply: (v: T) => void) => {
        const id = inputConfig.connect("changed", () => apply(read()))
        return () => { try { inputConfig.disconnect(id) } catch {} }
    }

    // ── Mouse ─────────────────────────────────────────────────────────────────
    const { box: mouseBox, listBox: mouseList } = listGroup(t("settings.input.mouse.group"))

    mouseList.append(sliderRow(
        t("settings.input.mouse.speed"),
        t("settings.input.mouse.speed.desc"),
        inputConfig.pointerSpeed,
        -1.0,
        1.0,
        (v) => inputConfig.setPointerSpeed(v),
        { icons: [Icons.mousePointer, Icons.mousePointer], pct: true, onExtChange: onCfg(() => inputConfig.pointerSpeed) }
    ))

    const accelProfiles = ["adaptive", "flat"]
    mouseList.append(dropdownRow(
        t("settings.input.mouse.accel"),
        t("settings.input.mouse.accel.desc"),
        inputConfig.accelProfile,
        accelProfiles,
        (v) => inputConfig.setAccelProfile(v),
        onCfg(() => inputConfig.accelProfile)
    ))

    mouseList.append(toggleRow(
        t("settings.input.mouse.natural"),
        t("settings.input.mouse.natural.desc"),
        inputConfig.mouseNaturalScroll,
        (v) => inputConfig.setMouseNaturalScroll(v),
        onCfg(() => inputConfig.mouseNaturalScroll)
    ))

    page.append(mouseBox)

    // ── Touchpad ──────────────────────────────────────────────────────────────
    const { box: touchBox, listBox: touchList } = listGroup(t("settings.input.touchpad.group"))

    touchList.append(toggleRow(
        t("settings.input.touchpad.natural"),
        t("settings.input.touchpad.natural.desc"),
        inputConfig.touchpadNaturalScroll,
        (v) => inputConfig.setTouchpadNaturalScroll(v),
        onCfg(() => inputConfig.touchpadNaturalScroll)
    ))

    touchList.append(toggleRow(
        t("settings.input.touchpad.tap"),
        t("settings.input.touchpad.tap.desc"),
        inputConfig.touchpadTap,
        (v) => inputConfig.setTouchpadTap(v),
        onCfg(() => inputConfig.touchpadTap)
    ))

    page.append(touchBox)

    // ── Keyboard ──────────────────────────────────────────────────────────────
    const { box: kbBox, listBox: kbList } = listGroup(t("settings.input.keyboard.group"))

    // Layout entries: [display label, hyprland layout code, variant]
    const layouts: [string, string, string][] = [
        ["English (US)",              "us",  ""],
        ["English (UK)",              "gb",  ""],
        ["Español (ES)",              "es",  ""],
        ["Español (Latinoamérica)",   "latam", ""],
        ["Français",                  "fr",  ""],
        ["Deutsch",                   "de",  ""],
        ["Italiano",                  "it",  ""],
        ["Português (Brasil)",        "br",  ""],
        ["Português (Portugal)",      "pt",  ""],
        ["Nederlands",                "nl",  ""],
        ["Polski",                    "pl",  ""],
        ["Русский",                   "ru",  ""],
        ["Українська",                "ua",  ""],
        ["日本語 (Romaji)",            "jp",  ""],
        ["中文 (Pinyin)",              "cn",  ""],
        ["한국어",                     "kr",  ""],
        ["العربية",                    "ara", ""],
        ["Svenska",                   "se",  ""],
        ["Norsk",                     "no",  ""],
        ["Dansk",                     "dk",  ""],
        ["Suomi",                     "fi",  ""],
        ["Čeština",                   "cz",  ""],
        ["Slovenčina",                "sk",  ""],
        ["Magyar",                    "hu",  ""],
        ["Română",                    "ro",  ""],
        ["Türkçe",                    "tr",  ""],
        ["English (Dvorak)",          "us",  "dvorak"],
        ["English (Colemak)",         "us",  "colemak"],
    ]
    const layoutLabels = layouts.map(([label]) => label)

    const currentLayoutLabel = (): string => {
        const cur = layouts.find(([, l, v]) => l === inputConfig.kbLayout && v === inputConfig.kbVariant)
        return cur?.[0] ?? inputConfig.kbLayout
    }

    kbList.append(dropdownRow(
        t("settings.input.keyboard.layout"),
        t("settings.input.keyboard.layout.desc"),
        currentLayoutLabel(),
        layoutLabels,
        (label) => {
            const entry = layouts.find(([l]) => l === label)
            if (entry) inputConfig.setKbLayout(entry[1], entry[2])
        },
        onCfg(() => currentLayoutLabel())
    ))

    kbList.append(toggleRow(
        t("settings.input.keyboard.numlock"),
        t("settings.input.keyboard.numlock.desc"),
        inputConfig.numlockOnBoot,
        (v) => inputConfig.setNumlockOnBoot(v),
        onCfg(() => inputConfig.numlockOnBoot)
    ))

    kbList.append(sliderRow(
        t("settings.input.keyboard.repeat-delay"),
        t("settings.input.keyboard.repeat-delay.desc"),
        inputConfig.kbRepeatDelay, 100, 2000,
        (v) => inputConfig.setKbRepeatDelay(v),
        { unit: "ms", onExtChange: onCfg(() => inputConfig.kbRepeatDelay) }
    ))

    kbList.append(sliderRow(
        t("settings.input.keyboard.repeat-rate"),
        t("settings.input.keyboard.repeat-rate.desc"),
        inputConfig.kbRepeatRate, 1, 100,
        (v) => inputConfig.setKbRepeatRate(v),
        { unit: "/s", onExtChange: onCfg(() => inputConfig.kbRepeatRate) }
    ))

    page.append(kbBox)

    return page
}
