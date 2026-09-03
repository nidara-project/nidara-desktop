// Step 6 — account setup: full name, username, and password.
//
// Collects account details, validates username and password matching, and stores
// the answer in `lib/answers.ts`. Passwords stay in memory only (never logged
// or written in plain text).

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraStackedRow } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setAccountAnswer } from "../lib/answers"
import { heading, prose } from "./common"

const USERNAME_REGEX = /^[a-z_][a-z0-9_-]{0,31}$/
const HOSTNAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

const SYSTEM_USERS = new Set([
  "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail",
  "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats",
  "nobody", "systemd-network", "systemd-resolve", "messagebus",
  "systemd-timesync", "avahi", "polkitd", "rtkit", "live",
])

/**
 * What is in the five fields right now, valid or not.
 *
 * `answers.account` only holds a COMPLETE account — an incomplete form stores
 * null there, by design, so nothing downstream can read half an answer. That was
 * fine while the page was built once and kept. Now a language change rebuilds
 * every page, and without this the user would walk back to change the language
 * and return to an emptied form — including a password they had typed twice.
 */
let draft = {
  fullName: "Nidara User",
  username: "nidara",
  hostname: "nidara",
  password: "",
}

/**
 * One field of the form: the row, and the line that tells it it is wrong.
 *
 * The error line lives INSIDE the row, under its own entry (D-19/D-22). It used
 * to be one label under the card, which on the default window sits below five
 * stacked rows and therefore below the fold: Continue went dead and the reason
 * for it was off screen. Mismatched passwords — the common case — produced
 * exactly that, a dead button and nothing to read.
 *
 * It stays in this file until something else needs it: the rule this repo already
 * follows for `searchableList` in `steps/common.ts` — a third use, or the first
 * one outside the installer, is what promotes a helper to `nidara-kit`. Settings
 * has no validated form today.
 *
 * ⚠️ Not red. This bundle spends no red on anything (`.installer-prose--warning`
 * is full-strength ink at weight 500, and the disk warning says why in the
 * stylesheet): the DE reserves red for recording and for failure. What makes
 * this line read as a correction is that it is the only full-strength text on a
 * card of dim subtitles, and that it is attached to the control it is about.
 */
function field(
  label: string,
  subtitle: string,
  entry: Gtk.Widget,
): { row: Gtk.ListBoxRow; setError: (message: string) => void } {
  const error = new Gtk.Label({
    label: "",
    css_classes: ["installer-prose", "installer-prose--warning", "installer-field-error"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
    wrap: true,
    wrap_mode: Pango.WrapMode.WORD_CHAR,
    visible: false,
  })

  // The control the row is handed is the entry AND its error line, so the row
  // keeps its own metrics and the message moves with the field it belongs to.
  const stack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true })
  stack.append(entry)
  stack.append(error)

  return {
    row: NidaraStackedRow(label, subtitle, stack),
    setError: (message: string) => {
      error.label = message
      error.visible = message !== ""
    },
  }
}

