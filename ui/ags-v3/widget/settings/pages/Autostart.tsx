import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { listGroup, createRow, pageHeader, pageBox } from "../SettingsHelpers"

// ── Config path ───────────────────────────────────────────────────────────────
const USER_CONF = `${GLib.get_home_dir()}/.config/hypr/hyprland-user.conf`

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
    return content.split("\n")
        .map(line => {
            const stripped = line.trim()
            const active = stripped.match(/^exec-once\s*=\s*(.+)/)
            if (active) return { command: active[1].trim(), enabled: true }
            const disabled = stripped.match(/^# ?exec-once\s*=\s*(.+)/)
            if (disabled) return { command: disabled[1].trim(), enabled: false }
            return null
        })
        .filter(Boolean) as AutostartEntry[]
}

// ── Writing ───────────────────────────────────────────────────────────────────

const writeEntries = (newEntries: AutostartEntry[]) => {
    const content = readConf()
    const lines = content.split("\n")

    // Remove existing exec-once lines (enabled and disabled)
    const filtered = lines.filter(line => {
        const stripped = line.trim()
        return !stripped.match(/^exec-once\s*=/) && !stripped.match(/^#\s*exec-once\s*=/)
    })

    // Append the new entries
    const entryLines = newEntries.map(e =>
        e.enabled ? `exec-once = ${e.command}` : `# exec-once = ${e.command}`
    )

    const result = [...filtered, ...entryLines].join("\n")

    try {
        Gio.File.new_for_path(USER_CONF).replace_contents(
            new TextEncoder().encode(result),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        )
    } catch (e) {
        console.error("[Autostart] Failed to write config:", e)
    }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutostartPage() {
    const page = pageBox("autostart-page")
    page.append(pageHeader("Inicio automático", "Programas que se inician con Hyprland"))

    const { box, listBox } = listGroup("Entradas exec-once en hyprland-user.conf")
    page.append(box)

    let entries: AutostartEntry[] = parseEntries(readConf())

    const refresh = () => {
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        if (entries.length === 0) {
            const emptyRow = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            emptyRow.set_child(new Gtk.Label({
                label: "Sin entradas exec-once en hyprland-user.conf",
                css_classes: ["settings-placeholder"],
                margin_top: 14,
                margin_bottom: 14,
            }))
            listBox.append(emptyRow)
        } else {
            entries.forEach((entry, idx) => {
                const cmdLabel = new Gtk.Label({
                    label: entry.command,
                    css_classes: ["settings-row-label"],
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
                    child: new Gtk.Image({ icon_name: "edit-delete-symbolic", pixel_size: 16 }),
                    css_classes: ["destructive-action", "settings-row-action"],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: "Eliminar",
                })
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
                    icon_name: entry.enabled ? "media-playback-start-symbolic" : "media-playback-pause-symbolic",
                    pixel_size: 18,
                    valign: Gtk.Align.CENTER,
                    opacity: entry.enabled ? 1.0 : 0.5,
                }))
                rowBox.append(cmdLabel)
                rowBox.append(toggle)
                rowBox.append(deleteBtn)

                const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
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
            placeholder_text: "Comando (ej: nm-applet)",
            hexpand: true,
            valign: Gtk.Align.CENTER,
            css_classes: ["settings-entry"],
        })

        const addBtn = new Gtk.Button({
            label: "Añadir",
            css_classes: ["suggested-action"],
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
        rowBox.append(new Gtk.Image({ icon_name: "list-add-symbolic", pixel_size: 18, valign: Gtk.Align.CENTER, opacity: 0.6 }))
        rowBox.append(entry)
        rowBox.append(addBtn)

        const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        row.set_child(rowBox)
        return row
    }

    refresh()

    // Info note
    const note = new Gtk.Label({
        label: "Los cambios se aplican la próxima vez que Hyprland se inicia.",
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.START,
        margin_start: 10,
        margin_top: 4,
        wrap: true,
    })
    box.append(note)

    return page
}
