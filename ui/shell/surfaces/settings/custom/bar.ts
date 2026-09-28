import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GioUnix from "gi://GioUnix"
import { listGroup, createRow, bindWhileRealized, pickImageFile, type SettingsNav } from "../SettingsHelpers"
import { NidaraButton, NidaraDropDown, NidaraListActions } from "../../../../lib/nidara-kit"
import { barSettings, updateBarSettings, onBarSettingsChanged, resolveLauncherIcon, LAUNCHER_ICON_PRESETS, DEFAULT_LAUNCHER_ICON } from "../../bar/barState"
import { widgetCatalog, type WidgetCatalogEntry } from "../../../core/WidgetCatalog"
import {
    SEARCH_KEY, defaultOrder, isBarHidden, knownTrayItems, resolveOrder, savedBarOrder, setBarHidden,
    sortWidgetsForBar, trayKey, watchBarOrder, widgetKey, type KnownTrayItem,
} from "../../../core/BarOrder"
import { uiIcon, currentUiIcon } from "../../../core/Icons"
import { t } from "../../../core/i18n"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

// ── Settings → Top bar (owner, 2026-09-27) ────────────────────────────────────
// After macOS's Menu Bar pane. ONE list of the bar's CONTROLS (macOS's word, and the
// right one: a volume slider is not a "widget"), read RIGHT TO LEFT the way macOS lists
// them — Clock, Control Center, then the right group's items in the bar's current order,
// then the window title and the system menu. Each row: a check on the left (none for the
// fixed ones), the icon, the name, and at most ONE control on the right — "Change icon"
// for the system menu, "Configure" for a control with settings, else "Always / When
// active" for one that can say it is active. Below, the apps' tray icons with a switch.
//
// Rules the owner set on the first live pass:
//  · A CHECKED control has an icon in the bar. So a control whose hardware is missing
//    shows its check OFF and disabled, the way the Control Center page shows its
//    switches; the saved choice is kept and comes back with the hardware (a Bluetooth
//    dongle plugged in later). "When active" is the one case of a checked control with
//    no icon for now, and that is what the words say.
//  · Toggling a row must not move the page. The list is rebuilt only when the SET of
//    rows or their order changes (`signature`); a check or a menu updates its own row.
//  · No explanatory footers: the controls say what they do.
//
// The ORDER is edited in the bar itself (the "Reorder in the bar" action at the foot of
// the list), not here: two lists could not say how controls and app icons mix.

/** A launcher icon is "custom" only when it points at an image file that still exists.
 *  A preset key ("nidara") — or a stale value from before the rebrand ("arch") — is
 *  the default: the bar falls back to the built-in mark, so the page shows the same. */
const isCustomIcon = () =>
    barSettings.launcherIcon.startsWith("/") && GLib.file_test(barSettings.launcherIcon, GLib.FileTest.EXISTS)
const launcherGicon = () => Gio.FileIcon.new(Gio.File.new_for_path(
    resolveLauncherIcon(barSettings.launcherIcon) ?? LAUNCHER_ICON_PRESETS[DEFAULT_LAUNCHER_ICON]))

/** A tray icon's recorded image: a theme name, or a file path. */
const trayGicon = (icon: string): any =>
    icon.startsWith("/") ? Gio.FileIcon.new(Gio.File.new_for_path(icon)) : Gio.ThemedIcon.new(icon)

/** Only apps that are still INSTALLED (owner: an uninstalled app must not linger). An
 *  icon no installed app could be matched to is listed — nothing says it is gone. */
const installed = (k: KnownTrayItem) => {
    if (!k.appId) return true
    try { return GioUnix.DesktopAppInfo.new(`${k.appId}.desktop`) !== null } catch { return false }
}

/** The leading slot: the check (or, for a fixed row, an invisible one holding its
 *  width, so every icon lines up), then the icon. */
function leading(check: Gtk.CheckButton | null, icon: Gtk.Image): Gtk.Box {
    const box = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })
    box.append(check ?? new Gtk.CheckButton({
        opacity: 0, can_focus: false, can_target: false, accessible_role: Gtk.AccessibleRole.PRESENTATION,
    }))
    box.append(icon)
    return box
}
const rowIcon = (gicon: any, symbolic = true) =>
    new Gtk.Image({ gicon, pixel_size: 18, valign: Gtk.Align.CENTER, css_classes: symbolic ? ["nd-icon"] : [] })

