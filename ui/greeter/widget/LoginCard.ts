import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
// @ts-ignore
import AstalGreet from "gi://AstalGreet"
import { getSessions, Session } from "../lib/sessions"
import { getDefaultUser, User } from "../lib/users"

export default function LoginCard(): Gtk.Widget {
  const sessions = getSessions()
  const user = getDefaultUser()

  let selectedSession: Session = sessions[0]
  let isAuthenticating = false

  // ── Avatar ──────────────────────────────────────────────────────────────────
  const avatar = user.avatarPath
    ? new Gtk.Image({ file: user.avatarPath, pixel_size: 56, css_classes: ["greeter-avatar"] })
    : new Gtk.Image({ icon_name: "avatar-default-symbolic", pixel_size: 56, css_classes: ["greeter-avatar"] })

  // ── Username ─────────────────────────────────────────────────────────────────
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

  // ── Session picker ────────────────────────────────────────────────────────────
  const sessionModel = new Gtk.StringList()
  sessions.forEach(s => sessionModel.append(s.name))

  const sessionDrop = new Gtk.DropDown({
    model: sessionModel,
    selected: Math.max(0, sessions.findIndex(s => s.id === "crystal-shell")),
    css_classes: ["greeter-session-drop"],
    hexpand: true,
  })

  selectedSession = sessions[sessionDrop.selected] ?? sessions[0]
  sessionDrop.connect("notify::selected", () => {
    selectedSession = sessions[sessionDrop.selected] ?? sessions[0]
  })

  // ── Auth logic ────────────────────────────────────────────────────────────────
  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    loginBtn.sensitive = !loading
    passwordEntry.sensitive = !loading
    sessionDrop.sensitive = !loading
    loginBtn.label = loading ? "Autenticando…" : "Iniciar sesión"
  }

  const showError = (msg: string) => {
    errorLabel.label = msg
    errorLabel.visible = true
    // Shake animation via CSS class
    passwordEntry.add_css_class("greeter-shake")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      passwordEntry.remove_css_class("greeter-shake")
      return GLib.SOURCE_REMOVE
    })
  }

  const doLogin = async () => {
    if (isAuthenticating) return
    const password = passwordEntry.get_text()
    if (!password) {
      passwordEntry.grab_focus()
      return
    }

    setLoading(true)
    errorLabel.visible = false

    try {
      await AstalGreet.login(user.username, password, selectedSession.exec)
      // If we reach here greetd accepted and is starting the session — exit
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (msg.toLowerCase().includes("auth")) {
        showError("Contraseña incorrecta")
      } else {
        showError("Error al iniciar sesión")
        console.error("[Greeter] login error:", e)
      }
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

  const sessionRow = new Gtk.Box({ spacing: 8, hexpand: true })
  sessionRow.append(new Gtk.Label({ label: "Sesión", css_classes: ["greeter-session-label"] }))
  sessionRow.append(sessionDrop)

  card.append(avatarRow)
  card.append(passwordEntry)
  card.append(loginBtn)
  card.append(sessionRow)
  card.append(errorLabel)

  return card
}
