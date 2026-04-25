import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import { execAsync } from "ags/process"
import { listGroup, createRow, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

// ── Data helpers ──────────────────────────────────────────────────────────────

interface SystemUser {
    username: string
    displayName: string
    homeDir: string
    uid: number
}

function parseUsers(): SystemUser[] {
    try {
        const [ok, bytes] = GLib.file_get_contents("/etc/passwd")
        if (!ok) return []
        const text = new TextDecoder().decode(bytes as Uint8Array)
        return text.split("\n").flatMap(line => {
            const p = line.split(":")
            if (p.length < 7) return []
            const uid = parseInt(p[2])
            const shell = p[6].trim()
            if (uid < 1000 || !shell || shell.includes("nologin") || shell.includes("false")) return []
            return [{ username: p[0], displayName: (p[4] ?? "").split(",")[0].trim() || p[0], homeDir: p[5] ?? "", uid }]
        })
    } catch { return [] }
}

function isInWheel(username: string): boolean {
    try {
        const [ok, bytes] = GLib.file_get_contents("/etc/group")
        if (!ok) return false
        const text = new TextDecoder().decode(bytes as Uint8Array)
        for (const line of text.split("\n")) {
            const p = line.split(":")
            if (p[0] === "wheel") return (p[3] ?? "").split(",").includes(username)
        }
    } catch {}
    return false
}

function avatarFor(username: string, homeDir: string): string | null {
    const accounts = `/var/lib/AccountsService/icons/${username}`
    const face     = `${homeDir}/.face`
    if (GLib.file_test(accounts, GLib.FileTest.EXISTS)) return accounts
    if (GLib.file_test(face,     GLib.FileTest.EXISTS)) return face
    return null
}

// ── Current-user helpers ──────────────────────────────────────────────────────

function getDisplayName(): string {
    try {
        const n = GLib.get_real_name()
        return n ? n.split(",")[0].trim() : GLib.get_user_name() ?? ""
    } catch { return GLib.get_user_name() ?? "" }
}

function saveAvatar(srcPath: string): Promise<void> {
    const face = `${GLib.get_home_dir()}/.face`
    return execAsync(["cp", srcPath, face]).then(() => {
        try {
            const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
            const res = bus.call_sync(
                "org.freedesktop.Accounts", "/org/freedesktop/Accounts",
                "org.freedesktop.Accounts", "FindUserByName",
                new GLib.Variant("(s)", [GLib.get_user_name()]),
                new GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 2000, null,
            )
            const userPath = res.get_child_value(0).get_string()[0]
            bus.call_sync(
                "org.freedesktop.Accounts", userPath,
                "org.freedesktop.Accounts.User", "SetIconFile",
                new GLib.Variant("(s)", [face]),
                null, Gio.DBusCallFlags.NONE, 5000, null,
            )
        } catch { /* AccountsService not available */ }
    })
}

function spawnTerminalWithCommand(cmd: string) {
    const map: Record<string, string[]> = {
        kitty:          ["kitty", "--", "bash", "-c", cmd],
        alacritty:      ["alacritty", "-e", "bash", "-c", cmd],
        wezterm:        ["wezterm", "start", "--", "bash", "-c", cmd],
        foot:           ["foot", "bash", "-c", cmd],
        "gnome-terminal": ["gnome-terminal", "--", "bash", "-c", cmd],
        xterm:          ["xterm", "-e", "bash", "-c", cmd],
    }
    for (const term of Object.keys(map)) {
        if (GLib.find_program_in_path(term)) {
            execAsync(map[term]).catch(e => console.error("[Users]", e))
            return
        }
    }
    console.error("[Users] No terminal found")
}

// ── "Add user" dialog ─────────────────────────────────────────────────────────

function showAddUserDialog(parentWin: Gtk.Window | null, onCreated: () => void) {
    const dialog = new Gtk.Window({
        title: t("settings.users.other.add"),
        modal: true,
        transient_for: parentWin ?? undefined,
        resizable: false,
        default_width: 360,
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        margin_start: 24, margin_end: 24,
        margin_top: 24, margin_bottom: 24,
    })

    const nameEntry = new Gtk.Entry({ placeholder_text: t("settings.users.other.fullname.placeholder"), hexpand: true })
    const unameEntry = new Gtk.Entry({ placeholder_text: t("settings.users.other.username.placeholder"), hexpand: true })

    const adminRow = new Gtk.Box({ spacing: 12 })
    adminRow.append(new Gtk.Label({ label: t("settings.users.other.admin"), hexpand: true, halign: Gtk.Align.START }))
    const adminSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER })
    adminRow.append(adminSwitch)

    const statusLabel = new Gtk.Label({ label: "", css_classes: ["settings-row-subtitle"], halign: Gtk.Align.START, visible: false })

    const btnRow = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END })
    const cancelBtn = new Gtk.Button({ label: t("settings.users.other.cancel") })
    const createBtn = new Gtk.Button({ label: t("settings.users.other.create"), css_classes: ["suggested-action"] })
    btnRow.append(cancelBtn)
    btnRow.append(createBtn)

    box.append(new Gtk.Label({ label: t("settings.users.other.fullname"), halign: Gtk.Align.START, css_classes: ["settings-row-label"] }))
    box.append(nameEntry)
    box.append(new Gtk.Label({ label: t("settings.users.other.username"), halign: Gtk.Align.START, css_classes: ["settings-row-label"] }))
    box.append(unameEntry)
    box.append(adminRow)
    box.append(statusLabel)
    box.append(btnRow)
    dialog.set_child(box)

    cancelBtn.connect("clicked", () => dialog.close())

    createBtn.connect("clicked", () => {
        const uname = unameEntry.text.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "")
        const fname = nameEntry.text.trim()
        if (!uname) { statusLabel.label = t("settings.users.other.err.username"); statusLabel.visible = true; return }

        createBtn.sensitive = false
        statusLabel.visible = false

        const cmd = adminSwitch.active
            ? ["pkexec", "useradd", "-m", "-G", "wheel", "-c", fname, uname]
            : ["pkexec", "useradd", "-m", "-c", fname, uname]

        execAsync(cmd).then(() => {
            dialog.close()
            onCreated()
            spawnTerminalWithCommand(`pkexec passwd ${uname}; echo; read -p "${t("settings.users.password.done")}"`)
        }).catch(e => {
            console.error("[Users] useradd:", e)
            statusLabel.label = t("settings.users.other.err.create")
            statusLabel.visible = true
            createBtn.sensitive = true
        })
    })

    dialog.present()
}

