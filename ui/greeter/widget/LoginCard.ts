import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
// @ts-ignore
import AstalGreet from "gi://AstalGreet"
import { getSessions } from "../lib/sessions"
import { getDefaultUser } from "../lib/users"
import { t, onLocaleChange } from "../lib/i18n"

function greetLogin(username: string, password: string, cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      AstalGreet.login(username, password, cmd, (_: any, result: any) => {
        try { AstalGreet.login_finish(result); resolve() }
        catch (e) { reject(e) }
      })
    } catch (e) { reject(e) }
  })
}

export default function LoginCard(): Gtk.Widget {
  const sessions = getSessions()
  const user = getDefaultUser()

  let sessionIdx = Math.max(0, sessions.findIndex(s => s.id === "crystal-shell"))
  let isAuthenticating = false

  const avatar = user.avatarPath
    ? new Gtk.Image({ file: user.avatarPath, pixel_size: 80, css_classes: ["greeter-avatar"] })
    : new Gtk.Image({ icon_name: "avatar-default-symbolic", pixel_size: 80, css_classes: ["greeter-avatar"] })
  avatar.halign = Gtk.Align.CENTER

  const usernameLabel = new Gtk.Label({
    label: user.displayName,
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

  const loginBtn = new Gtk.Button({
    label: t("login"),
    css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
    margin_top: 10,
  })

  // Session selector — Gtk.DropDown auto-positions its popover (no off-screen bug)
  const sessionNames = sessions.map(s => s.name)
  const sessionModel = new Gtk.StringList({ strings: sessionNames })
  const sessionDrp = new Gtk.DropDown({
    model: sessionModel,
    halign: Gtk.Align.CENTER,
    width_request: 280,
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

  // ── Auth logic ────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    loginBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    sessionDrp.sensitive = !loading
    loginBtn.label = loading ? t("authenticating") : t("login")
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

  const doLogin = async () => {
    if (isAuthenticating) return
    const password = passwordEntry.get_text()
    if (!password) { passwordEntry.grab_focus(); return }

    const session = sessions[sessionIdx]
    if (!session) { showError(t("noSession")); return }

    setLoading(true)
    errorLabel.visible = false

    try {
      await greetLogin(user.username, password, session.exec)
      app.quit()
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      console.error("[Greeter] login error:", msg)
      showError(msg.toLowerCase().includes("auth") ? t("wrongPassword") : t("loginError"))
      passwordEntry.set_text("")
      passwordEntry.grab_focus()
      setLoading(false)
    }
  }

  passwordEntry.connect("activate", doLogin)
  loginBtn.connect("clicked", doLogin)

  const col = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  })

  col.append(avatar)
  col.append(usernameLabel)
  col.append(passwordEntry)
  col.append(loginBtn)
  col.append(sessionDrp)
  col.append(errorLabel)

  col.connect("map", () => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      passwordEntry.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  })

  onLocaleChange(() => {
    passwordEntry.placeholder_text = t("password")
    if (!isAuthenticating) loginBtn.label = t("login")
  })

  return col
}
