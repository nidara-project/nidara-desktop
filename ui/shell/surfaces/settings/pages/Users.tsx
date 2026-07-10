import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import { execAsync } from "ags/process"
import { showNidaraAlert, NidaraButton } from "../../../../lib/nidara-kit"
import { getUsers, getCurrentUser, type User } from "../../../../lib/users"
import { listGroup, createRow, pageBox } from "../SettingsHelpers"
import { showAvatarCropper } from "../../../common/AvatarCropper"
import { attachTooltip } from "../../../common/Tooltip"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"

// ── Data helpers ──────────────────────────────────────────────────────────────
// User enumeration + avatar resolution come from the shared ui/lib/users.ts
// (same source the greeter and lockscreen use), so all three surfaces agree on
// the displayed name — including the GECOS→username fallback.

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

// Register the written ~/.face with AccountsService so the greeter / other DEs pick
// it up too (best-effort — fine if the service isn't running).
function applyFaceToAccounts(face: string) {
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
}

// Save an already-cropped square pixbuf as the user's avatar.
function saveAvatarPixbuf(pixbuf: any) {
    const face = `${GLib.get_home_dir()}/.face`
    try { pixbuf.savev(face, "png", [], []) } catch (e) { console.error("[Users] save avatar:", e); return }
    applyFaceToAccounts(face)
}

// Set the user's full name (GECOS) via AccountsService, same path as the avatar.
// chfn(1) can't be used non-interactively — it requires a PAM password prompt and
// fails with no tty. AccountsService.SetRealName goes through polkit's
// change-own-user-data action, which the active user is allowed to do.
function setRealName(name: string): boolean {
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
            "org.freedesktop.Accounts.User", "SetRealName",
            new GLib.Variant("(s)", [name]),
            null, Gio.DBusCallFlags.NONE, 5000, null,
        )
        return true
    } catch (e) {
        console.error("[Users] SetRealName:", e)
        return false
    }
}

