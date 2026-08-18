import Gtk from "gi://Gtk?version=4.0"
// @ts-ignore
import AstalAuth from "gi://AstalAuth"
import { getCurrentUser } from "../../lib/users"
import { buildAuthCard } from "../../lib/auth-card"
import { t } from "../lib/i18n"

export default function LockCard(onUnlock: () => void): Gtk.Widget {
  // The session owner, NOT getDefaultUser(): this is both the displayed
  // identity and the PAM account the password is verified against — the
  // first /etc/passwd user would lock everyone else out of their own session.
  const user = getCurrentUser()
  let isAuthenticating = false

  // The chrome and the failure feedback are shared with the greeter
  // (ui/lib/auth-card.ts). What stays here is PAM.
  const card = buildAuthCard({
    user,
    t,
    primary: { label: t("unlock"), spinner: false },
    margins: { username: 10, entry: 20, button: 8 },
    onSubmit: () => doUnlock(),
  })

  const setLoading = (loading: boolean) => {
    isAuthenticating = loading
    card.setLoading(loading)
    card.setPrimaryLabel(loading ? t("unlocking") : t("unlock"))
  }

  const doUnlock = () => {
    if (isAuthenticating) return
    const password = card.passwordEntry.get_text()
    if (!password) { card.passwordEntry.grab_focus(); return }

    setLoading(true)
    card.clearError()

    const pam = new AstalAuth.Pam()
    pam.username = user.username

    pam.connect("success", () => { onUnlock() })

    pam.connect("fail", (_: any, msg: string) => {
      console.error("[Lock] auth fail:", msg)
      card.showError(t("wrongPassword"))
      // setLoading(false) FIRST: it re-enables the entry, and an insensitive
      // widget cannot take focus — grab_focus() before it was a silent no-op,
      // which is why a wrong password left you having to click or Tab back in.
      setLoading(false)
      // `resetPassword`, not `set_text("")`: the latter fires `notify::text`, which
      // is what clears the message when you start typing — so it would erase the
      // error we just showed. The card owns that distinction (ui/lib/auth-card.ts).
      card.resetPassword()
      card.passwordEntry.grab_focus()
    })

    pam.connect("auth-prompt-hidden", () => { pam.supply_secret(password) })
    pam.connect("auth-prompt-visible", () => { pam.supply_secret("") })
    pam.connect("auth-info",  (_: any, msg: string) => { console.log("[Lock] PAM info:", msg);  pam.supply_secret(null) })
    pam.connect("auth-error", (_: any, msg: string) => { console.warn("[Lock] PAM error:", msg); pam.supply_secret(null) })

    pam.start_authenticate()
  }

  return card.widget
}
