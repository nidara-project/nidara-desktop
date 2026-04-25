import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import { listGroup, createRow, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

function getDisplayName(): string {
    try {
        const gecos = GLib.get_real_name()
        // GECOS field may include extra info separated by commas
        return gecos ? gecos.split(",")[0].trim() : GLib.get_user_name() ?? ""
    } catch { return GLib.get_user_name() ?? "" }
}

function getAvatarPath(): string | null {
    const face = `${GLib.get_home_dir()}/.face`
    return GLib.file_test(face, GLib.FileTest.EXISTS) ? face : null
}

function spawnTerminalWithCommand(cmd: string) {
    const terminals = ["kitty", "alacritty", "wezterm", "foot", "gnome-terminal", "xterm"]
    const args: Record<string, string[]> = {
        kitty:          ["kitty", "--", "bash", "-c", cmd],
        alacritty:      ["alacritty", "-e", "bash", "-c", cmd],
        wezterm:        ["wezterm", "start", "--", "bash", "-c", cmd],
        foot:           ["foot", "bash", "-c", cmd],
        "gnome-terminal": ["gnome-terminal", "--", "bash", "-c", cmd],
        xterm:          ["xterm", "-e", "bash", "-c", cmd],
    }
    for (const term of terminals) {
        if (GLib.find_program_in_path(term)) {
            execAsync(args[term]).catch(e => console.error("[Users] spawn terminal:", e))
            return
        }
    }
    console.error("[Users] No terminal emulator found")
}

export default function UsersPage() {
    const page = pageBox("users-page")
    page.append(pageHeader(t("settings.users.title"), t("settings.users.subtitle")))

    const username    = GLib.get_user_name() ?? ""
    const displayName = getDisplayName()
    const avatarPath  = getAvatarPath()

    // ── Profile ────────────────────────────���──────────────────────────────────
    const profileGroup = listGroup(t("settings.users.group.profile"))

    // Avatar
    const avatarBox = new Gtk.Box({ spacing: 0 })
    const avatarImg = new Gtk.Image({
        pixel_size: 56,
        css_classes: ["users-avatar"],
        valign: Gtk.Align.CENTER,
    })
    if (avatarPath) {
        try {
            avatarImg.set_from_file(avatarPath)
        } catch {
            avatarImg.icon_name = "avatar-default-symbolic"
        }
    } else {
        avatarImg.icon_name = "avatar-default-symbolic"
    }

    const changeAvatarBtn = new Gtk.Button({
        label: t("settings.users.avatar.change"),
        css_classes: ["pill"],
        valign: Gtk.Align.CENTER,
    })
    changeAvatarBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({ title: t("settings.users.avatar.pick"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/webp")
        filter.set_name(t("settings.users.avatar.filter"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)
        dialog.open(null, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const src  = file?.get_path()
                if (!src) return
                const dest = `${GLib.get_home_dir()}/.face`
                execAsync(["cp", src, dest]).then(() => {
                    try { avatarImg.set_from_file(dest) } catch {
                        avatarImg.icon_name = "avatar-default-symbolic"
                    }
                }).catch(e => console.error("[Users] copy avatar:", e))
            } catch { /* cancelled */ }
        })
    })

    const avatarRow = new Gtk.Box({ spacing: 16, valign: Gtk.Align.CENTER })
    avatarRow.append(avatarImg)
    avatarRow.append(changeAvatarBtn)
    avatarBox.append(avatarRow)
    profileGroup.listBox.append(createRow(t("settings.users.avatar"), "", avatarBox))

    // Display name
    const nameEntry = new Gtk.Entry({
        text: displayName,
        placeholder_text: username,
        width_chars: 22,
        valign: Gtk.Align.CENTER,
    })
    const nameApplyBtn = new Gtk.Button({
        label: t("settings.users.name.apply"),
        css_classes: ["suggested-action"],
        valign: Gtk.Align.CENTER,
    })
    const applyName = () => {
        const name = nameEntry.text.trim()
        if (!name) return
        nameApplyBtn.sensitive = false
        execAsync(["chfn", "-f", name, username])
            .catch(e => console.error("[Users] chfn:", e))
            .finally(() => { nameApplyBtn.sensitive = true })
    }
    nameApplyBtn.connect("clicked", applyName)
    nameEntry.connect("activate", applyName)

    const nameRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    nameRow.append(nameEntry)
    nameRow.append(nameApplyBtn)
    profileGroup.listBox.append(createRow(
        t("settings.users.name"),
        t("settings.users.name.desc"),
        nameRow,
    ))

    // Username (read-only info)
    profileGroup.listBox.append(createRow(
        t("settings.users.username"),
        "",
        new Gtk.Label({ label: username, css_classes: ["settings-row-subtitle"], valign: Gtk.Align.CENTER }),
    ))

    page.append(profileGroup.box)

    // ── Security ──────────────────────────────────────────────────────────────
    const secGroup = listGroup(t("settings.users.group.security"))

    const pwBtn = new Gtk.Button({
        label: t("settings.users.password.change"),
        css_classes: ["pill"],
        valign: Gtk.Align.CENTER,
    })
    pwBtn.connect("clicked", () => spawnTerminalWithCommand(`passwd; echo; echo "${t("settings.users.password.done")}"; read`))

    secGroup.listBox.append(createRow(
        t("settings.users.password"),
        t("settings.users.password.desc"),
        pwBtn,
    ))

    page.append(secGroup.box)

    return page
}