// Resolve the window a widget lives in AT INTERACTION TIME. Rows are built
// before the page is realized, so a window captured at build time is null —
// and GJS refuses `transient_for: undefined` outright (the dialog then never
// opens: the constructor throws before present()).
function windowOf(w: Gtk.Widget): Gtk.Window | null {
    const root = w.get_root()
    return root instanceof Gtk.Window ? (root as unknown as Gtk.Window) : null
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
        resizable: false,
        default_width: 380,
    })
    if (parentWin) dialog.set_transient_for(parentWin)

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_start: 24, margin_end: 24,
        margin_top: 24, margin_bottom: 24,
    })

    const field = (label: string, widget: Gtk.Widget) => {
        const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
        vbox.append(new Gtk.Label({ label, halign: Gtk.Align.START, css_classes: ["nidara-row-title"] }))
        vbox.append(widget)
        return vbox
    }

    const nameEntry  = new Gtk.Entry({ placeholder_text: t("settings.users.other.fullname.placeholder"), hexpand: true })
    const unameEntry = new Gtk.Entry({ placeholder_text: t("settings.users.other.username.placeholder"), hexpand: true })
    const pwEntry    = new Gtk.PasswordEntry({ show_peek_icon: true, hexpand: true,
        placeholder_text: t("settings.users.other.pw.placeholder") })
    const pw2Entry   = new Gtk.PasswordEntry({ show_peek_icon: true, hexpand: true,
        placeholder_text: t("settings.users.other.pw2.placeholder") })

    const adminRow = new Gtk.Box({ spacing: 12, margin_top: 4 })
    adminRow.append(new Gtk.Label({ label: t("settings.users.other.admin"), hexpand: true, halign: Gtk.Align.START }))
    const adminSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER })
    adminRow.append(adminSwitch)

    const statusLabel = new Gtk.Label({ label: "", css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.START, visible: false, wrap: true })

    const btnRow = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END, margin_top: 4 })
    const cancelBtn = NidaraButton({ label: t("settings.users.other.cancel"), variant: "secondary", pill: true })
    const createBtn = NidaraButton({ label: t("settings.users.other.create"), variant: "primary", pill: true, sensitive: false })
    btnRow.append(cancelBtn)
    btnRow.append(createBtn)

    box.append(field(t("settings.users.other.fullname"), nameEntry))
    box.append(field(t("settings.users.other.username"), unameEntry))
    box.append(field(t("settings.users.other.pw"),  pwEntry))
    box.append(field(t("settings.users.other.pw2"), pw2Entry))
    box.append(adminRow)
    box.append(statusLabel)
    box.append(btnRow)
    dialog.set_child(box)

    const validateCreate = () => {
        const uname = unameEntry.text.trim()
        const pw  = pwEntry.text
        const pw2 = pw2Entry.text
        // A blank password is allowed: the account is created locked, as the
        // password placeholder promises.
        createBtn.sensitive = uname.length > 0 && pw === pw2
        if (pw2.length > 0 && pw !== pw2) {
            statusLabel.label = t("settings.users.other.err.pwmatch"); statusLabel.visible = true
        } else { statusLabel.visible = false }
    }
    unameEntry.connect("notify::text", validateCreate)
    pwEntry.connect("notify::text",    validateCreate)
    pw2Entry.connect("notify::text",   validateCreate)

    cancelBtn.connect("clicked", () => dialog.close())

    // useradd succeeded but chpasswd is still pending/failed — a re-click must
    // retry only the password step, never a second useradd.
    let created = false

    createBtn.connect("clicked", () => {
        const uname = unameEntry.text.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "")
        // ':' and newlines would corrupt the passwd GECOS entry — useradd rejects
        // them with an unhelpful generic error, so strip them up front.
        const fname = nameEntry.text.trim().replace(/[:\n\r]/g, "")
        const pw    = pwEntry.text

        createBtn.sensitive = false
        statusLabel.visible = false

        const setPassword = () => {
            const proc = Gio.Subprocess.new(["pkexec", "chpasswd"], Gio.SubprocessFlags.STDIN_PIPE)
            proc.communicate_utf8_async(`${uname}:${pw}\n`, null, (_: any, res: any) => {
                // finish() only throws on IO errors — a non-zero exit (e.g. the
                // pkexec prompt was cancelled) must be read from get_successful().
                let ok = false
                try { proc.communicate_utf8_finish(res); ok = proc.get_successful() }
                catch (e) { console.error("[Users] chpasswd:", e) }
                if (ok) { dialog.close(); return }
                statusLabel.label = t("settings.users.other.err.pw-set")
                statusLabel.visible = true
                createBtn.sensitive = true
            })
        }

        if (created) { setPassword(); return }

        const addCmd = ["pkexec", "useradd", "-m",
            ...(adminSwitch.active ? ["-G", "wheel"] : []),
            ...(fname ? ["-c", fname] : []),
            uname]

        execAsync(addCmd).then(() => {
            created = true
            // The account exists now whatever happens to the password — freeze
            // its identity fields and refresh the list behind the dialog.
            nameEntry.sensitive = false
            unameEntry.sensitive = false
            adminSwitch.sensitive = false
            onCreated()
            if (pw.length === 0) { dialog.close(); return }
            setPassword()
        }).catch(e => {
            console.error("[Users] useradd:", e)
            statusLabel.label = String(e?.message ?? e).includes("already exists")
                ? t("settings.users.other.err.exists")
                : t("settings.users.other.err.create")
            statusLabel.visible = true
            createBtn.sensitive = true
        })
    })

    dialog.present()
}

// ── "Change password" dialog ──────────────────────────────────────────────────

