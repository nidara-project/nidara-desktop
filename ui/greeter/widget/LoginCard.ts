import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { getSessions } from "../lib/sessions"
import { getUsers, type User } from "../../lib/users"
import { greeterPrefs, savePrefs } from "../lib/greeter-prefs"
import { makeAvatar } from "../../lib/avatar"
import { greetdLogin, AuthError } from "../lib/greetd"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { buildAuthCard } from "../../lib/auth-card"
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

  // Avatar, name, password field, primary button and the failure message are the
  // lockscreen's too (ui/lib/auth-card.ts). What is greeter-only is below: the
  // session selector, the multi-user switcher, and greetd.
  const card = buildAuthCard({
    user: activeUser,
    t,
    primary: { label: t("login"), spinner: true },
    margins: { username: 12, entry: 28, button: 10 },
    onSubmit: () => { void doLogin() },
  })

  // Session selector — `NidaraDropDown` (kit): the native widget, so the popover
  // is still a real Wayland popup that auto-positions, but the list inside it is
  // the shell's — see LocaleBar.ts and style.scss.
  const sessionModel = new Gtk.StringList({ strings: sessions.map(s => s.name) })
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
  sessionDrp.connect("notify::selected", () => { sessionIdx = sessionDrp.selected })
  // The session selector is a control, and every other control on these two
  // screens sits on glass — including the locale bar's dropdowns, which are the
  // same widget. Bare, it was unreadable on a light wallpaper.
  //
  // BELOW the error capsule, not above it: the message is about the password, so
  // it belongs directly under the field and button it refers to — the way the
  // lockscreen (which has no session selector) already reads. Slotting the
  // selector in between pushed the failure two rows down, under a control it has
  // nothing to do with. Reserving the slot is what keeps the layout still; WHERE
  // it sits was always free.
  card.append(withGlassCapsule(sessionDrp))

  // ── Auth logic ────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    card.setLoading(loading)
    // The dropdown is the one control the shared card does not know about.
    sessionDrp.sensitive = !loading
    card.setPrimaryLabel(loading ? t("authenticating") : t("login"))
  }

  const setActiveUser = (u: User) => {
    if (u === activeUser) return
    activeUser = u
    card.setUser(u)
    card.resetPassword()
    card.clearError()
    card.passwordEntry.grab_focus()
  }

  const doLogin = async () => {
    if (isAuthenticating) return
    const password = card.passwordEntry.get_text()
    if (!password) { card.passwordEntry.grab_focus(); return }

    const session = sessions[sessionIdx]
    if (!session) { card.showError(t("noSession")); return }

    setLoading(true)
    card.clearError()

    try {
      // greetdLogin (lib/greetd.ts) speaks greetd directly — the AstalGreet call it
      // replaced swallowed auth errors and made a wrong password quit the greeter
      // (TTY flash, no feedback). Only reaches quit() on a real session start.
      await greetdLogin(activeUser.username, password, session.exec)
      savePrefs({ lastUser: activeUser.username })
      app.quit()
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      console.error("[Greeter] login error:", msg)
      const isAuth = e instanceof AuthError && e.isAuthFailure
      card.showError(isAuth ? t("wrongPassword") : t("loginError"))
      // Re-enable BEFORE grabbing focus: grab_focus() on a still-insensitive
      // entry silently fails ("GtkText did not receive a focus-out event"
      // warning) and left the field unfocused after every failed attempt —
      // the next keystrokes went nowhere until the user clicked the field.
      setLoading(false)
      // `resetPassword`, not `set_text("")`: the latter fires `notify::text`,
      // which is what clears the message when you start typing — so it would
      // erase the error we just showed (ui/lib/auth-card.ts).
      card.resetPassword()
      card.passwordEntry.grab_focus()
    }
  }

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
    card.append(switcher)
  }

  onLocaleChange(() => {
    card.passwordEntry.placeholder_text = t("password")
    if (!isAuthenticating) card.setPrimaryLabel(t("login"))
  })

  return card.widget
}