export function AccountStep(): Step {
  return {
    id: "account",
    title: () => t("accountTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().account !== null,

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("accountHeading")))
      box.append(prose(t("accountIntro"), "installer-prose--dim"))

      const fullNameEntry = new Gtk.Entry({
        placeholder_text: t("accountFullNamePlaceholder"),
        hexpand: true,
      })
      fullNameEntry.update_property([Gtk.AccessibleProperty.LABEL], [t("accountFullName")])

      const usernameEntry = new Gtk.Entry({
        placeholder_text: t("accountUsernamePlaceholder"),
        hexpand: true,
      })
      usernameEntry.update_property([Gtk.AccessibleProperty.LABEL], [t("accountUsername")])

      const hostnameEntry = new Gtk.Entry({
        placeholder_text: t("accountHostnamePlaceholder"),
        hexpand: true,
      })
      hostnameEntry.update_property([Gtk.AccessibleProperty.LABEL], [t("accountHostname")])

      // ⚠️ The password survives leaving this step and coming back — a decision
      // taken on 2026-09-03, not an accident of the draft #394 introduced. The
      // audit asked whether an installation done with somebody else at the
      // keyboard should keep it (D-20's companion question), and the answer is
      // yes, for two reasons: it is what Calamares, subiquity and GNOME Initial
      // Setup all do, and clearing the FIELDS would not clear the password — the
      // installer has to hold it in memory to hand it to archinstall, so emptying
      // two entries buys the retyping and none of the protection. Nothing is ever
      // written to disk (see the header of lib/answers.ts).
      //
      // The residual risk was named and accepted: `show_peek_icon` means a filled
      // field can be revealed by whoever is at the keyboard. It is the same icon
      // that reveals it while it is being typed.
      const pwEntry = new Gtk.PasswordEntry({
        show_peek_icon: true,
        hexpand: true,
      })
      pwEntry.update_property([Gtk.AccessibleProperty.LABEL], [t("accountPassword")])

      const pw2Entry = new Gtk.PasswordEntry({
        show_peek_icon: true,
        hexpand: true,
      })
      pw2Entry.update_property([Gtk.AccessibleProperty.LABEL], [t("accountConfirmPassword")])

      const fullNameField = field(t("accountFullName"), "", fullNameEntry)
      const usernameField = field(t("accountUsername"), "", usernameEntry)
      // ⚠️ The one field on this card that is NOT about the person, and the only one
      // that gets a line explaining itself.
      //
      // Researched 2026-09-03: there is NO convention about where a hostname
      // lives. Calamares puts it here, in exactly this position — its
      // `users/page_usersetup.ui` orders FullName, LoginName, **Hostname**,
      // Password — and subiquity puts it on its identity view too. Anaconda puts
      // it under "Network & Host Name", and archinstall gives it a top-level entry
      // of its own. Two with the account, one with the system, one loose.
      //
      // So it stays, and what was actually missing is what subiquity bothers to
      // say and we did not: what the thing is FOR. A field labelled only "Host
      // name" among four fields about a person reads as a fifth fact about the
      // person.
      const hostnameField = field(t("accountHostname"), t("accountHostnameDesc"), hostnameEntry)
      const passwordField = field(t("accountPassword"), "", pwEntry)
      const confirmField = field(t("accountConfirmPassword"), "", pw2Entry)

      const { box: listCard, listBox } = NidaraList()
      listBox.append(fullNameField.row)
      listBox.append(usernameField.row)
      listBox.append(hostnameField.row)
      listBox.append(passwordField.row)
      listBox.append(confirmField.row)
      box.append(listCard)

      /**
       * Has the person started filling this form in?
       *
       * A form that greets you with "a username is required" under every empty
       * field is shouting at somebody who has done nothing wrong yet. A form that
       * stays silent about an empty required field for as long as you are typing
       * in the next one is the silent refusal this issue is about. One flag
       * settles both: quiet on arrival, and from the first keystroke ANYWHERE the
       * form says everything it is waiting for, each message at its own field.
       *
       * ⚠️ It is set by the `changed` handlers, which are connected AFTER the
       * initial fill below — filling the form is not the person typing in it.
       */
      let formTouched = false

      const validate = () => {
        // ':' and newlines would corrupt the passwd GECOS entry this name ends up
        // in, and `usermod` rejects them with a generic error — stripped up front,
        // the same way Settings → Users does when it creates an account.
        const fname = (fullNameEntry.get_text?.() ?? fullNameEntry.text ?? "").trim().replace(/[:\n\r]/g, "")
        const uname = (usernameEntry.get_text?.() ?? usernameEntry.text ?? "").trim()
        const hname = (hostnameEntry.get_text?.() ?? hostnameEntry.text ?? "").trim()
        const pw = pwEntry.get_text?.() ?? pwEntry.text ?? ""
        const pw2 = pw2Entry.get_text?.() ?? pw2Entry.text ?? ""

        draft = { fullName: fname, username: uname, hostname: hname, password: pw }

        // ⚠️ EVERY fault, not the first one (D-20). `validate()` used to fill a
        // single string and stop at the first `if`, so a form with a bad username
        // and mismatched passwords reported one fault, and the next one only after
        // the first was fixed — the person fixes what they were told, presses
        // Continue, and it is dead again for a different reason nobody mentioned.
        let usernameError = ""
        if (uname.length === 0) {
          if (formTouched) usernameError = t("accountErrUsernameRequired")
        } else if (!USERNAME_REGEX.test(uname)) {
          usernameError = t("accountErrUsernameFormat")
        } else if (SYSTEM_USERS.has(uname)) {
          usernameError = t("accountErrUsernameReserved")
        }

        let hostnameError = ""
        if (hname.length === 0) {
          if (formTouched) hostnameError = t("accountErrHostnameRequired")
        } else if (!HOSTNAME_REGEX.test(hname)) {
          hostnameError = t("accountErrHostnameFormat")
        }

        const passwordError = pw.length === 0 && formTouched ? t("accountErrPasswordRequired") : ""

        // The mismatch belongs to the SECOND field, and only once there is
        // something in it to compare: a message that appears on the first
        // keystroke of a confirmation is a message that is wrong for as long as it
        // takes to type the rest of it.
        let confirmError = ""
        if (pw2.length > 0 && pw !== pw2) confirmError = t("accountErrPasswordMismatch")
        else if (pw2.length === 0 && pw.length > 0 && formTouched) confirmError = t("accountErrPasswordConfirm")

        usernameField.setError(usernameError)
        hostnameField.setError(hostnameError)
        passwordField.setError(passwordError)
        confirmField.setError(confirmError)

        const isValid = uname.length > 0
          && USERNAME_REGEX.test(uname)
          && !SYSTEM_USERS.has(uname)
          && hname.length > 0
          && HOSTNAME_REGEX.test(hname)
          && pw.length > 0
          && pw === pw2

        if (isValid) {
          setAccountAnswer({
            fullName: fname || uname,
            username: uname,
            hostname: hname,
            password: pw,
          })
        } else {
          setAccountAnswer(null)
        }

        notifyReady?.()
      }

      // Coming back to this step restores what was typed; arriving for the first
      // time suggests the names and leaves the password ALONE.
      //
      // ⚠️ It used to suggest the password too — "nidara", in both fields, rendered
      // as dots exactly like something a person had typed. Accepting the defaults
      // therefore produced a machine whose sudo-capable user had a password nobody
      // chose and nothing disclosed. A suggested NAME is a convenience; a suggested
      // CREDENTIAL is a credential, and the interface cannot tell the person which
      // of the two it just handed them.
      //
      // ⚠️ The fill happens BEFORE the `changed` handlers are connected, and that
      // ordering is what makes `formTouched` mean what it says. `set_text` emits
      // `changed` exactly like a keystroke does; with the handlers already
      // attached, a page that restores a draft would arrive "touched" and greet
      // the person with the errors of a form they have not returned to yet.
      const existing = getAnswers().account ?? draft
      if (typeof fullNameEntry.set_text === "function") fullNameEntry.set_text(existing.fullName)
      else fullNameEntry.text = existing.fullName
      if (typeof usernameEntry.set_text === "function") usernameEntry.set_text(existing.username)
      else usernameEntry.text = existing.username
      if (typeof hostnameEntry.set_text === "function") hostnameEntry.set_text(existing.hostname || "nidara")
      else hostnameEntry.text = existing.hostname || "nidara"
      if (typeof pwEntry.set_text === "function") pwEntry.set_text(existing.password)
      else pwEntry.text = existing.password
      if (typeof pw2Entry.set_text === "function") pw2Entry.set_text(existing.password)
      else pw2Entry.text = existing.password

      const onEdited = () => { formTouched = true; validate() }
      fullNameEntry.connect("changed", onEdited)
      usernameEntry.connect("changed", onEdited)
      hostnameEntry.connect("changed", onEdited)
      pwEntry.connect("changed", onEdited)
      pw2Entry.connect("changed", onEdited)

      validate()

      box.connect("map", () => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          fullNameEntry.grab_focus()
          return GLib.SOURCE_REMOVE
        })
      })

      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        fullNameEntry.grab_focus()
        return GLib.SOURCE_REMOVE
      })

      return box
    },
  }
}
