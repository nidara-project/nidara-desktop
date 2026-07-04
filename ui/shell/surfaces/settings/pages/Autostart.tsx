import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { listGroup, createRow, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { NidaraButton } from "../../../../lib/nidara-kit"
import { attachTooltip } from "../../../common/Tooltip"

// ── Config path ───────────────────────────────────────────────────────────────
const USER_CONF = `${GLib.get_home_dir()}/.config/hypr/hyprland-user.lua`

// Markers that delimit the UI-managed autostart block inside hyprland-user.lua
const AUTOSTART_BEGIN = "-- @autostart start"
const AUTOSTART_END   = "-- @autostart end"

// ── Parsing ───────────────────────────────────────────────────────────────────

interface AutostartEntry { command: string; enabled: boolean }

const readConf = (): string => {
    try {
        const [, bytes] = Gio.File.new_for_path(USER_CONF).load_contents(null)
        return new TextDecoder().decode(bytes)
    } catch {
        return ""
    }
}

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
    const content = readConf()
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
        : [...lines, "", ...block]

    try {
        Gio.File.new_for_path(USER_CONF).replace_contents(
            new TextEncoder().encode(result.join("\n")),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        )
    } catch (e) {
        console.error("[Autostart] Failed to write config:", e)
    }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutostartPage() {
    const page = pageBox("autostart-page")

    const { box, listBox } = listGroup(t("settings.autostart.group.entries"))
    page.append(box)

    let entries: AutostartEntry[] = parseEntries(readConf())

    const refresh = () => {
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
            entries.forEach((entry, idx) => {
                const cmdLabel = new Gtk.Label({
                    label: entry.command,
                    css_classes: ["nidara-row-title"],
                    halign: Gtk.Align.START,
                    hexpand: true,
                    ellipsize: 3,
                    max_width_chars: 55,
                })

                const toggle = new Gtk.Switch({ active: entry.enabled, valign: Gtk.Align.CENTER })
                toggle.connect("state-set", (_: any, state: boolean) => {
                    entries[idx].enabled = state
                    writeEntries(entries)
                    return false
                })

                const deleteBtn = new Gtk.Button({
                    child: new Gtk.Image({ gicon: Icons.trash, pixel_size: 16 , css_classes: ["nd-icon"] }),
                    css_classes: ["nidara-btn", "nidara-btn--danger"],
                    valign: Gtk.Align.CENTER,
                })
                attachTooltip(deleteBtn, t("settings.autostart.tooltip.remove"), { chrome: false })
                deleteBtn.connect("clicked", () => {
                    entries.splice(idx, 1)
                    writeEntries(entries)
                    refresh()
                })

                const rowBox = new Gtk.Box({
                    spacing: 12,
                    margin_start: 16,
                    margin_end: 16,
                    margin_top: 12,
                    margin_bottom: 12,
                })
                rowBox.append(new Gtk.Image({
                    gicon: entry.enabled ? Icons.play : Icons.pause,
                    pixel_size: 18,
                    valign: Gtk.Align.CENTER,
                    opacity: entry.enabled ? 1.0 : 0.5,
                    css_classes: ["nd-icon"],
                }))
                rowBox.append(cmdLabel)
                rowBox.append(toggle)
                rowBox.append(deleteBtn)

                const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
                row.set_child(rowBox)
                listBox.append(row)
            })
        }

        // Add button row
        const addRow = buildAddRow()
        listBox.append(addRow)
    }

    const buildAddRow = (): Gtk.ListBoxRow => {
        const entry = new Gtk.Entry({
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

        entry.connect("changed", () => {
            addBtn.sensitive = entry.text.trim().length > 0
        })
        entry.connect("activate", () => {
            if (entry.text.trim().length > 0) addBtn.activate()
        })

        addBtn.connect("clicked", () => {
            const cmd = entry.text.trim()
            if (!cmd) return
            entries.push({ command: cmd, enabled: true })
            writeEntries(entries)
            refresh()
        })

        const rowBox = new Gtk.Box({
            spacing: 12,
            margin_start: 16,
            margin_end: 16,
            margin_top: 12,
            margin_bottom: 12,
        })
        rowBox.append(new Gtk.Image({ gicon: Icons.plus, pixel_size: 18, valign: Gtk.Align.CENTER, opacity: 0.6 , css_classes: ["nd-icon"] }))
        rowBox.append(entry)
        rowBox.append(addBtn)

        const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
        row.set_child(rowBox)
        return row
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
