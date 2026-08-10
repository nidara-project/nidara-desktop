import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import { getSessions } from "../lib/sessions"
import { getUsers, type User } from "../../lib/users"
import { greeterPrefs, savePrefs } from "../lib/greeter-prefs"
import { makeAvatar } from "../../lib/avatar"
import { greetdLogin, AuthError } from "../lib/greetd"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { NidaraDropDown } from "../../lib/nidara-kit/scrolled"
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

  // Session selector — `NidaraDropDown` (kit): the native widget, so the popover
  // is still a real Wayland popup that auto-positions, but the list inside it is
  // the shell's — see LocaleBar.ts and style.scss.
  const sessionNames = sessions.map(s => s.name)
  const sessionModel = new Gtk.StringList({ strings: sessionNames })
  // Compact centered pill (natural width) — a set-once control, kept visually
  // subordinate to the password field (decided 2026-07-02; prior art: GDM/SDDM
  // hide it in a corner, others have none). That subordination is exactly why
  // the trigger does NOT take the kit's input look, only its popup.
  const sessionDrp = NidaraDropDown({
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
  })
  const errorWrap = withGlassCapsule(errorLabel)
  errorWrap.visible = false
  errorWrap.halign = Gtk.Align.CENTER
  errorWrap.margin_top = 6

  // NO caps-lock warning of our own, deliberately. `Gtk.PasswordEntry` already
  // builds one — an `image.caps-lock-indicator` inside the field — so this card
  // used to show TWO warnings for one state while the lockscreen, which never
  // had ours, showed one. The field's is the one that survives: it is where the
  // cursor is, it is what macOS and iOS do, and it makes the two screens
  // identical for free. It is styled in ui/greeter/style.scss; there is no
  // property to turn it off, so adding a second one is the only mistake
  // available here.

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
    errorWrap.visible = true
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
    errorWrap.visible = false
    passwordEntry.grab_focus()
  }

  const doLogin = async () => {
    if (isAuthenticating) return
    const password = passwordEntry.get_text()
    if (!password) { passwordEntry.grab_focus(); return }

    const session = sessions[sessionIdx]
    if (!session) { showError(t("noSession")); return }

    setLoading(true)
    errorWrap.visible = false

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
  // Painted capsules, exactly as the lockscreen paints its own — see
  // ui/lib/glass-capsule.ts. No backdrop source is set in this bundle, so the
  // body is fill-only and the compositor supplies the blur behind it.
  // followFocus only on the ENTRY: an input shows focus as its edge going
  // accent, a button shows a ring, and no control shows both.
  col.append(withGlassCapsule(passwordEntry, "subtle", true))
  col.append(withGlassCapsule(loginBtn, "strong", false))
  // The session selector is a control, and every other control on these two
  // screens sits on glass — including the locale bar's dropdowns, which are the
  // same widget. Bare, it was unreadable on a light wallpaper.
  col.append(withGlassCapsule(sessionDrp))
  col.append(errorWrap)

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
    if (!isAuthenticating) loginLabel.label = t("login")
  })

  return col
}
