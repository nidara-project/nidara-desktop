// What is wrong with the account form right now, per field — and whether it is
// complete enough to install with.
//
// ⚠️ It is ONE function returning both because `steps/account.ts` had two, and
// they were two hand-maintained expressions of the same rules: four `if` chains
// filling four error strings, and then a separate seven-term `isValid` boolean
// repeating every one of those conditions. Nothing made them agree. That is the
// shape `manualProblems` exists to prevent on the disk page, where it had already
// cost a Continue button that went dead with nothing on screen saying why (D-16).
//
// ⚠️ `valid` is NOT "no messages". An untouched empty field produces no message
// on purpose — see `touched` — and is still not something to install with, so the
// completeness half is stated separately rather than inferred from the absence of
// text.
//
// It lives in `lib/` rather than in the page for the reason `manual-problems.ts`
// does: the page imports Gtk, so a rule that lives there can only be checked by
// typing into it.

import { t } from "./i18n"

/** useradd's own rule, and the reason a capitalised name is refused. */
export const USERNAME_REGEX = /^[a-z_][a-z0-9_-]{0,31}$/

/** RFC 1123 label: alphanumeric ends, dashes inside, 63 characters. */
export const HOSTNAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

/**
 * Names the installed system already gives to something else. Taking one does
 * not fail at install time — it fails at `useradd`, inside the chroot, with the
 * log folded shut.
 */
const SYSTEM_USERS = new Set([
  "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail",
  "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats",
  "nobody", "systemd-network", "systemd-resolve", "messagebus",
  "systemd-timesync", "avahi", "polkitd", "rtkit", "live",
])

export interface AccountFields {
  fullName: string
  username: string
  hostname: string
  password: string
  confirm: string
}

export interface AccountProblems {
  username: string
  hostname: string
  password: string
  confirm: string
  /** Every rule satisfied — what `ready()` asks, and what may be stored. */
  valid: boolean
}

/**
 * @param touched Has the person edited anything yet? A form that opens
 *   pre-filled must not greet them with four complaints about fields they have
 *   not touched, so the REQUIRED messages wait for the first edit. Format and
 *   mismatch messages do not: those describe something that is actually typed.
 */
export function accountProblems(f: AccountFields, touched: boolean): AccountProblems {
  // ⚠️ EVERY fault, not the first one (D-20). This used to fill a single string
  // and stop at the first `if`, so a form with a bad username AND mismatched
  // passwords reported one fault, and the next only after the first was fixed:
  // the person fixes what they were told, presses Continue, and it is dead again
  // for a different reason nobody mentioned.
  let username = ""
  if (f.username.length === 0) {
    if (touched) username = t("accountErrUsernameRequired")
  } else if (!USERNAME_REGEX.test(f.username)) {
    username = t("accountErrUsernameFormat")
  } else if (SYSTEM_USERS.has(f.username)) {
    username = t("accountErrUsernameReserved")
  }

  let hostname = ""
  if (f.hostname.length === 0) {
    if (touched) hostname = t("accountErrHostnameRequired")
  } else if (!HOSTNAME_REGEX.test(f.hostname)) {
    hostname = t("accountErrHostnameFormat")
  }

  const password = f.password.length === 0 && touched ? t("accountErrPasswordRequired") : ""

  // The mismatch belongs to the SECOND field, and only once there is something in
  // it to compare: a message that appears on the first keystroke of a
  // confirmation is a message that is wrong for as long as it takes to type the
  // rest of it.
  let confirm = ""
  if (f.confirm.length > 0 && f.password !== f.confirm) confirm = t("accountErrPasswordMismatch")
  else if (f.confirm.length === 0 && f.password.length > 0 && touched) confirm = t("accountErrPasswordConfirm")

  const valid = f.username.length > 0
    && USERNAME_REGEX.test(f.username)
    && !SYSTEM_USERS.has(f.username)
    && f.hostname.length > 0
    && HOSTNAME_REGEX.test(f.hostname)
    && f.password.length > 0
    && f.password === f.confirm

  return { username, hostname, password, confirm, valid }
}

/**
 * ':' and newlines would corrupt the passwd GECOS entry the full name ends up
 * in, and `usermod` rejects them with a generic error — stripped up front, the
 * same way Settings → Users does when it creates an account.
 */
export function cleanFullName(raw: string): string {
  return raw.trim().replace(/[:\n\r]/g, "")
}
