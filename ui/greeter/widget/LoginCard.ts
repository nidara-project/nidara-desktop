import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import { getSessions } from "../lib/sessions"
import { getUsers, type User } from "../../lib/users"
import { greeterPrefs, savePrefs } from "../lib/greeter-prefs"
import { makeAvatar } from "../../lib/avatar"
import { greetdLogin, AuthError } from "../lib/greetd"
import { t, onLocaleChange } from "../lib/i18n"

export default function LoginCard(): Gtk.Widget {
  const sessions = getSessions()
  const users = getUsers()
  const fallback: User = { username: "user", displayName: "User", avatarPath: null, homeDir: "" }
  // Preselect the last user who logged in from this greeter. Match against the
  // `users` array (not a fresh getUsers() call): the switcher chips compare by
  // object identity.
  let activeUser: User = users.find(u => u.username === greeterPrefs.lastUser) ?? users[0] ?? fallback

  let sessionIdx = Math.max(0, sessions.findIndex(s => s.id === "nidara"))
  let isAuthenticating = false

  const avatar = makeAvatar(80)
  avatar.setSource(activeUser.avatarPath)

  const usernameLabel = new Gtk.Label({
    label: activeUser.displayName,
    css_classes: ["greeter-username"],
    halign: Gtk.Align.CENTER,
    margin_top: 12,
  })

  const passwordEntry = new Gtk.PasswordEntry({
    placeholder_text: t("password"),
    show_peek_icon: true,
    css_classes: ["greeter-password"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
    margin_top: 28,
  })

  // Login button — spinner + label so auth shows live progress, not just text.
  const loginSpinner = new Gtk.Spinner({ visible: false })
  const loginLabel = new Gtk.Label({ label: t("login") })
  const loginInner = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER })
  loginInner.append(loginSpinner)
  loginInner.append(loginLabel)
  const loginBtn = new Gtk.Button({
    css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
    margin_top: 10,
    child: loginInner,
  })

  // Session selector — Gtk.DropDown auto-positions its popover (no off-screen bug)
  const sessionNames = sessions.map(s => s.name)
  const sessionModel = new Gtk.StringList({ strings: sessionNames })
  // Compact centered pill (natural width) — a set-once control, kept visually
  // subordinate to the password field (decided 2026-07-02; prior art: GDM/SDDM
  // hide it in a corner, others have none).
  const sessionDrp = new Gtk.DropDown({
    model: sessionModel,
    halign: Gtk.Align.CENTER,
    margin_top: 14,
    css_classes: ["greeter-session-dropdown"],
  })
  sessionDrp.selected = sessionIdx
  sessionDrp.connect("notify::selected", () => {
    sessionIdx = sessionDrp.selected
  })

  const errorLabel = new Gtk.Label({
    label: "",
    css_classes: ["greeter-error"],
    visible: false,
    wrap: true,
    halign: Gtk.Align.CENTER,
    margin_top: 6,
  })

  // Caps Lock warning — read from the seat keyboard device (updates live via
  // notify::caps-lock-state, no laggy key-event polling).
  const capsLabel = new Gtk.Label({
    label: t("capsLock"),
    css_classes: ["greeter-caps"],
    visible: false,
    halign: Gtk.Align.CENTER,
    margin_top: 6,
  })
  const keyboard = Gdk.Display.get_default()?.get_default_seat()?.get_keyboard() ?? null
  const syncCaps = () => { if (keyboard) capsLabel.visible = keyboard.get_caps_lock_state() }
  if (keyboard) keyboard.connect("notify::caps-lock-state", syncCaps)

  // ── Auth logic ────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    loginBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    sessionDrp.sensitive = !loading
    loginLabel.label = loading ? t("authenticating") : t("login")
    loginSpinner.visible = loading
    if (loading) loginSpinner.start(); else loginSpinner.stop()
  }

  const showError = (msg: string) => {
    errorLabel.label = msg
    errorLabel.visible = true
    passwordEntry.add_css_class("greeter-shake")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      passwordEntry.remove_css_class("greeter-shake")
      return GLib.SOURCE_REMOVE
    })
  }

  const setActiveUser = (u: User) => {
    if (u === activeUser) return
    activeUser = u
    avatar.setSource(u.avatarPath)
    usernameLabel.label = u.displayName
    passwordEntry.set_text("")
    errorLabel.visible = false
    passwordEntry.grab_focus()
  }

  const doLogin = async () => {
    if (isAuthenticating) return
    const password = passwordEntry.get_text()
    if (!password) { passwordEntry.grab_focus(); return }

    const session = sessions[sessionIdx]
    if (!session) { showError(t("noSession")); return }

    setLoading(true)
    errorLabel.visible = false

    try {
      // greetdLogin (lib/greetd.ts) — NOT AstalGreet.login, which swallows
      // auth errors and made a wrong password quit the greeter (TTY flash,
      // no feedback). Only reaches quit() on a real session start.
      await greetdLogin(activeUser.username, password, session.exec)
      savePrefs({ lastUser: activeUser.username })
      app.quit()
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      console.error("[Greeter] login error:", msg)
      const isAuth = e instanceof AuthError && e.isAuthFailure
      showError(isAuth ? t("wrongPassword") : t("loginError"))
      // Re-enable BEFORE grabbing focus: grab_focus() on a still-insensitive
      // entry silently fails ("GtkText did not receive a focus-out event"
      // warning) and left the field unfocused after every failed attempt —
      // the next keystrokes went nowhere until the user clicked the field.
      setLoading(false)
      passwordEntry.set_text("")
      passwordEntry.grab_focus()
    }
  }

  passwordEntry.connect("activate", doLogin)
  loginBtn.connect("clicked", doLogin)

  const col = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    css_classes: ["greeter-card"],
  })

  col.append(avatar.widget)
  col.append(usernameLabel)
  col.append(passwordEntry)
  col.append(capsLabel)
  col.append(loginBtn)
  col.append(sessionDrp)
  col.append(errorLabel)

  // Multi-user switcher — only when more than one human user exists. Selecting a
  // chip swaps the active login target (avatar, name, password). One must stay
  // selected, so a chip can't be toggled off.
  if (users.length > 1) {
    const switcher = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 10,
      halign: Gtk.Align.CENTER,
      margin_top: 18,
      css_classes: ["greeter-user-switcher"],
    })
    const chips: Gtk.ToggleButton[] = []
    for (const u of users) {
      const chipAvatar = makeAvatar(36, ["greeter-chip-avatar"])
      chipAvatar.setSource(u.avatarPath)
      const chip = new Gtk.ToggleButton({
        child: chipAvatar.widget,
        active: u === activeUser,
        tooltip_text: u.displayName,
        css_classes: ["greeter-user-chip"],
      })
      chip.connect("toggled", () => {
        if (!chip.active) { if (u === activeUser) chip.active = true; return }
        // Update activeUser BEFORE deactivating the previous chip: its
        // handler fires synchronously and re-activates itself whenever it
        // still thinks it's the active user (the guard above) — which left
        // the accent border on the OLD chip until a second click.
        setActiveUser(u)
        for (const c of chips) if (c !== chip) c.active = false
      })
      chips.push(chip)
      switcher.append(chip)
    }
    col.append(switcher)
  }

  col.connect("map", () => {
    syncCaps()
    // Trigger the entrance fade on the next frame so the transition runs.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      col.add_css_class("greeter-card-shown")
      return GLib.SOURCE_REMOVE
    })
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      passwordEntry.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  })

  onLocaleChange(() => {
    passwordEntry.placeholder_text = t("password")
    capsLabel.label = t("capsLock")
    if (!isAuthenticating) loginLabel.label = t("login")
  })

  return col
}
