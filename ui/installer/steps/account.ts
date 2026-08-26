// Step 6 — account setup: full name, username, and password.
//
// Collects account details, validates username and password matching, and stores
// the answer in `lib/answers.ts`. Passwords stay in memory only (never logged
// or written in plain text).

import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraStackedRow } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setAccountAnswer } from "../lib/answers"
import { heading, prose } from "./common"

const USERNAME_REGEX = /^[a-z_][a-z0-9_-]{0,31}$/

const SYSTEM_USERS = new Set([
  "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail",
  "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats",
  "nobody", "systemd-network", "systemd-resolve", "messagebus",
  "systemd-timesync", "avahi", "polkitd", "rtkit", "live",
])

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

      const usernameEntry = new Gtk.Entry({
        placeholder_text: t("accountUsernamePlaceholder"),
        hexpand: true,
      })

      const pwEntry = new Gtk.PasswordEntry({
        show_peek_icon: true,
        hexpand: true,
      })

      const pw2Entry = new Gtk.PasswordEntry({
        show_peek_icon: true,
        hexpand: true,
      })

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
      listBox.append(NidaraStackedRow(t("accountPassword"), "", pwEntry))
      listBox.append(NidaraStackedRow(t("accountConfirmPassword"), "", pw2Entry))

      box.append(listCard)
      box.append(errorLabel)

      const validate = () => {
        const fname = fullNameEntry.text.trim()
        const uname = usernameEntry.text.trim()
        const pw = pwEntry.text
        const pw2 = pw2Entry.text

        let error = ""

        if (uname.length > 0) {
          if (!USERNAME_REGEX.test(uname)) {
            error = t("accountErrUsernameFormat")
          } else if (SYSTEM_USERS.has(uname)) {
            error = t("accountErrUsernameReserved")
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
          && pw.length > 0
          && pw === pw2

        if (isValid) {
          setAccountAnswer({
            fullName: fname || uname,
            username: uname,
            password: pw,
          })
        } else {
          setAccountAnswer(null)
        }

        notifyReady?.()
      }

      fullNameEntry.connect("notify::text", validate)
      usernameEntry.connect("notify::text", validate)
      pwEntry.connect("notify::text", validate)
      pw2Entry.connect("notify::text", validate)

      // Restore previously entered values if user navigated back
      const existing = getAnswers().account
      if (existing) {
        fullNameEntry.text = existing.fullName
        usernameEntry.text = existing.username
        pwEntry.text = existing.password
        pw2Entry.text = existing.password
        validate()
      }

      return box
    },
  }
}
