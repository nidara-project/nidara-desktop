// account-rules-probe — what the account page accepts, and what it must refuse.
//
//   ./scripts/bundle.sh --js scripts/dev/account-rules-probe.ts /tmp/account-probe.js \
//     && gjs -m /tmp/account-probe.js
//
// No window, no GTK, no form: it calls `accountProblems()` with the five strings
// a person would have typed. Sibling of `disk-config-probe.ts`, same job, and it
// exists for the same reason — the rules were unreachable without clicking.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// These rules decide whether a name reaches `useradd` INSIDE THE CHROOT, which is
// the worst place for one to be rejected: pacstrap has already run, the log is
// folded shut, and the failure is a generic message from a program the person
// never invoked. So the page has to be the thing that says no.
//
// Three properties are checked, and the second is the one no reader can hold:
//
//   · the right message on the right FIELD. A mismatch reported against the first
//     password box is a correction pointing at the box that is not wrong.
//   · `valid` agrees with the messages, in the direction that matters. It is NOT
//     "no messages": an untouched empty field is deliberately silent and still
//     not installable. What must never happen is the reverse — `valid` true while
//     any message is showing, which is a Continue button that lights up over a
//     visible complaint.
//   · EVERY fault at once (D-20), not the first one. A form with a bad username
//     and mismatched passwords must report both, or the person fixes what they
//     were told and meets a dead button again for a reason nobody mentioned.
//
// ⚠️ The `touched` half is the subtle one and it is why the flag is a parameter.
// The form opens PRE-FILLED, so a first paint must not greet anybody with four
// complaints about fields they have not touched — but "required" waiting for the
// first edit is exactly what makes a silent dead button possible, so both
// readings of every empty field are cases below.

import { accountProblems, type AccountFields } from "../../ui/installer/lib/account-problems"
import { t } from "../../ui/installer/lib/i18n"

let failures = 0
function fail(name: string, msg: string): void {
  failures++
  print(`   ✗ ${name}: ${msg}`)
}

const FULL: Pick<AccountFields, "fullName"> = { fullName: "Nidara User" }
const f = (o: Partial<AccountFields>): AccountFields => ({
  ...FULL, username: "nidara", hostname: "nidara", password: "hunter2", confirm: "hunter2", ...o,
})

interface Case {
  name: string
  fields: AccountFields
  touched: boolean
  /** i18n keys expected on each field; absent means that field must be silent. */
  want: Partial<Record<"username" | "hostname" | "password" | "confirm", string>>
  valid: boolean
}

