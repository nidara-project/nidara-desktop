import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
// @ts-ignore
import AstalGreet from "gi://AstalGreet"
import { getSessions } from "../lib/sessions"
import { getDefaultUser } from "../lib/users"

// Wrap GIO-style async AstalGreet.login as a Promise
function greetLogin(username: string, password: string, cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      AstalGreet.login(username, password, cmd, null, (_: any, result: any) => {
        try {
          AstalGreet.login_finish(result)
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      reject(e)
    }
  })
}

export default function LoginCard(): Gtk.Widget {
  const sessions = getSessions()
  const user = getDefaultUser()

  let sessionIdx = Math.max(0, sessions.findIndex(s => s.id === "crystal-shell"))
  let isAuthenticating = false

  // ── Avatar ──────────────────────────────────────────────────────────────────
  const avatar = user.avatarPath
    ? new Gtk.Image({ file: user.avatarPath, pixel_size: 56, css_classes: ["greeter-avatar"] })
    : new Gtk.Image({ icon_name: "avatar-default-symbolic", pixel_size: 56, css_classes: ["greeter-avatar"] })

  const usernameLabel = new Gtk.Label({
    label: user.displayName,
    css_classes: ["greeter-username"],
  })

  const avatarRow = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    spacing: 8,
  })
  avatarRow.append(avatar)
  avatarRow.append(usernameLabel)

  // ── Error label ───────────────────────────────────────────────────────────────
  const errorLabel = new Gtk.Label({
    label: "",
    css_classes: ["greeter-error"],
    visible: false,
    wrap: true,
    halign: Gtk.Align.CENTER,
  })

  // ── Password entry ────────────────────────────────────────────────────────────
  const passwordEntry = new Gtk.PasswordEntry({
    placeholder_text: "Contraseña",
    show_peek_icon: true,
    css_classes: ["greeter-password"],
    hexpand: true,
  })

  // ── Login button ──────────────────────────────────────────────────────────────
  const loginBtn = new Gtk.Button({
    label: "Iniciar sesión",
    css_classes: ["greeter-login-btn"],
    hexpand: true,
  })

  // ── Session picker: native DropDown ──────────────────────────────────────────
  const sessionModel = Gtk.StringList.new(sessions.map(s => s.name))

  const sessionDropdown = new Gtk.DropDown({
    model: sessionModel,
    selected: sessionIdx,
    css_classes: ["greeter-session-dropdown"],
    halign: Gtk.Align.CENTER,
    show_arrow: true,
  })

  sessionDropdown.connect("notify::selected", () => {
    sessionIdx = sessionDropdown.selected
  })

  // ── Auth logic ────────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    loginBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    sessionDropdown.sensitive = !loading
    loginBtn.label = loading ? "Autenticando…" : "Iniciar sesión"
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
    if (!session) { showError("No hay sesión disponible"); return }

    setLoading(true)
    errorLabel.visible = false

    try {
      await greetLogin(user.username, password, session.exec)
      app.quit()
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      console.error("[Greeter] login error:", msg)
      showError(msg.toLowerCase().includes("auth") ? "Contraseña incorrecta" : "Error al iniciar sesión")
      passwordEntry.set_text("")
      passwordEntry.grab_focus()
      setLoading(false)
    }
  }

  passwordEntry.connect("activate", doLogin)
  loginBtn.connect("clicked", doLogin)

  // ── Card layout ───────────────────────────────────────────────────────────────
  const card = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    css_classes: ["greeter-card"],
    spacing: 12,
    width_request: 340,
  })

  card.append(avatarRow)
  card.append(passwordEntry)
  card.append(loginBtn)
  card.append(sessionDropdown)
  card.append(errorLabel)

  // Focus the password entry as soon as the card is on screen
  card.connect("map", () => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      passwordEntry.grab_focus()
      return GLib.SOURCE_REMOVE
    })
  })

  return card
}
