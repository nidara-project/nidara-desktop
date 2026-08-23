#!/usr/bin/env -S gjs -m
// ─────────────────────────────────────────────────────────────────────────────
// auth-probe — does an informational PAM message steal the next password?
//
//   sudo install -Dm644 scripts/dev/pam-auth-probe /etc/pam.d/nidara-auth-probe
//   ./scripts/dev/auth-probe.sh              # against the built lib
//   ./scripts/dev/auth-probe.sh --old REF    # against the lib at a git ref
//
// ── What it tests ────────────────────────────────────────────────────────────
//
// `lib/nidara-auth` relays PAM messages as signals. PROMPTS block the worker and
// must be answered with supply_secret(); MESSAGES (auth-info / auth-error) carry
// no response and are not waited on.
//
// The bug this exists for (shipped in #200, fixed 2026-08-23): supply_secret()
// armed the gate whether or not a prompt was waiting at it. A client that
// answered an informational message — which the lockscreen did, because that WAS
// AstalAuth's contract and the consumer was ported across unchanged — left the
// gate open, and the next real password prompt did not wait: it answered itself
// with an empty string. On Arch this is reachable from `pam_faillock preauth`,
// which emits an error message before the prompt once an account has recorded
// failures, so three wrong passwords made every later attempt fail instantly
// with the correct password never reaching PAM.
//
// So this probe deliberately behaves like the OLD, buggy client: it answers the
// informational message. What it asserts is that the LIBRARY refuses to be
// poisoned by that. Fixing only the consumer would leave the trap armed for the
// next one.
//
// The PAM service (`scripts/dev/pam-auth-probe`) emits a `pam_echo` message
// BEFORE `pam_unix` prompts, and deliberately does NOT include pam_faillock — so
// running this cannot count failures against your real account or lock you out.
// ─────────────────────────────────────────────────────────────────────────────

import GLib from "gi://GLib"
// @ts-ignore
import NidaraAuth from "gi://NidaraAuth"

const SERVICE = GLib.getenv("NIDARA_AUTH_PROBE_SERVICE") || "nidara-auth-probe"
// ⚠️ MUST outlast pam_unix's FAILURE DELAY. On a rejected password pam_unix calls
// pam_fail_delay(pamh, 2000000) — pam_authenticate sleeps ~2s (±25% jitter) BEFORE
// returning, so no verdict signal can arrive until then. This was 1500ms on the
// first run and both checks reported the OPPOSITE of the truth: against the known-
// buggy library, test 1 saw "nothing settled yet" and called the gate held (it had
// already answered itself and was asleep in the delay), and test 2 saw no verdict
// and called the answer lost. A window shorter than the delay measures nothing.
const SETTLE_MS = 5000

let failures = 0

function head(name) { print(`\n── ${name}`) }
function pass(msg) { print(`  ✅ PASS — ${msg}`) }
function fail(msg) { print(`  ❌ FAIL — ${msg}`); failures++ }

/** Build a Pam wired up like the OLD lockscreen: messages get answered too. */
function makeBuggyClient(onPrompt) {
    const pam = new NidaraAuth.Pam()
    pam.username = GLib.get_user_name()
    pam.service = SERVICE

    const seen = { info: false, error: false, prompt: false, settled: null, settledAt: 0 }

    // ⚠️ ON PURPOSE. This is the line that used to poison the next prompt.
    pam.connect("auth-info", (_o, msg) => {
        seen.info = true
        print(`     · auth-info: ${msg}`)
        pam.supply_secret(null)
    })
    pam.connect("auth-error", (_o, msg) => {
        seen.error = true
        print(`     · auth-error: ${msg}`)
        pam.supply_secret(null)
    })
    pam.connect("auth-prompt-hidden", (_o, msg) => {
        seen.prompt = true
        print(`     · prompt: ${msg.trim()}`)
        onPrompt(pam)
    })
    pam.connect("success", () => { seen.settled = "success"; seen.settledAt = GLib.get_monotonic_time() })
    pam.connect("fail", (_o, m) => { seen.settled = `fail: ${m}`; seen.settledAt = GLib.get_monotonic_time() })

    seen.startedAt = GLib.get_monotonic_time()
    return { pam, seen }
}

function runTest(name, onPrompt, assertFn) {
    head(name)
    const loop = new GLib.MainLoop(null, false)
    const { pam, seen } = makeBuggyClient(onPrompt)
    pam.start_authenticate()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => { loop.quit(); return GLib.SOURCE_REMOVE })
    loop.run()
    if (seen.settled) {
        const ms = Math.round((seen.settledAt - seen.startedAt) / 1000)
        print(`     · verdict after ${ms}ms: ${seen.settled}`)
    } else {
        print(`     · no verdict in ${SETTLE_MS}ms`)
    }
    assertFn(seen)
}

// ── 1. The gate must stay shut ───────────────────────────────────────────────
// Answer the message, then NEVER answer the prompt. A correct library is still
// blocked when the timer fires. A poisoned one has already answered itself with
// an empty password and reported failure.
runTest("A message must not open the gate (prompt left unanswered)",
    () => { /* deliberately silent */ },
    (seen) => {
        if (!seen.info) {
            fail("the service never emitted an informational message — is /etc/pam.d/nidara-auth-probe installed?")
            return
        }
        if (!seen.prompt) { fail("PAM never reached the password prompt"); return }
        if (seen.settled) {
            fail(`authentication finished without us answering the prompt → ${seen.settled}\n` +
                 `           the informational message answered it for us, with an empty\n` +
                 `           password. THIS IS THE BUG.`)
        } else {
            pass("still waiting for the password after the message — the gate held")
        }
    })