const CASES: Case[] = [
  {
    name: "a filled-in form — the control that stops this table passing vacuously",
    fields: f({}), touched: true, want: {}, valid: true,
  },
  {
    name: "the untouched form as it opens: pre-filled names, no password, and SILENT",
    fields: f({ password: "", confirm: "" }), touched: false, want: {}, valid: false,
  },
  {
    name: "the same form once something has been typed — now it says what it needs",
    fields: f({ password: "", confirm: "" }), touched: true,
    want: { password: "accountErrPasswordRequired" }, valid: false,
  },
  {
    name: "a capitalised username — useradd's rule, and the one people hit first",
    fields: f({ username: "Angel" }), touched: true,
    want: { username: "accountErrUsernameFormat" }, valid: false,
  },
  {
    name: "a username starting with a digit",
    fields: f({ username: "2angel" }), touched: true,
    want: { username: "accountErrUsernameFormat" }, valid: false,
  },
  {
    name: "a username of 32 characters — the boundary, and it is allowed",
    fields: f({ username: "a".repeat(32) }), touched: true, want: {}, valid: true,
  },
  {
    name: "a username of 33 characters — one past it",
    fields: f({ username: "a".repeat(33) }), touched: true,
    want: { username: "accountErrUsernameFormat" }, valid: false,
  },
  {
    name: "root — a name the installed system already gave to something else",
    fields: f({ username: "root" }), touched: true,
    want: { username: "accountErrUsernameReserved" }, valid: false,
  },
  {
    name: "live — the one reserved name that comes from OUR live medium, not Debian's list",
    fields: f({ username: "live" }), touched: true,
    want: { username: "accountErrUsernameReserved" }, valid: false,
  },
  {
    name: "a hostname ending in a dash — RFC 1123 wants alphanumeric ends",
    fields: f({ hostname: "nidara-" }), touched: true,
    want: { hostname: "accountErrHostnameFormat" }, valid: false,
  },
  {
    name: "a hostname with a dot — a FQDN is not a hostname",
    fields: f({ hostname: "nidara.local" }), touched: true,
    want: { hostname: "accountErrHostnameFormat" }, valid: false,
  },
  {
    name: "an underscore in the hostname — legal in a username, not in a host",
    fields: f({ hostname: "nidara_box" }), touched: true,
    want: { hostname: "accountErrHostnameFormat" }, valid: false,
  },
  {
    name: "a single-character hostname — the regex's optional tail, and it is legal",
    fields: f({ hostname: "n" }), touched: true, want: {}, valid: true,
  },
  {
    name: "passwords that do not match — reported on the SECOND box, not the first",
    fields: f({ password: "hunter2", confirm: "hunter3" }), touched: true,
    want: { confirm: "accountErrPasswordMismatch" }, valid: false,
  },
  {
    name: "the confirmation not typed yet — asked for, not called a mismatch",
    fields: f({ confirm: "" }), touched: true,
    want: { confirm: "accountErrPasswordConfirm" }, valid: false,
  },
  {
    name: "the first keystroke of a confirmation IS a mismatch, and says so on that field",
    fields: f({ password: "hunter2", confirm: "h" }), touched: true,
    want: { confirm: "accountErrPasswordMismatch" }, valid: false,
  },
  {
    name: "two faults at once — BOTH reported (D-20), not one and then the other",
    fields: f({ username: "Angel", confirm: "hunter3" }), touched: true,
    want: { username: "accountErrUsernameFormat", confirm: "accountErrPasswordMismatch" },
    valid: false,
  },
  {
    // Four bad fields, THREE messages: an empty confirmation of an empty password
    // is not a fault, and saying it were would be a fourth complaint about
    // something nobody has done yet.
    name: "four bad fields, and deliberately only three messages",
    fields: f({ username: "", hostname: "bad_host", password: "", confirm: "" }), touched: true,
    want: {
      username: "accountErrUsernameRequired",
      hostname: "accountErrHostnameFormat",
      password: "accountErrPasswordRequired",
    },
    valid: false,
  },
]

const FIELDS = ["username", "hostname", "password", "confirm"] as const

for (const c of CASES) {
  const got = accountProblems(c.fields, c.touched)
  const shown = FIELDS.filter(k => got[k].length > 0)
  print(`   ${got.valid ? "installable" : `${shown.length} message(s)`.padEnd(11)}  ${c.name}`)

  for (const k of FIELDS) {
    const wantKey = c.want[k]
    const wantText = wantKey ? t(wantKey as any) : ""
    if (got[k] !== wantText) {
      fail(c.name, `${k}: expected ${JSON.stringify(wantKey ?? null)}, got ${JSON.stringify(got[k])}`)
    }
  }
  if (got.valid !== c.valid) fail(c.name, `valid is ${got.valid}, expected ${c.valid}`)

  // ⚠️ The asymmetric invariant, checked on EVERY case rather than declared once:
  // a message on screen and a live Continue button is the combination that cannot
  // be defended. The reverse (silent and not installable) is the untouched form,
  // and is deliberate.
  if (got.valid && shown.length > 0) {
    fail(c.name, `valid while ${shown.join(", ")} is showing a message`)
  }
}

print(failures === 0 ? "\nALL RULES HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