function showChangePasswordDialog(user: User, parentWin: Gtk.Window | null) {
    const dialog = new Gtk.Window({
        title: `${t("settings.users.other.pw.change")} — ${user.displayName}`,
        modal: true,
        resizable: false,
        default_width: 360,
    })
    if (parentWin) dialog.set_transient_for(parentWin)

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_start: 24, margin_end: 24,
        margin_top: 24, margin_bottom: 24,
    })

    const field = (label: string, widget: Gtk.Widget) => {
        const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
        vbox.append(new Gtk.Label({ label, halign: Gtk.Align.START, css_classes: ["nidara-row-title"] }))
        vbox.append(widget)
        return vbox
    }

    const pwEntry  = new Gtk.PasswordEntry({ show_peek_icon: true, hexpand: true })
    const pw2Entry = new Gtk.PasswordEntry({ show_peek_icon: true, hexpand: true })

    const statusLabel = new Gtk.Label({ label: "", css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.START, visible: false, wrap: true })

    const btnRow = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END, margin_top: 4 })
    const cancelBtn = NidaraButton({ label: t("settings.users.other.cancel"), variant: "secondary", pill: true })
    const applyBtn  = NidaraButton({ label: t("settings.users.other.pw.apply"), variant: "primary", pill: true, sensitive: false })
    btnRow.append(cancelBtn)
    btnRow.append(applyBtn)

    const validate = () => {
        const pw = pwEntry.text; const pw2 = pw2Entry.text
        applyBtn.sensitive = pw.length > 0 && pw === pw2
        if (pw2.length > 0 && pw !== pw2) {
            statusLabel.label = t("settings.users.other.err.pwmatch"); statusLabel.visible = true
        } else { statusLabel.visible = false }
    }
    pwEntry.connect("notify::text",  validate)
    pw2Entry.connect("notify::text", validate)

    box.append(field(t("settings.users.other.pw"),  pwEntry))
    box.append(field(t("settings.users.other.pw2"), pw2Entry))
    box.append(statusLabel)
    box.append(btnRow)
    dialog.set_child(box)

    cancelBtn.connect("clicked", () => dialog.close())

    applyBtn.connect("clicked", () => {
        const pw = pwEntry.text
        applyBtn.sensitive = false
        statusLabel.visible = false

        const proc = Gio.Subprocess.new(["pkexec", "chpasswd"], Gio.SubprocessFlags.STDIN_PIPE)
        proc.communicate_utf8_async(`${user.username}:${pw}\n`, null, (_: any, res: any) => {
            // finish() only throws on IO errors — a non-zero exit (e.g. the
            // pkexec prompt was cancelled) must be read from get_successful().
            let ok = false
            try { proc.communicate_utf8_finish(res); ok = proc.get_successful() }
            catch (e) { console.error("[Users] chpasswd:", e) }
            if (ok) { dialog.close(); return }
            statusLabel.label = t("settings.users.other.err.pw")
            statusLabel.visible = true
            applyBtn.sensitive = true
        })
    })

    dialog.present()
}

// ── Other-user row ─────────────────────────────────────────────────────────────