// ── 2. A real prompt still works ─────────────────────────────────────────────
// Guarding the gate must not break answering. Deliberately wrong password, so
// the expected outcome is a failure that arrives ONLY after we speak.
runTest("A real prompt is still answered (deliberately wrong password)",
    (pam) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            print("     · answering (wrong password, on purpose)")
            pam.supply_secret("nidara-probe-not-a-real-password")
            return GLib.SOURCE_REMOVE
        })
    },
    (seen) => {
        if (!seen.settled) fail("no verdict within the settle window — the answer never got through")
        else if (!seen.settled.startsWith("fail")) fail(`expected a rejection, got ${seen.settled}`)
        else pass(`rejected as expected → ${seen.settled}`)
    })

// ── 3. The real ACCOUNT stack must not deny ──────────────────────────────────
// `pam_acct_mgmt()` was added on 2026-08-23; before that only the credential was
// checked. It is the one change here that could lock EVERYONE out — if this
// machine's account stack denies, no correct password would unlock any more.
// The service hands out `auth` for free (pam_permit, no prompt) so the only thing
// under test is `account include system-auth`, the real one.
const ACCT_SERVICE = "nidara-auth-probe-acct"
head("The real account stack allows this user (pam_acct_mgmt)")
{
    const loop = new GLib.MainLoop(null, false)
    const pam = new NidaraAuth.Pam()
    pam.username = GLib.get_user_name()
    pam.service = ACCT_SERVICE
    let settled = null
    pam.connect("auth-info", (_o, msg) => print(`     · auth-info: ${msg}`))
    pam.connect("auth-error", (_o, msg) => print(`     · auth-error: ${msg}`))
    pam.connect("success", () => { settled = "success"; loop.quit() })
    pam.connect("fail", (_o, m) => { settled = `fail: ${m}`; loop.quit() })
    pam.start_authenticate()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => { loop.quit(); return GLib.SOURCE_REMOVE })
    loop.run()
    if (settled === "success") pass("account stack allows the unlock")
    else if (settled === null) fail(`no verdict — is /etc/pam.d/${ACCT_SERVICE} installed?`)
    else fail(`the account stack DENIES this user → ${settled}\n` +
              `           with pam_acct_mgmt() in place, unlocking would be impossible.`)
}

// ── 4. An account denial is TOLD APART from a wrong password ────────────────
// `pam_acct_mgmt()` can refuse a perfectly correct password (expired account,
// `usermod -L`, a pam_time window). The library says so with `account-denied`,
// emitted BEFORE `fail`, so the lockscreen can show "account unavailable"
// instead of sending the user to retry the right password until pam_faillock
// locks them out for real. The service under test hands out `auth` for free and
// always refuses `account`.
const DENY_SERVICE = "nidara-auth-probe-deny"
head("An account denial arrives before the verdict (account-denied)")
{
    const loop = new GLib.MainLoop(null, false)
    const pam = new NidaraAuth.Pam()
    pam.username = GLib.get_user_name()
    pam.service = DENY_SERVICE
    let denied = null
    let deniedFirst = false
    let settled = null
    // ⚠️ In a GLib-signal world a MISSING signal is not a quiet false — `connect`
    // throws, and an uncaught throw here kills the probe mid-run: the checks
    // above have already printed their ✅, the summary never prints, and what you
    // read is three greens and a stack trace. Verified against `--old HEAD`,
    // which is exactly the library this check exists to fail on.
    let connected = false
    try {
        pam.connect("account-denied", (_o, msg) => {
            denied = msg
            deniedFirst = settled === null
            print(`     · account-denied: ${msg}`)
        })
        connected = true
    } catch (e) {
        fail(`this library has no "account-denied" signal (${e.message}) — a denial by the\n` +
             `           account stack is indistinguishable from a wrong password, so the card\n` +
             `           tells the user to retry a password that IS correct.`)
    }
    pam.connect("success", () => { settled = "success"; loop.quit() })
    pam.connect("fail", (_o, m) => { settled = `fail: ${m}`; loop.quit() })
    pam.start_authenticate()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => { loop.quit(); return GLib.SOURCE_REMOVE })
    loop.run()
    if (!connected) { /* already reported */ }
    else if (settled === null)
        fail(`no verdict — is /etc/pam.d/${DENY_SERVICE} installed?`)
    else if (settled === "success")
        fail("the account stack denied and the library unlocked anyway — pam_acct_mgmt() is not being run")
    else if (!denied)
        fail(`refused with "${settled}" but never emitted account-denied — the UI cannot tell this\n` +
             `           apart from a wrong password, and will tell the user to retry.`)
    else if (!deniedFirst)
        fail("account-denied arrived AFTER the verdict — too late for the fail handler to use it")
    else
        pass(`denial reported before the verdict → ${settled}`)
}

print(failures === 0
    ? "\n✅ auth-probe: all checks passed\n"
    : `\n❌ auth-probe: ${failures} check(s) failed\n`)

// ⚠️ Test 1 leaves a worker thread blocked on a prompt nobody will answer —
// there is no cancellation in the library (see tech-debt). Exiting is what
// reaps it, which is why this probe is a short-lived process.
imports.system.exit(failures === 0 ? 0 : 1)
