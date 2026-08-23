import Gtk from "gi://Gtk?version=4.0"
// @ts-ignore
import NidaraAuth from "gi://NidaraAuth"
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

    const pam = new NidaraAuth.Pam()
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

    // ⚠️ ONLY prompts get answered. `auth-info`/`auth-error` are messages to
    // SHOW — PAM expects no response and the worker does not wait for one.
    // Both used to call `supply_secret(null)` here, which was correct under
    // AstalAuth (it blocked on those signals too) and became a real bug when
    // this moved to lib/nidara-auth: the stray answer armed the gate, and the
    // next password prompt consumed it and replied with an EMPTY password
    // nobody typed. On Arch that is reachable from `pam_faillock preauth`,
    // which emits an error message before the prompt once the account has
    // recorded failures — so after three wrong passwords the correct one
    // stopped reaching PAM at all. The library now drops a stray answer, but
    // the contract is in `lib/nidara-auth/nidara-auth.h`: do not answer these.
    pam.connect("auth-prompt-hidden", () => { pam.supply_secret(password) })
    // ECHO_ON is the username prompt, which cannot happen here (pam_start is
    // given the user) — or a second factor, which this card has no field for.
    // Answer so the attempt cannot hang, and say so in the log.
    pam.connect("auth-prompt-visible", (_: any, msg: string) => {
      console.warn("[Lock] unexpected visible prompt, answering empty:", msg)
      pam.supply_secret("")
    })
    pam.connect("auth-info",  (_: any, msg: string) => { console.log("[Lock] PAM info:", msg) })
    pam.connect("auth-error", (_: any, msg: string) => { console.warn("[Lock] PAM error:", msg) })

    pam.start_authenticate()
  }

  return card.widget
}
