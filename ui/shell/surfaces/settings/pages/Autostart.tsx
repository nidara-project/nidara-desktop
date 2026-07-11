import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { listGroup, createRow, pageBox, type SettingsNav } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import appService, { type AppData } from "../../../core/AppService"
import { NidaraButton } from "../../../../lib/nidara-kit"
import { attachTooltip } from "../../../common/Tooltip"
import { makeIconImage } from "./AppIconImage"

// ── Config path ───────────────────────────────────────────────────────────────
// hyprland.lua loads user overrides with `safe_require("hyprland-user")`, and its
// package.path puts ~/.config/nidara/?.lua BEFORE ~/.config/hypr/?.lua. Lua's
// require() loads the FIRST match only, so this page must edit whatever file Lua
// actually resolves — mirroring that order: the canonical nidara file if present,
// else the legacy hypr one (pre-fix installs wrote there), else create the
// canonical one. Resolved per operation, never cached: Settings hides rather than
// closes, and either file can appear/disappear between visits.
const NIDARA_CONF = `${GLib.get_home_dir()}/.config/nidara/hyprland-user.lua`
const LEGACY_CONF = `${GLib.get_home_dir()}/.config/hypr/hyprland-user.lua`

const resolveUserConf = (): string => {
    if (GLib.file_test(NIDARA_CONF, GLib.FileTest.EXISTS)) return NIDARA_CONF
    if (GLib.file_test(LEGACY_CONF, GLib.FileTest.EXISTS)) return LEGACY_CONF
    return NIDARA_CONF
}

// Seeded above the block when the file is created fresh, so a user opening it
// later knows which part is theirs.
const FILE_HEADER = [
    "-- Personal Hyprland overrides. The @autostart block below is managed by",
    "-- Settings → Apps → Autostart; everything outside it is yours to edit.",
]

// Markers that delimit the UI-managed autostart block inside hyprland-user.lua
const AUTOSTART_BEGIN = "-- @autostart start"
const AUTOSTART_END   = "-- @autostart end"

// ── Parsing ───────────────────────────────────────────────────────────────────

interface AutostartEntry { command: string; enabled: boolean }

const readFileAt = (path: string): string => {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null)
        return new TextDecoder().decode(bytes)
    } catch {
        return ""
    }
}

const readConf = (): string => readFileAt(resolveUserConf())

