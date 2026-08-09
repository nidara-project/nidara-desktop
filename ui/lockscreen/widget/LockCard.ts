import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
// @ts-ignore
import AstalAuth from "gi://AstalAuth"
import { getCurrentUser } from "../../lib/users"
import { makeAvatar } from "../../lib/avatar"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { t } from "../lib/i18n"

export default function LockCard(onUnlock: () => void): Gtk.Widget {
  // The session owner, NOT getDefaultUser(): this is both the displayed
  // identity and the PAM account the password is verified against — the
  // first /etc/passwd user would lock everyone else out of their own session.
  const user = getCurrentUser()
  let isAuthenticating = false

  const avatar = makeAvatar(80)
  avatar.setSource(user.avatarPath)

  const usernameLabel = new Gtk.Label({
    label: user.displayName,
    css_classes: ["greeter-username"],
    halign: Gtk.Align.CENTER,
    margin_top: 10,
  })

  const passwordEntry = new Gtk.PasswordEntry({
    placeholder_text: t("password"),
    show_peek_icon: true,
    css_classes: ["greeter-password"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
    margin_top: 20,
  })

  const unlockBtn = new Gtk.Button({
    label: t("unlock"),
    css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
    margin_top: 8,
  })

  const errorLabel = new Gtk.Label({
    label: "",
    css_classes: ["greeter-error"],
    wrap: true,
    halign: Gtk.Align.CENTER,
  })
  // On glass like the greeter's: it sits in the middle of the card, where the
  // scrim is weakest, and neutral text on a light wallpaper needs a body behind
  // it. The WRAPPER is what gets shown and hidden.
  const errorWrap = withGlassCapsule(errorLabel)
  errorWrap.visible = false
  errorWrap.halign = Gtk.Align.CENTER
  errorWrap.margin_top = 6

  // ── Auth logic ────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    unlockBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    unlockBtn.label = loading ? t("unlocking") : t("unlock")
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

  const doUnlock = () => {
    if (isAuthenticating) return
    const password = passwordEntry.get_text()
    if (!password) { passwordEntry.grab_focus(); return }

    setLoading(true)
    errorWrap.visible = false

    const pam = new AstalAuth.Pam()
    pam.username = user.username

    pam.connect("success", () => { onUnlock() })

    pam.connect("fail", (_: any, msg: string) => {
      console.error("[Lock] auth fail:", msg)
      showError(t("wrongPassword"))
      // setLoading(false) FIRST: it re-enables the entry, and an insensitive
      // widget cannot take focus — grab_focus() before it was a silent no-op,
      // which is why a wrong password left you having to click or Tab back in.
      setLoading(false)
      passwordEntry.set_text("")
      passwordEntry.grab_focus()
    })

    pam.connect("auth-prompt-hidden", () => { pam.supply_secret(password) })
    pam.connect("auth-prompt-visible", () => { pam.supply_secret("") })
    pam.connect("auth-info",  (_: any, msg: string) => { console.log("[Lock] PAM info:", msg);  pam.supply_secret(null) })
    pam.connect("auth-error", (_: any, msg: string) => { console.warn("[Lock] PAM error:", msg); pam.supply_secret(null) })

    pam.start_authenticate()
  }

  passwordEntry.connect("activate", doUnlock)
  unlockBtn.connect("clicked", doUnlock)

  const col = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    // Same entrance fade as the greeter card (class pair defined in style.scss).
    css_classes: ["greeter-card"],
  })

  col.append(avatar.widget)
  col.append(usernameLabel)
  // The entry is translucent (--nidara-glass): the compositor cannot blur what
  // is behind a lock surface, so we paint the blurred wallpaper ourselves.
  // Rim weights mirror what the CSS used to draw: --nidara-glass-border-sm on
  // the entry, the stronger --nidara-glass-border on the primary button.
  col.append(withGlassCapsule(passwordEntry, "subtle", true))
  col.append(withGlassCapsule(unlockBtn, "strong", false))
  col.append(errorWrap)

  col.connect("map", () => {
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

  return col
}
