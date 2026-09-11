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
// A first paint must not greet anybody with four complaints about fields they
// have not touched — the page arrives EMPTY now, and arrives pre-filled when
// somebody walks back into it — but "required" waiting for the first edit is
// exactly what makes a silent dead button possible, so both readings of every
// empty field are cases below.
//
// The last table is a different function on the same page: `deriveHostname`,
// which suggests the machine's name from the account's. It is here because what
// it must never do is return a CONSTANT — the field used to open holding
// `nidara`, and a fleet of machines that all answer to `nidara` collide with
// each other in mDNS the moment there are two.

import { accountProblems, deriveHostname, hostnameStillFollows, type AccountFields, HOSTNAME_REGEX } from "../../ui/installer/lib/account-problems"
import { assemblePlan } from "../../ui/installer/lib/plan"
import type { Answers } from "../../ui/installer/lib/answers"
import type { BaseConfigResult } from "../../ui/installer/lib/base-config"
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
    name: "the form with empty password: not valid, but silent (no redundant error line)",
    fields: f({ password: "", confirm: "" }), touched: true,
    want: {}, valid: false,
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
    name: "the confirmation not typed yet — form not valid, but silent",
    fields: f({ confirm: "" }), touched: true,
    want: {}, valid: false,
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
    name: "empty fields remain silent, while invalid format is reported",
    fields: f({ username: "", hostname: "bad_host", password: "", confirm: "" }), touched: true,
    want: {
      hostname: "accountErrHostnameFormat",
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

// ─── what the machine gets called, when nobody says ──────────────────────────
interface HostCase { username: string; want: string; why: string }

const HOST_CASES: HostCase[] = [
  { username: "jane", want: "jane-nidara", why: "the ordinary one" },
  { username: "jane_doe", want: "jane-doe-nidara", why: "`_` is legal in a username and not in a hostname" },
  { username: "_jane", want: "jane-nidara", why: "a hostname label cannot start with a dash" },
  { username: "jane-", want: "jane-nidara", why: "nor end with one" },
  { username: "", want: "", why: "nothing to suggest — the placeholder comes back" },
  { username: "___", want: "", why: "nothing LEFT to suggest, which is not the same as nothing typed" },
  {
    username: "a".repeat(60),
    want: `${"a".repeat(56)}-nidara`,
    why: "cut to fit, because a suggestion that fails the field's own rule is a complaint about a field nobody touched",
  },
]

print("")
for (const c of HOST_CASES) {
  const got = deriveHostname(c.username)
  print(`   ${JSON.stringify(c.username).padEnd(20)} → ${JSON.stringify(got).padEnd(24)} ${c.why}`)
  if (got !== c.want) fail(`deriveHostname(${JSON.stringify(c.username)})`, `expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`)
  // Whatever it suggests has to pass the validation sitting next to it.
  if (got !== "" && !HOSTNAME_REGEX.test(got)) {
    fail(`deriveHostname(${JSON.stringify(c.username)})`, `suggested ${JSON.stringify(got)}, which HOSTNAME_REGEX refuses`)
  }
}

// ⚠️ The property no table of examples can state: two DIFFERENT accounts must not
// be handed the same machine name. This is the whole reason the old constant was
// a bug, and a table of expected strings would still pass if the function were
// rewritten to ignore its argument.
const distinct = new Set(["jane", "john", "ana"].map(deriveHostname))
if (distinct.size !== 3) {
  fail("deriveHostname", `three different usernames produced ${distinct.size} distinct hostname(s): ${[...distinct].join(", ")}`)
}

// ─── and whether the page may still change it for you ────────────────────────
const FOLLOW_CASES: [string, string, boolean, string][] = [
  ["", "jane", true, "nothing typed — the field is still the page's to fill"],
  ["jane-nidara", "jane", true, "exactly the suggestion: untouched, so correcting the username moves it"],
  ["workstation", "jane", false, "theirs, and it stays theirs"],
  ["jane-nidara", "john", false, "the suggestion for somebody ELSE — typed before the username changed, so it is not ours to overwrite"],
  ["", "", true, "an empty form: nothing is anybody's yet"],
  ["", "workstation", true, "cleared by hand — the field goes BACK to the page, which is why this is not a one-way flag"],
]

print("")
for (const [hostname, username, want, why] of FOLLOW_CASES) {
  const got = hostnameStillFollows(hostname, username)
  print(`   ${(got ? "follows" : "theirs").padEnd(9)} ${JSON.stringify(hostname).padEnd(15)} + ${JSON.stringify(username).padEnd(8)} ${why}`)
  if (got !== want) fail(`hostnameStillFollows(${JSON.stringify(hostname)}, ${JSON.stringify(username)})`, `expected ${want}, got ${got}`)
}

// ─── SUDO_USER rewrite in assemblePlan (#523) ─────────────────────────────────
//
// `base.json` ends with `SUDO_USER=nidara nidara-setup`. The ISO side (nidara-iso#28)
// asserts the token is present in the file; this asserts assemblePlan rewrites it
// to the username the person chose, across every character class the token allows.

interface SudoUserCase {
  cmd: string
  username: string
  want: string
  why: string
}

const SUDO_USER_CASES: SudoUserCase[] = [
  {
    cmd: "set -e; SUDO_USER=nidara nidara-setup",
    username: "jane",
    want: "set -e; SUDO_USER=jane nidara-setup",
    why: "the stock placeholder from base.json",
  },
  {
    cmd: "SUDO_USER=_leading_underscore nidara-setup",
    username: "john",
    want: "SUDO_USER=john nidara-setup",
    why: "placeholder with a leading underscore",
  },
  {
    cmd: "SUDO_USER=placeholder-with-dash nidara-setup",
    username: "my-user",
    want: "SUDO_USER=my-user nidara-setup",
    why: "placeholder and username both carrying dashes",
  },
  {
    cmd: "SUDO_USER=user123 nidara-setup",
    username: "u42",
    want: "SUDO_USER=u42 nidara-setup",
    why: "alphanumeric token",
  },
  {
    cmd: "SUDO_USER=" + "a".repeat(40) + " nidara-setup",
    username: "ana",
    want: "SUDO_USER=ana nidara-setup",
    why: "long placeholder token",
  },
  {
    cmd: "SUDO_USER=nidara nidara-setup",
    username: "_admin_99",
    want: "SUDO_USER=_admin_99 nidara-setup",
    why: "target username with underscore and digits",
  },
  {
    cmd: "echo 'no sudo user token here'",
    username: "jane",
    want: "echo 'no sudo user token here'",
    why: "command with no SUDO_USER token left untouched",
  },
]

function testPlanSudoUserRewrite(cmd: string, username: string): string {
  const fakeBase: BaseConfigResult = {
    path: "/dev/null",
    config: {
      custom_commands: [cmd],
    },
  }
  const fakeAnswers: Answers = {
    country: null,
    language: null,
    keyboard: null,
    timezone: null,
    disk: null,
    account: {
      fullName: "Test User",
      username,
      hostname: "test-host",
      password: "secretpassword",
    },
  }
  const plan = assemblePlan(fakeAnswers, fakeBase)
  const cmds = plan.config.custom_commands as string[]
  return cmds[0]
}

print("")
for (const c of SUDO_USER_CASES) {
  const got = testPlanSudoUserRewrite(c.cmd, c.username)
  print(`   ${c.username.padEnd(12)} → ${got.padEnd(48)} ${c.why}`)
  if (got !== c.want) {
    fail(`assemblePlan SUDO_USER rewrite (${c.cmd} with ${c.username})`, `expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`)
  }
}

print(failures === 0 ? "\nALL RULES HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
