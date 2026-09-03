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

      const errorLabel = new Gtk.Label({
        label: "",
        css_classes: ["installer-prose", "installer-prose--warning"],
        halign: Gtk.Align.FILL,
        hexpand: true,
        xalign: 0,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        visible: false,
      })

      const { box: listCard, listBox } = NidaraList()
      listBox.append(NidaraStackedRow(t("accountFullName"), "", fullNameEntry))
      listBox.append(NidaraStackedRow(t("accountUsername"), "", usernameEntry))
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
      listBox.append(NidaraStackedRow(t("accountHostname"), t("accountHostnameDesc"), hostnameEntry))
      listBox.append(NidaraStackedRow(t("accountPassword"), "", pwEntry))
      listBox.append(NidaraStackedRow(t("accountConfirmPassword"), "", pw2Entry))

      box.append(listCard)
      box.append(errorLabel)

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

        let error = ""

        if (uname.length > 0) {
          if (!USERNAME_REGEX.test(uname)) {
            error = t("accountErrUsernameFormat")
          } else if (SYSTEM_USERS.has(uname)) {
            error = t("accountErrUsernameReserved")
          }
        }

        if (!error && hname.length > 0) {
          if (!HOSTNAME_REGEX.test(hname)) {
            error = t("accountErrHostnameFormat")
          }
        }

        if (!error && pw2.length > 0 && pw !== pw2) {
          error = t("accountErrPasswordMismatch")
        }

        if (error) {
          errorLabel.label = error
          errorLabel.visible = true
        } else {
          errorLabel.visible = false
        }

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

      fullNameEntry.connect("changed", validate)
      usernameEntry.connect("changed", validate)
      hostnameEntry.connect("changed", validate)
      pwEntry.connect("changed", validate)
      pw2Entry.connect("changed", validate)

      // Coming back to this step restores what was typed; arriving for the first
      // time suggests the names and leaves the password ALONE.
      //
      // ⚠️ It used to suggest the password too — "nidara", in both fields, rendered
      // as dots exactly like something a person had typed. Accepting the defaults
      // therefore produced a machine whose sudo-capable user had a password nobody
      // chose and nothing disclosed. A suggested NAME is a convenience; a suggested
      // CREDENTIAL is a credential, and the interface cannot tell the person which
      // of the two it just handed them.
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
