import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { listGroup, pageBox, toggleRow, imagePickerRow } from "../SettingsHelpers"
import { barSettings, updateBarSettings } from "../../bar/barState"
import { LAUNCHER_ICON_PRESETS, DEFAULT_LAUNCHER_ICON } from "../../bar/Bar"
import { t } from "../../../core/i18n"

function resolveCurrentPath(key: string): string | null {
    if (LAUNCHER_ICON_PRESETS[key]) return LAUNCHER_ICON_PRESETS[key]
    if (key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)) return key
    return null
}

export default function BarPage() {
    const page = pageBox("bar-page")

    // ── Layout group ──────────────────────────────────────────────────────────
    const layoutGroup = listGroup(t("settings.bar.group.layout"))

    // The only layout toggle left, and the only one of the original three that
    // was ever a preference rather than a footgun: the system-menu capsule and
    // the Activity Island are both permanent now, each because hiding it removed
    // the sole route to a capability. Reasoning lives in `bar/barState.ts`.
    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.app-title"),
        t("settings.bar.app-title.desc"),
        barSettings.showAppTitle,
        (v) => updateBarSettings({ showAppTitle: v }),
    ))

    page.append(layoutGroup.box)

    // ── Launcher icon group ───────────────────────────────────────────────────
    const iconGroup = listGroup(t("settings.bar.group.icon"))

    // A launcherIcon is "custom" only when it points at an image file that still
    // exists. A preset key ("nidara") — or a stale value from before the rebrand
    // ("arch") — is treated as the default: the bar falls back to the built-in
    // mark, so the page must show the same, not the raw string. (This is why the
    // old free-text entry showed a literal "arch": it echoed the raw value.)
    const isCustomIcon = () =>
        barSettings.launcherIcon.startsWith("/")
        && GLib.file_test(barSettings.launcherIcon, GLib.FileTest.EXISTS)

    iconGroup.listBox.append(imagePickerRow(
        t("settings.bar.icon-custom"),
        t("settings.bar.icon-custom.desc"),
        {
            // Preview whatever the bar is ACTUALLY showing, falling back exactly
            // as SystemMenuIcon does — not the raw stored string.
            renderPreview: (img) => {
                const path = resolveCurrentPath(barSettings.launcherIcon)
                    ?? LAUNCHER_ICON_PRESETS[DEFAULT_LAUNCHER_ICON]
                img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path))
            },
            isCustom: isCustomIcon,
            onPick: (path) => { updateBarSettings({ launcherIcon: path }) },
            onReset: () => updateBarSettings({ launcherIcon: DEFAULT_LAUNCHER_ICON }),
            resetLabel: t("settings.bar.icon-preset"),
        },
    ))

    page.append(iconGroup.box)

    return page
}