function buildUserRow(user: User, onRefresh: () => void): Gtk.ListBoxRow {
    const admin = isInWheel(user.username)

    const avatarImg = new Gtk.Image({ pixel_size: 36, css_classes: ["users-avatar-sm"], valign: Gtk.Align.CENTER })
    // The glyph fallback needs .nd-icon (dark-mode invert filter) — but only the
    // glyph: the same filter would invert a real photo.
    const showGlyph = () => { avatarImg.gicon = Icons.userRound; avatarImg.add_css_class("nd-icon") }
    if (user.avatarPath) { try { avatarImg.set_from_file(user.avatarPath) } catch { showGlyph() } }
    else showGlyph()

    const nameBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER })
    nameBox.append(new Gtk.Label({ label: user.displayName, css_classes: ["nidara-row-title"], halign: Gtk.Align.START }))
    nameBox.append(new Gtk.Label({ label: user.username, css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.START }))

    // Always-visible label for the switch — an unlabeled toggle in the row reads
    // as a mystery control (VM pass feedback). It also replaces the old "Admin"
    // badge, which duplicated what the switch position already says.
    const adminLabel = new Gtk.Label({
        label: t("settings.users.other.admin"),
        css_classes: ["nidara-row-subtitle"],
        valign: Gtk.Align.CENTER,
    })

    const adminToggle = new Gtk.Switch({ active: admin, valign: Gtk.Align.CENTER })
    attachTooltip(adminToggle, t("settings.users.other.admin.tip"), { chrome: false })
    let reverting = false
    adminToggle.connect("state-set", (_: any, state: boolean) => {
        // The programmatic revert below re-enters this handler; without the guard
        // it fired the OPPOSITE pkexec prompt, and cancelling that reverted again —
        // an endless auth-prompt loop once the user dismissed the first dialog.
        if (reverting) return false
        const cmd = state
            ? ["pkexec", "usermod", "-aG", "wheel", user.username]
            : ["pkexec", "gpasswd", "-d", user.username, "wheel"]
        execAsync(cmd).catch(e => {
            console.error("[Users] admin toggle:", e)
            reverting = true
            adminToggle.active = !state
            reverting = false
        })
        return false
    })

    const pwBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.key, pixel_size: 14 , css_classes: ["nd-icon"] }),
        css_classes: ["nidara-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    attachTooltip(pwBtn, t("settings.users.other.pw.change"), { chrome: false })
    pwBtn.connect("clicked", () => showChangePasswordDialog(user, windowOf(pwBtn)))

    const deleteBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.trash, pixel_size: 14 , css_classes: ["nd-icon"] }),
        css_classes: ["nidara-icon-btn"],
        valign: Gtk.Align.CENTER,
    })
    attachTooltip(deleteBtn, t("settings.users.other.delete"), { chrome: false })
    deleteBtn.connect("clicked", () => {
        showNidaraAlert({
            parent: windowOf(deleteBtn),
            heading: t("settings.users.other.delete.confirm.title"),
            body: `${t("settings.users.other.delete.confirm.body")} "${user.displayName}" (${user.username})?`,
            responses: [
                { id: "cancel", label: t("settings.users.other.cancel") },
                { id: "delete", label: t("settings.users.other.delete"), destructive: true },
            ],
            onResponse: (id) => {
                if (id !== "delete") return
                execAsync(["pkexec", "userdel", "-r", user.username])
                    .then(onRefresh)
                    .catch(e => console.error("[Users] userdel:", e))
            },
        })
    })

    const inner = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 10 })
    inner.append(avatarImg)
    inner.append(nameBox)
    inner.append(adminLabel)
    inner.append(adminToggle)
    inner.append(pwBtn)
    inner.append(deleteBtn)

    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
    row.set_child(inner)
    return row
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsersPage() {
    const page = pageBox("users-page")

    const me = getCurrentUser()
    const { username, displayName } = me
    const avatarPath = me.avatarPath

    // ── Your Account ─────────────────────────────────────────────────────────
    const profileGroup = listGroup(t("settings.users.group.profile"))

    // Large circular avatar: Gtk.Picture (COVER crops to fill the square, then the
    // pill border-radius clips it to a circle) — same approach as the wallpaper
    // preview in Appearance. A user-glyph overlay shows on the surface circle when
    // there's no photo.
    const AVATAR_SIZE = 112
    const avatarPicture = new Gtk.Picture({
        width_request: AVATAR_SIZE,
        height_request: AVATAR_SIZE,
        // SCALE_DOWN (not COVER) is the fix: COVER's height-for-width grows with the
        // proposed width — the row measures the Picture at the full card width, so
        // COVER reported a ~720px natural height and the row became that tall (the
        // avatar then sat 96px-centered in it). SCALE_DOWN never upscales, so the
        // natural stays the paintable's size (we pre-crop it to 96²). No growth.
        content_fit: Gtk.ContentFit.SCALE_DOWN,
        // can_shrink defaults TRUE, letting the Picture compress below 96 when the
        // window gets short (instead of the page scrolling). Pin it so the avatar
        // keeps its size and the ScrolledWindow takes over.
        can_shrink: false,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: false,
        vexpand: false,
        css_classes: ["users-avatar"],
    })
    // Glyph placeholder when there's no photo — same circular footprint.
    const avatarFallback = new Gtk.Image({
        gicon: Icons.userRound,
        pixel_size: 60,
        width_request: AVATAR_SIZE,
        height_request: AVATAR_SIZE,
        halign: Gtk.Align.CENTER,
        css_classes: ["nd-icon", "users-avatar", "users-avatar-fallback"],
    })

    // The avatar lives DIRECTLY as a ListBoxRow child, exactly like the wallpaper
    // preview in Appearance. A Gtk.Picture wrapped in a halign:CENTER box reports a
    // height-for-width natural that the page's clamp over-allocates (opening a big
    // vertical gap); as the row's direct child, its width/height_request pin it.
    const avatarRow = new Gtk.ListBoxRow({ activatable: false, selectable: false, css_classes: ["users-avatar-row"] })
    profileGroup.listBox.append(avatarRow)

    const setAvatar = (path: string | null) => {
        if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) {
            try {
                let pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
                // Center-crop to a square, then scale to AVATAR_SIZE so the paintable
                // is exactly 96² (keeps SCALE_DOWN from leaving the avatar at the
                // image's own size, and crops non-square photos into the circle).
                const w = pixbuf.get_width(), h = pixbuf.get_height()
                const side = Math.min(w, h)
                if (w !== h) pixbuf = pixbuf.new_subpixbuf((w - side) >> 1, (h - side) >> 1, side, side)
                pixbuf = pixbuf.scale_simple(AVATAR_SIZE, AVATAR_SIZE, GdkPixbuf.InterpType.BILINEAR)!
                avatarPicture.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
                avatarRow.set_child(avatarPicture)
                return
            } catch (_) { /* fall through to placeholder */ }
        }
        avatarRow.set_child(avatarFallback)
    }
    setAvatar(avatarPath)

    const changeAvatarBtn = NidaraButton({ label: t("settings.users.avatar.change"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })
    changeAvatarBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({ title: t("settings.users.avatar.pick"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg"); filter.add_mime_type("image/png"); filter.add_mime_type("image/webp")
        filter.set_name(t("settings.users.avatar.filter"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)
        const win = changeAvatarBtn.get_root() as Gtk.Window
        dialog.open(win, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const src = file?.get_path()
                if (!src) return
                // Let the user frame/zoom the photo into the circle before saving.
                showAvatarCropper(win, src, (cropped) => {
                    saveAvatarPixbuf(cropped)
                    setAvatar(`${GLib.get_home_dir()}/.face`)
                })
            } catch { /* cancelled */ }
        })
    })

    // Change-avatar button — its own centered row, directly under the avatar row.
    // (Kept out of a wrapping box so nothing reintroduces the Picture stretch.)
    changeAvatarBtn.margin_top = 4
    changeAvatarBtn.margin_bottom = 10
    const changeRow = new Gtk.ListBoxRow({ activatable: false, selectable: false, css_classes: ["users-avatar-row"] })
    changeRow.set_child(changeAvatarBtn)
    profileGroup.listBox.append(changeRow)

    const nameEntry = new Gtk.Entry({ text: displayName, placeholder_text: username, width_chars: 22, valign: Gtk.Align.CENTER })
    const nameApplyBtn = NidaraButton({ label: t("settings.users.name.apply"), variant: "primary", pill: true, valign: Gtk.Align.CENTER })
    const applyName = () => {
        const n = nameEntry.text.trim(); if (!n) return
        nameApplyBtn.sensitive = false
        setRealName(n)
        nameApplyBtn.sensitive = true
    }
    nameApplyBtn.connect("clicked", applyName); nameEntry.connect("activate", applyName)
    const nameRow = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    nameRow.append(nameEntry); nameRow.append(nameApplyBtn)
    profileGroup.listBox.append(createRow(t("settings.users.name"), t("settings.users.name.desc"), nameRow))
    profileGroup.listBox.append(createRow(
        t("settings.users.username"), "",
        new Gtk.Label({ label: username, css_classes: ["nidara-row-subtitle"], valign: Gtk.Align.CENTER }),
    ))
    page.append(profileGroup.box)

    // ── Security ──────────────────────────────────────────────────────────────
    const secGroup = listGroup(t("settings.users.group.security"))
    const pwBtn = NidaraButton({ label: t("settings.users.password.change"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
    pwBtn.connect("clicked", () => spawnTerminalWithCommand(`passwd; read -p "${t("settings.users.password.done")}"`) )
    secGroup.listBox.append(createRow(t("settings.users.password"), t("settings.users.password.desc"), pwBtn))
    page.append(secGroup.box)

    // ── Other Users ───────────────────────────────────────────────────────────
    const otherGroup = listGroup(t("settings.users.group.other"))
    const otherList  = otherGroup.listBox

    const rebuildOtherUsers = () => {
        // Rows must be removed through the ListBox (remove_all), never unparent()ed
        // directly: that leaves the box's internal row bookkeeping stale and every
        // later append() dies on a gtk_widget_insert_after assertion (empty list).
        otherList.remove_all()

        const others = getUsers().filter(u => u.username !== username)
        if (others.length === 0) {
            const emptyRow = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
            emptyRow.set_child(new Gtk.Label({
                label: t("settings.users.other.empty"),
                css_classes: ["nidara-row-subtitle"],
                margin_start: 16, margin_top: 12, margin_bottom: 12,
                halign: Gtk.Align.START,
            }))
            otherList.append(emptyRow)
        } else {
            others.forEach(u => otherList.append(buildUserRow(u, rebuildOtherUsers)))
        }

        // Add User row — uses a flat Button so click always works regardless of SelectionMode
        const addBtn = new Gtk.Button({
            css_classes: ["settings-action-row"],
            hexpand: true,
        })
        const addInner = new Gtk.Box({ spacing: 10, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 10 })
        addInner.append(new Gtk.Image({ gicon: Icons.userRoundPlus, pixel_size: 20, opacity: 0.7 , css_classes: ["nd-icon"] }))
        addInner.append(new Gtk.Label({ label: t("settings.users.other.add"), css_classes: ["nidara-row-title"], halign: Gtk.Align.START }))
        addBtn.set_child(addInner)
        addBtn.connect("clicked", () => showAddUserDialog(windowOf(addBtn), rebuildOtherUsers))
        const addRow = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
        addRow.set_child(addBtn)
        otherList.append(addRow)
    }
    rebuildOtherUsers()
    page.append(otherGroup.box)

    return page
}
