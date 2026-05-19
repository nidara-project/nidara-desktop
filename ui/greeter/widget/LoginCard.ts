import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
// @ts-ignore
import AstalGreet from "gi://AstalGreet"
import { getSessions } from "../lib/sessions"
import { getDefaultUser } from "../lib/users"
import { t, onLocaleChange } from "../lib/i18n"
import Clock from "./Clock"
import LocaleBar from "./LocaleBar"

function greetLogin(username: string, password: string, cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      AstalGreet.login(username, password, cmd, null, (_: any, result: any) => {
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

  // ── Login button ──────────────────────────────────────────────────────────
  const loginBtn = new Gtk.Button({
    label: t("login"),
    css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
  })

  // ── Session picker ────────────────────────────────────────────────────────
  const sessionModel = Gtk.StringList.new(sessions.map(s => s.name))
  const sessionDropdown = new Gtk.DropDown({
    model: sessionModel,
    selected: sessionIdx,
    css_classes: ["greeter-session-dropdown"],
    halign: Gtk.Align.CENTER,
    width_request: 280,
    show_arrow: true,
  })
  sessionDropdown.connect("notify::selected", () => { sessionIdx = sessionDropdown.selected })

  // ── Auth logic ────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    loginBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    sessionDropdown.sensitive = !loading
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

  // ── Full centered column: clock → avatar → auth → locale ──────────────────
  const col = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    spacing: 0,
  })

  col.append(clockWidget)

  const spacer = new Gtk.Box()
  spacer.height_request = 32
  col.append(spacer)

  col.append(avatar)
  col.append(usernameLabel)

  const spacer2 = new Gtk.Box()
  spacer2.height_request = 16
  col.append(spacer2)

  col.append(passwordEntry)
  col.append(loginBtn)
  col.append(sessionDropdown)
  col.append(errorLabel)

  const spacer3 = new Gtk.Box()
  spacer3.height_request = 12
  col.append(spacer3)

  const localeBar = LocaleBar()
  localeBar.halign = Gtk.Align.CENTER
  col.append(localeBar)

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
