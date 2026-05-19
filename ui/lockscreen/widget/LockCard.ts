import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
// @ts-ignore
import AstalAuth from "gi://AstalAuth"
import { getDefaultUser } from "../lib/users"
import { t } from "../lib/i18n"
import Clock from "./Clock"

export default function LockCard(): Gtk.Widget {
  const user = getDefaultUser()
  let isAuthenticating = false

  // ── Clock: date above, time below ─────────────────────────────────────────
  const clockWidget = Clock()
  clockWidget.halign = Gtk.Align.CENTER

  // ── Avatar ────────────────────────────────────────────────────────────────
  const avatar = user.avatarPath
    ? new Gtk.Image({ file: user.avatarPath, pixel_size: 80, css_classes: ["greeter-avatar"] })
    : new Gtk.Image({ icon_name: "avatar-default-symbolic", pixel_size: 80, css_classes: ["greeter-avatar"] })
  avatar.halign = Gtk.Align.CENTER

  const usernameLabel = new Gtk.Label({
    label: user.displayName,
    css_classes: ["greeter-username"],
    halign: Gtk.Align.CENTER,
  })

  // ── Error label ───────────────────────────────────────────────────────────
  const errorLabel = new Gtk.Label({
    label: "",
    css_classes: ["greeter-error"],
    visible: false,
    wrap: true,
    halign: Gtk.Align.CENTER,
  })

  // ── Password entry ────────────────────────────────────────────────────────
  const passwordEntry = new Gtk.PasswordEntry({
    placeholder_text: t("password"),
    show_peek_icon: true,
    css_classes: ["greeter-password"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
  })

  // ── Unlock button ─────────────────────────────────────────────────────────
  const unlockBtn = new Gtk.Button({
    label: t("unlock"),
    css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
  })

  // ── Auth logic ────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    unlockBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    unlockBtn.label = loading ? t("unlocking") : t("unlock")
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

  const doUnlock = () => {
    if (isAuthenticating) return
    const password = passwordEntry.get_text()
    if (!password) { passwordEntry.grab_focus(); return }

    setLoading(true)
    errorLabel.visible = false

    const pam = new AstalAuth.Pam()
    pam.username = user.username

    pam.connect("success", () => { app.quit() })

    pam.connect("fail", (_: any, msg: string) => {
      console.error("[Lock] auth fail:", msg)
      showError(t("wrongPassword"))
      passwordEntry.set_text("")
      passwordEntry.grab_focus()
      setLoading(false)
    })

    pam.connect("auth-prompt-hidden", () => { pam.supply_secret(password) })
    pam.connect("auth-prompt-visible", () => { pam.supply_secret("") })
    pam.connect("auth-info",  (_: any, msg: string) => { console.log("[Lock] PAM info:", msg);  pam.supply_secret(null) })
    pam.connect("auth-error", (_: any, msg: string) => { console.warn("[Lock] PAM error:", msg); pam.supply_secret(null) })

    pam.start_authenticate()
  }

  passwordEntry.connect("activate", doUnlock)
  unlockBtn.connect("clicked", doUnlock)

  // ── Full centered column: clock → avatar → auth ───────────────────────────
  const col = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    spacing: 0,
  })

  col.append(clockWidget)

  // Spacer between clock and avatar
  const spacer = new Gtk.Box()
  spacer.height_request = 32
  col.append(spacer)

  col.append(avatar)
  col.append(usernameLabel)

  // Spacer between username and password
  const spacer2 = new Gtk.Box()
  spacer2.height_request = 16
  col.append(spacer2)

  col.append(passwordEntry)
  col.append(unlockBtn)
  col.append(errorLabel)

  col.connect("map", () => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      passwordEntry.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  })

  return col
}