function check(active: boolean, sensitive: boolean, label: string, onToggle: (on: boolean) => void): Gtk.CheckButton {
    const c = new Gtk.CheckButton({ active, sensitive, valign: Gtk.Align.CENTER })
    c.update_property([Gtk.AccessibleProperty.LABEL], [label])
    c.connect("toggled", () => onToggle(c.get_active()))   // connected after `active` → no spurious fire
    return c
}

function modeDropDown(label: string, mode: "always" | "active", onPick: (m: "always" | "active") => void): Gtk.DropDown {
    const drop = NidaraDropDown({
        model: Gtk.StringList.new([t("settings.bar.mode.always"), t("settings.bar.mode.active")]),
        selected: mode === "active" ? 1 : 0,
        valign: Gtk.Align.CENTER,
        accessibleDescription: label,
    })
    drop.connect("notify::selected", () => onPick(drop.get_selected() === 1 ? "active" : "always"))
    return drop
}

/** "Configure" in a row's trailing slot, pushing the control's own settings page. */
function configureButton(nav: SettingsNav, w: WidgetCatalogEntry): Gtk.Button {
    const btn = NidaraButton({ label: t("settings.widgets.configure"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
    btn.connect("clicked", () => nav.pushSubpage({
        id: `bar/${w.id}`, title: w.name, parentId: "bar", build: w.buildSettings!,
    }))
    return btn
}

const clearRows = (listBox: Gtk.ListBox) => {
    let c = listBox.get_first_child()
    while (c) { const n = c.get_next_sibling(); listBox.remove(c); c = n }
}

export const build = (ctx: PageCtx) => {
    const itemsGroup = (): Gtk.Widget => {
        const { box, listBox } = listGroup(t("settings.bar.group.items"))
        const reorder = NidaraButton({ label: t("settings.bar.reorder"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
        reorder.connect("clicked", () => widgetCatalog().editBarOrder())
        const actions = NidaraListActions(listBox, reorder)

        // The system menu's row updates in place when its icon changes. Its icon and
        // reset button are built WITH the row, on every rebuild: a widget has one
        // parent, and handing the previous row's to a new row fails in silence — the
        // row came back without its icon or its reset, and a later page visit that
        // happened to rebuild cleanly showed them again (owner-caught 2026-09-27).
        let menuIcon: Gtk.Image | null = null
        let menuReset: Gtk.Button | null = null
        const syncMenu = () => {
            if (menuIcon) menuIcon.gicon = launcherGicon()
            if (menuReset) menuReset.sensitive = isCustomIcon()
        }

        let signature = ""
        const refresh = () => {
            // The right group, right to left, in the bar's own order. A control whose
            // hardware is missing is not listed — Wi-Fi on a machine without a radio no
            // more than a battery on a desktop; plugging the hardware in brings its row
            // (the signature below includes `available`).
            const entries = widgetCatalog().list().filter(w => w.canBar && w.available)
            const tray = knownTrayItems().filter(installed)
            const order = resolveOrder(savedBarOrder(), defaultOrder(
                sortWidgetsForBar(entries).map(w => widgetKey(w.id)), tray.map(k => trayKey(k.id))))
                .filter(k => k === SEARCH_KEY || k.startsWith("widget:"))
                .reverse()
            const next = JSON.stringify([order, entries.map(w => [w.id, w.available])])
            if (next === signature) return
            signature = next

            clearRows(listBox)
            const add = (row: Gtk.Widget) => listBox.append(row)
            const byId = new Map(entries.map(w => [w.id, w]))

            // Fixed at the right end: no check.
            add(createRow(t("settings.bar.item.clock"), "", new Gtk.Box(), undefined, leading(null, rowIcon(uiIcon("nd-preferences-system-time")))))
            add(createRow(t("settings.bar.item.control-center"), "", new Gtk.Box(), undefined, leading(null, rowIcon(uiIcon("nd-control-center")))))

            for (const key of order) {
                if (key === SEARCH_KEY) {
                    const name = t("bar.tooltip.search")
                    add(createRow(name, "", new Gtk.Box(), undefined,
                        leading(check(!isBarHidden(SEARCH_KEY), true, name, on => setBarHidden(SEARCH_KEY, !on)), rowIcon(uiIcon("nd-system-search")))))
                    continue
                }
                const w = byId.get(key.slice("widget:".length))
                if (!w) continue
                // One trailing control: Configure beats the mode menu, so a widget with
                // a settings page must not declare `barActive` — its mode could never be
                // changed here (screen recording did, and its icon never showed); the
                // menu follows the check.
                const trailing = new Gtk.Box({ valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
                let menu: Gtk.DropDown | null = null
                if (w.buildSettings && ctx.nav) {
                    trailing.append(configureButton(ctx.nav, w))
                } else if (w.barMode !== null) {
                    menu = modeDropDown(w.name, w.barMode, m => widgetCatalog().setBarMode(w.id, m))
                    menu.sensitive = w.bar
                    trailing.append(menu)
                }
                const c = check(w.bar, true, w.name, on => {
                    widgetCatalog().setBar(w.id, on)
                    if (menu) menu.sensitive = on
                })
                add(createRow(w.name, "", trailing, undefined,
                    leading(c, rowIcon(currentUiIcon(w.icon) ?? uiIcon("nd-window-floating")))))
            }

            // The left end, still right to left: the window title, then the system menu.
            const title = t("settings.bar.app-title")
            add(createRow(title, "", new Gtk.Box(), undefined,
                leading(check(barSettings.showAppTitle, true, title, on => updateBarSettings({ showAppTitle: on })), rowIcon(uiIcon("nd-window-floating")))))
            const menuButtons = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
            const change = NidaraButton({ label: t("settings.bar.change-icon"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
            change.connect("clicked", () => pickImageFile(change, path => updateBarSettings({ launcherIcon: path })))
            menuReset = NidaraButton({ label: t("settings.bar.icon-preset"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
            menuReset.connect("clicked", () => updateBarSettings({ launcherIcon: DEFAULT_LAUNCHER_ICON }))
            menuIcon = rowIcon(launcherGicon(), false)
            menuButtons.append(change)
            menuButtons.append(menuReset)
            syncMenu()
            add(createRow(t("settings.bar.item.system-menu"), "", menuButtons, undefined, leading(null, menuIcon)))

            listBox.append(actions)   // the same actions row, last again
        }

        bindWhileRealized(box, () => {
            signature = ""   // back on the page: show the world as it is now
            refresh()
            const offOrder = watchBarOrder(refresh)
            const offBar = onBarSettingsChanged(syncMenu)
            return () => { offOrder(); offBar() }
        })
        return box
    }

    // The apps' tray icons: a switch each, installed apps only. New ones appear as apps
    // show an icon for the first time — without a note saying so (owner: explaining
    // "installed only" raised more questions than it answered).
    const appsGroup = (): Gtk.Widget => {
        const { box, listBox } = listGroup(t("settings.bar.group.apps"))
        let signature = ""
        const refresh = () => {
            const tray = knownTrayItems().filter(installed)
            const next = JSON.stringify(tray.map(k => [k.id, k.title, k.icon]))
            if (next === signature) return
            signature = next
            clearRows(listBox)
            box.set_visible(tray.length > 0)
            for (const k of tray) {
                const key = trayKey(k.id)
                const name = k.title || k.id
                const sw = new Gtk.Switch({ active: !isBarHidden(key), valign: Gtk.Align.CENTER })
                sw.update_property([Gtk.AccessibleProperty.LABEL], [name])
                sw.connect("notify::active", () => setBarHidden(key, !sw.get_active()))
                listBox.append(createRow(name, "", sw, undefined, rowIcon(k.icon ? trayGicon(k.icon) : uiIcon("nd-window-floating"), false)))
            }
        }
        bindWhileRealized(box, () => { signature = ""; refresh(); return watchBarOrder(refresh) })
        return box
    }

    return {
        barItems: () => itemsGroup(),
        barApps: () => appsGroup(),
    } satisfies Record<string, ItemBuilder>
}