// ── Other-user row ─────────────────────────────────────────────────────────────

function buildUserRow(user: SystemUser, parentWin: Gtk.Window | null, onRefresh: () => void): Gtk.ListBoxRow {
    const admin = isInWheel(user.username)
    const avatar = avatarFor(user.username, user.homeDir)

    const avatarImg = new Gtk.Image({ pixel_size: 36, css_classes: ["users-avatar-sm"], valign: Gtk.Align.CENTER })
    if (avatar) { try { avatarImg.set_from_file(avatar) } catch { avatarImg.icon_name = "avatar-default-symbolic" } }
    else avatarImg.icon_name = "avatar-default-symbolic"

    const nameBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER })
    nameBox.append(new Gtk.Label({ label: user.displayName, css_classes: ["settings-row-label"], halign: Gtk.Align.START }))
    nameBox.append(new Gtk.Label({ label: user.username, css_classes: ["settings-row-subtitle"], halign: Gtk.Align.START }))

    const adminBadge = new Gtk.Label({
        label: t("settings.users.other.admin-badge"),
        css_classes: ["users-admin-badge"],
        valign: Gtk.Align.CENTER,
        visible: admin,
    })

    const adminToggle = new Gtk.Switch({ active: admin, valign: Gtk.Align.CENTER, tooltip_text: t("settings.users.other.admin.tip") })
    adminToggle.connect("state-set", (_: any, state: boolean) => {
        const cmd = state
            ? ["pkexec", "usermod", "-aG", "wheel", user.username]
            : ["pkexec", "gpasswd", "-d", user.username, "wheel"]
        execAsync(cmd).then(() => {
            adminBadge.visible = state
        }).catch(e => {
            console.error("[Users] admin toggle:", e)
            adminToggle.active = !state  // revert
        })
        return false
    })

    const deleteBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "user-trash-symbolic", pixel_size: 14 }),
        css_classes: ["crystal-icon-btn"],
        valign: Gtk.Align.CENTER,
        tooltip_text: t("settings.users.other.delete"),
    })
    deleteBtn.connect("clicked", () => {
        const alert = new Adw.AlertDialog({
            heading: t("settings.users.other.delete.confirm.title"),
            body: `${t("settings.users.other.delete.confirm.body")} "${user.displayName}" (${user.username})?`,
        })
        alert.add_response("cancel", t("settings.users.other.cancel"))
        alert.add_response("delete", t("settings.users.other.delete"))
        alert.set_response_appearance("delete", Adw.ResponseAppearance.DESTRUCTIVE)
        alert.set_default_response("cancel")
        alert.connect("response", (_: any, id: string) => {
            if (id !== "delete") return
            execAsync(["pkexec", "userdel", "-r", user.username])
                .then(onRefresh)
                .catch(e => console.error("[Users] userdel:", e))
        })
        alert.present(parentWin ?? undefined)
    })

    const inner = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 10 })
    inner.append(avatarImg)
    inner.append(nameBox)
    inner.append(adminBadge)
    inner.append(adminToggle)
    inner.append(deleteBtn)

    const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
    row.set_child(inner)
    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsersPage() {
    const page = pageBox("users-page")
    page.append(pageHeader(t("settings.users.title"), t("settings.users.subtitle")))

    const username    = GLib.get_user_name() ?? ""
    const displayName = getDisplayName()
    const avatarPath  = avatarFor(username, GLib.get_home_dir() ?? "")

    // ── Your Account ─────────────────────────────────────────────────────────
    const profileGroup = listGroup(t("settings.users.group.profile"))

    const avatarImg = new Gtk.Image({ pixel_size: 56, css_classes: ["users-avatar"], valign: Gtk.Align.CENTER })
    if (avatarPath) { try { avatarImg.set_from_file(avatarPath) } catch { avatarImg.icon_name = "avatar-default-symbolic" } }
    else avatarImg.icon_name = "avatar-default-symbolic"

    const changeAvatarBtn = new Gtk.Button({ label: t("settings.users.avatar.change"), css_classes: ["pill"], valign: Gtk.Align.CENTER })
    changeAvatarBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({ title: t("settings.users.avatar.pick"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg"); filter.add_mime_type("image/png"); filter.add_mime_type("image/webp")
        filter.set_name(t("settings.users.avatar.filter"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)
        dialog.open(null, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const src = file?.get_path()
                if (!src) return
                saveAvatar(src).then(() => {
                    try { avatarImg.set_from_file(`${GLib.get_home_dir()}/.face`) }
                    catch { avatarImg.icon_name = "avatar-default-symbolic" }
                }).catch(e => console.error("[Users]", e))
            } catch { /* cancelled */ }
        })
    })

    const avatarRow = new Gtk.Box({ spacing: 16, valign: Gtk.Align.CENTER })
    avatarRow.append(avatarImg); avatarRow.append(changeAvatarBtn)
    profileGroup.listBox.append(createRow(t("settings.users.avatar"), "", avatarRow))

    const nameEntry = new Gtk.Entry({ text: displayName, placeholder_text: username, width_chars: 22, valign: Gtk.Align.CENTER })
    const nameApplyBtn = new Gtk.Button({ label: t("settings.users.name.apply"), css_classes: ["suggested-action"], valign: Gtk.Align.CENTER })
    const applyName = () => {
        const n = nameEntry.text.trim(); if (!n) return
        nameApplyBtn.sensitive = false
        execAsync(["chfn", "-f", n, username]).catch(e => console.error("[Users]", e)).finally(() => { nameApplyBtn.sensitive = true })
    }
    nameApplyBtn.connect("clicked", applyName); nameEntry.connect("activate", applyName)
    const nameRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    nameRow.append(nameEntry); nameRow.append(nameApplyBtn)
    profileGroup.listBox.append(createRow(t("settings.users.name"), t("settings.users.name.desc"), nameRow))
    profileGroup.listBox.append(createRow(
        t("settings.users.username"), "",
        new Gtk.Label({ label: username, css_classes: ["settings-row-subtitle"], valign: Gtk.Align.CENTER }),
    ))
    page.append(profileGroup.box)

    // ── Security ──────────────────────────────────────────────────────────────
    const secGroup = listGroup(t("settings.users.group.security"))
    const pwBtn = new Gtk.Button({ label: t("settings.users.password.change"), css_classes: ["pill"], valign: Gtk.Align.CENTER })
    pwBtn.connect("clicked", () => spawnTerminalWithCommand(`passwd; read -p "${t("settings.users.password.done")}"`) )
    secGroup.listBox.append(createRow(t("settings.users.password"), t("settings.users.password.desc"), pwBtn))
    page.append(secGroup.box)

    // ── Other Users ───────────────────────────────────────────────────────────
    const otherGroup = listGroup(t("settings.users.group.other"))
    const otherList  = otherGroup.listBox

    // Resolve the parent window lazily (needed for transient dialogs)
    let parentWin: Gtk.Window | null = null
    page.connect("realize", () => {
        let w = page.get_root() as any
        parentWin = w instanceof Gtk.Window ? w : null
    })

    const rebuildOtherUsers = () => {
        while (otherList.get_first_child()) otherList.get_first_child()!.unparent()

        const others = parseUsers().filter(u => u.username !== username)
        if (others.length === 0) {
            const emptyRow = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            emptyRow.set_child(new Gtk.Label({
                label: t("settings.users.other.empty"),
                css_classes: ["settings-row-subtitle"],
                margin_start: 16, margin_top: 12, margin_bottom: 12,
                halign: Gtk.Align.START,
            }))
            otherList.append(emptyRow)
        } else {
            others.forEach(u => otherList.append(buildUserRow(u, parentWin, rebuildOtherUsers)))
        }

        // Add User row — uses a flat Button so click always works regardless of SelectionMode
        const addBtn = new Gtk.Button({
            css_classes: ["settings-action-row"],
            hexpand: true,
        })
        const addInner = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 10 })
        addInner.append(new Gtk.Image({ icon_name: "list-add-symbolic", pixel_size: 16, opacity: 0.7 }))
        addInner.append(new Gtk.Label({ label: t("settings.users.other.add"), css_classes: ["settings-row-label"], halign: Gtk.Align.START }))
        addBtn.set_child(addInner)
        addBtn.connect("clicked", () => showAddUserDialog(parentWin, rebuildOtherUsers))
        const addRow = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        addRow.set_child(addBtn)
        otherList.append(addRow)
    }
    rebuildOtherUsers()
    page.append(otherGroup.box)

    return page
}
