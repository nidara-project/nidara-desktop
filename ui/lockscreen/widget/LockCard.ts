import Gtk from "gi://Gtk?version=4.0"
// @ts-ignore
import NidaraAuth from "gi://NidaraAuth"
import { getCurrentUser } from "../../lib/users"
import { execAsync } from "../../lib/process"
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

    // Both are emitted BEFORE the verdict they qualify, and every signal from
    // the library goes through g_idle_add (FIFO), so these are set by the time
    // `success`/`fail` runs. See lib/nidara-auth/nidara-auth.h.
    let accountDenied = false
    let passwordExpired = false

    pam.connect("account-denied", (_: any, msg: string) => {
      console.warn("[Lock] account stack denied:", msg)
      accountDenied = true
    })
    pam.connect("password-expired", () => { passwordExpired = true })

    pam.connect("success", () => {
      // An expired password still unlocks (deliberate — see the library's
      // header). Telling the user IN THE CARD would show the warning for
      // exactly as long as it takes the lock surface to vanish, which is to say
      // nobody would read it. A notification outlives the unlock, and the
      // spawned child outlives this process, so it arrives either way.
      //
      // ⚠️ CRITICAL urgency on purpose, and it is not decoration: our own daemon
      // reads it as "never auto-expires, and cuts through Do Not Disturb"
      // (core/NotifService.ts → isCritical). At NORMAL this would fade after a
      // few seconds, or be swallowed outright by DND — which is the same
      // outcome as the bug it replaces, where the warning went to a log file.
      //
      // `-i` is a courtesy to any OTHER daemon: ours resolves the icon from the
      // app NAME through the app registry and never looks at `app_icon` when
      // that resolves (NotificationCenter.tsx), so on Nidara this shows the
      // Nidara mark. Verified on screen 2026-08-23.
      if (passwordExpired) {
        execAsync(["notify-send", "-u", "critical", "-a", "Nidara", "-i", "dialog-password",
                   t("passwordExpired"), t("passwordExpiredHow")]).catch(() => {})
      }
      onUnlock()
    })

    pam.connect("fail", (_: any, msg: string) => {
      console.error("[Lock] auth fail:", msg)
      // NOT always "wrong password": the account stack (expired account,
      // `usermod -L`, a pam_time window) refuses a perfectly correct one. Saying
      // the password is wrong would send the user retrying the right password
      // until pam_faillock locks them out for real.
      card.showError(accountDenied ? t("accountUnavailable") : t("wrongPassword"))
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