const parseEntries = (content: string): AutostartEntry[] => {
    const lines = content.split("\n")
    const start = lines.findIndex(l => l.trim() === AUTOSTART_BEGIN)
    const end   = lines.findIndex(l => l.trim() === AUTOSTART_END)
    if (start === -1 || end === -1) return []

    return lines.slice(start + 1, end)
        .map(line => {
            const stripped = line.trim()
            const active   = stripped.match(/^hl\.exec_cmd\(["'](.+)["']\)/)
            if (active)   return { command: active[1],   enabled: true }
            const disabled = stripped.match(/^--\s*hl\.exec_cmd\(["'](.+)["']\)/)
            if (disabled) return { command: disabled[1], enabled: false }
            return null
        })
        .filter(Boolean) as AutostartEntry[]
}

// ── Writing ───────────────────────────────────────────────────────────────────

const writeEntries = (newEntries: AutostartEntry[]) => {
    const path    = resolveUserConf()
    const content = readFileAt(path)
    const lines   = content.split("\n")
    const start   = lines.findIndex(l => l.trim() === AUTOSTART_BEGIN)
    const end     = lines.findIndex(l => l.trim() === AUTOSTART_END)

    const block = [
        AUTOSTART_BEGIN,
        'hl.on("hyprland.start", function()',
        ...newEntries.map(e =>
            e.enabled
                ? `    hl.exec_cmd("${e.command}")`
                : `    -- hl.exec_cmd("${e.command}")`
        ),
        "end)",
        AUTOSTART_END,
    ]

    const result = start !== -1 && end !== -1
        ? [...lines.slice(0, start), ...block, ...lines.slice(end + 1)]
        : content.trim() === ""
            ? [...FILE_HEADER, "", ...block]
            : [...lines, "", ...block]

    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755)
        Gio.File.new_for_path(path).replace_contents(
            new TextEncoder().encode(result.join("\n")),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        )
    } catch (e) {
        console.error("[Autostart] Failed to write config:", e)
    }
}

// ── App resolution (display only) ─────────────────────────────────────────────
// Entries are stored as plain shell commands (human-editable; format unchanged).
// For display we best-effort resolve the two shapes AppService.getLaunchCommand()
// emits back to an installed app:
//   gtk-launch <desktop-id>   → cache lookup by id (".desktop" stripped)
//   flatpak run <flatpak-id>  → flatpak-exported desktop ids equal the flatpak id
// Anything else (hand-written commands, since-uninstalled apps) renders as the
// raw command. Resolution never gates toggle/delete — the command string is the
// entry's identity.
const resolveEntryApp = (command: string): AppData | null => {
    try {
        const [ok, argv] = GLib.shell_parse_argv(command)
        if (!ok || !argv) return null
        if (argv.length === 2 && argv[0] === "gtk-launch")
            return appService.getAppData(argv[1].replace(/\.desktop$/, ""))
        if (argv.length === 3 && argv[0] === "flatpak" && argv[1] === "run")
            return appService.getAppData(argv[2])
    } catch { /* unparseable command — not an error, just not resolvable */ }
    return null
}

// A `"` would break out of the Lua string in `hl.exec_cmd("…")`; a trailing `\`
// would escape its closing quote. Both corrupt the config, so custom commands
// containing either are rejected at the input (picker output is safe: shell_quote
// uses single quotes).
const isSafeCommand = (cmd: string) => !cmd.includes('"') && !cmd.includes("\\")

// ── App picker subpage ────────────────────────────────────────────────────────
// Windows (Apps → Startup) / macOS (Login Items) pick from installed apps; the
// raw-command field remains below as the advanced path. Pure subpage flow — no
// popovers/menus (design-system).

function buildAppPickerPage(onPick: (cmd: string) => void, existingCommands: string[]): Gtk.Widget {
    const page = pageBox("apps-page")

    // Search + scrollable list duplicated from AppIcons.tsx (same classes, same
    // filter idiom) — the scaffold carries page-specific tuning and hard-won fixes
    // (card chrome on the fixed ScrolledWindow, non-overlay scrollbar). On a THIRD
    // consumer, extract a shared builder instead of copying again.
    const searchInput = new Gtk.Text({
        placeholder_text: t("settings.apps.entry.search"),
        css_classes: ["settings-search-text"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const searchEntry = new Gtk.Box({
        css_classes: ["settings-search"],
        spacing: 8,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        margin_bottom: 4,
    })
    searchEntry.append(new Gtk.Image({
        gicon: Icons.search,
        pixel_size: 15,
        css_classes: ["nd-icon", "settings-search-icon"],
        valign: Gtk.Align.CENTER,
    }))
    searchEntry.append(searchInput)

    page.append(searchEntry)

    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, css_classes: ["nidara-list-group"] })

    const appList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ["apps-list"],
    })

    appService.getAllApps().forEach(app => {
        // Subtitle shows exactly the command that will be written — honest and
        // debuggable (it's also what an unresolvable row displays later).
        const cmd = appService.getLaunchCommand(app.id)
        const added = existingCommands.includes(cmd)

        const icon = makeIconImage(appService.getCanonicalIconName(app.icon ?? ""), 32)
        icon.valign = Gtk.Align.CENTER

        const trailing = added
            ? new Gtk.Label({
                label: t("settings.autostart.added"),
                css_classes: ["nidara-row-subtitle"],
                valign: Gtk.Align.CENTER,
            })
            : new Gtk.Image({
                gicon: Icons.plus, pixel_size: 16,
                opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
            })

        const row = createRow(app.name, cmd, trailing, undefined, icon)
        if (!added) {
            row.set_cursor_from_name("pointer")
            const click = new Gtk.GestureClick()
            click.connect("released", () => onPick(cmd))
            row.add_controller(click)
        }

        // Tag for filter
        ;(row as any)._appName = app.name.toLowerCase()
        ;(row as any)._appId = app.id.toLowerCase()

        appList.append(row)
    })

    appList.set_filter_func((row: Gtk.ListBoxRow) => {
        const q = searchInput.text.trim().toLowerCase()
        if (!q) return true
        const r = row as any
        return r._appName?.includes(q) || r._appId?.includes(q)
    })
    searchInput.connect("changed", () => appList.invalidate_filter())

    const scroll = new Gtk.ScrolledWindow({
        vexpand: true,
        min_content_height: 400,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        overlay_scrolling: false,
        css_classes: ["apps-list-scroll"],
    })
    scroll.set_child(appList)
    groupBox.append(scroll)

    page.append(groupBox)

    // Custom command — the advanced path, moved from the old inline add row.
    const { box: customBox, listBox: customList } = listGroup(t("settings.autostart.group.custom"))

    const entryField = new Gtk.Entry({
        placeholder_text: t("settings.autostart.entry.placeholder"),
        hexpand: true,
        valign: Gtk.Align.CENTER,
        css_classes: ["settings-entry"],
    })

    const addBtn = NidaraButton({
        label: t("settings.autostart.add"),
        variant: "primary",
        pill: true,
        valign: Gtk.Align.CENTER,
        sensitive: false,
    })

    const validate = () => {
        const cmd = entryField.text.trim()
        addBtn.sensitive = cmd.length > 0 && isSafeCommand(cmd) && !existingCommands.includes(cmd)
    }
    entryField.connect("changed", validate)
    entryField.connect("activate", () => {
        if (addBtn.sensitive) addBtn.activate()
    })
    addBtn.connect("clicked", () => onPick(entryField.text.trim()))

    const rowBox = new Gtk.Box({
        spacing: 12,
        margin_start: 16,
        margin_end: 16,
        margin_top: 12,
        margin_bottom: 12,
    })
    rowBox.append(new Gtk.Image({ gicon: Icons.terminal, pixel_size: 18, valign: Gtk.Align.CENTER, opacity: 0.6, css_classes: ["nd-icon"] }))
    rowBox.append(entryField)
    rowBox.append(addBtn)

    const customRow = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
    customRow.set_child(rowBox)
    customList.append(customRow)

    page.append(customBox)

    return page
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutostartPage(nav: SettingsNav) {
    const page = pageBox("autostart-page")

    const { box, listBox } = listGroup(t("settings.autostart.group.entries"))
    page.append(box)

    let entries: AutostartEntry[] = parseEntries(readConf())

    const buildEntryRow = (entry: AutostartEntry, idx: number): Gtk.ListBoxRow => {
        const app = resolveEntryApp(entry.command)

        // width_request 32 on the small glyphs = same leading column as the 32px
        // app icons, so titles align across resolved/unresolved/add rows.
        const leadingIcon = app
            ? makeIconImage(appService.getCanonicalIconName(app.icon ?? ""), 32)
            : new Gtk.Image({ gicon: Icons.terminal, pixel_size: 18, width_request: 32, css_classes: ["nd-icon"] })
        leadingIcon.valign = Gtk.Align.CENTER
        leadingIcon.opacity = entry.enabled ? 1.0 : 0.5

        const toggle = new Gtk.Switch({ active: entry.enabled, valign: Gtk.Align.CENTER })
        toggle.connect("state-set", (_: any, state: boolean) => {
            entries[idx].enabled = state
            writeEntries(entries)
            leadingIcon.opacity = state ? 1.0 : 0.5
            return false
        })

        const deleteBtn = new Gtk.Button({
            child: new Gtk.Image({ gicon: Icons.trash, pixel_size: 16, css_classes: ["nd-icon"] }),
            css_classes: ["nidara-btn", "nidara-btn--danger"],
            valign: Gtk.Align.CENTER,
        })
        attachTooltip(deleteBtn, t("settings.autostart.tooltip.remove"), { chrome: false })
        deleteBtn.connect("clicked", () => {
            entries.splice(idx, 1)
            writeEntries(entries)
            refresh()
        })

        const controls = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
        controls.append(toggle)
        controls.append(deleteBtn)

        return createRow(
            app ? app.name : entry.command,
            app ? entry.command : "",
            controls,
            undefined,
            leadingIcon,
        )
    }

    // Adds from the picker: dedupe, persist, rebuild the list the user returns to
    // (subpages are rebuilt on push, not on back-navigation — refresh() here is
    // what makes the new entry visible after goBack()).
    const onPick = (cmd: string) => {
        if (!entries.some(e => e.command === cmd)) {
            entries.push({ command: cmd, enabled: true })
            writeEntries(entries)
            refresh()
        }
        nav.goBack()
    }

    const buildAddNavRow = (): Gtk.ListBoxRow => {
        const plusIcon = new Gtk.Image({
            gicon: Icons.plus, pixel_size: 18, width_request: 32,
            opacity: 0.6, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
        })
        const chevron = new Gtk.Image({
            gicon: Icons.chevronRight, pixel_size: 16,
            opacity: 0.4, valign: Gtk.Align.CENTER, css_classes: ["nd-icon"],
        })
        const row = createRow(t("settings.autostart.add-app"), "", chevron, undefined, plusIcon)
        row.set_cursor_from_name("pointer")

        const click = new Gtk.GestureClick()
        click.connect("released", () => {
            nav.pushSubpage({
                id: "apps/autostart/add",
                title: t("settings.autostart.add-app"),
                parentId: "apps/autostart",
                build: () => buildAppPickerPage(onPick, entries.map(e => e.command)),
            })
        })
        row.add_controller(click)
        return row
    }

    const refresh = () => {
        // Removing rows can leave descender ink (y/g/j/p) behind — the same GTK4
        // repaint bug as filter-hide in the app lists. Known; see tech-debt.md #29.
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        if (entries.length === 0) {
            const emptyRow = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
            emptyRow.set_child(new Gtk.Label({
                label: t("settings.autostart.empty"),
                css_classes: ["settings-placeholder"],
                margin_top: 14,
                margin_bottom: 14,
            }))
            listBox.append(emptyRow)
        } else {
            entries.forEach((entry, idx) => listBox.append(buildEntryRow(entry, idx)))
        }

        listBox.append(buildAddNavRow())
    }

    refresh()

    // Info note
    const note = new Gtk.Label({
        label: t("settings.autostart.apply-note"),
        css_classes: ["nidara-row-subtitle"],
        halign: Gtk.Align.START,
        margin_start: 10,
        // Footnote binds to the card above (NidaraList box is spacing:0); 8px = the
        // title→card attachment gap. See design-system.md.
        margin_top: 8,
        wrap: true,
    })
    box.append(note)

    return page
}
