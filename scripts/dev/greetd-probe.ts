// greetd-probe.ts — exercises the greeter's greetd client (ui/greeter/lib/greetd.ts)
// against scripts/dev/fake-greetd.py, WITHOUT a VM and without touching a real
// login. The greeter has no dev mode, so this is the only way to run this code
// path on the dev box; it is the login path, so "it compiles" is not enough.
//
//   python3 scripts/dev/fake-greetd.py /tmp/greetd.sock /tmp/req.jsonl &
//   ags bundle --gtk 4 scripts/dev/greetd-probe.ts /tmp/greetd-probe
//   GREETD_SOCK=/tmp/greetd.sock /tmp/greetd-probe
//
// Expect `PROBE-RESULT ALL PASS`, and read /tmp/req.jsonl: it records the
// CONVERSATION greetd saw, which is where "did it cancel the failed session?"
// is actually visible. Re-run with `--big-endian` on the fake to see the probe
// FAIL (that is the control proving it can).
import GLib from "gi://GLib"
import { greetdLogin, AuthError } from "../../ui/greeter/lib/greetd"

const results: string[] = []
let failures = 0

function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`)
  if (!ok) failures++
}

async function main() {
  // 1. Wrong password → AuthError flagged as an auth failure.
  try {
    await greetdLogin("angel", "wrong-password", "/usr/bin/true")
    check("wrong password rejected", false, "greetdLogin RESOLVED (the upstream bug)")
  } catch (e: any) {
    check("wrong password rejected", e instanceof AuthError && e.isAuthFailure === true,
      `${e?.constructor?.name} isAuthFailure=${e?.isAuthFailure} msg=${e?.message}`)
  }

  // 2. Correct password → resolves.
  try {
    await greetdLogin("angel", "correct-horse", "/usr/bin/true")
    check("correct password logs in", true)
  } catch (e: any) {
    check("correct password logs in", false, String(e?.message ?? e))
  }

  // 3. No socket → a plumbing error, NOT an auth failure (the card must not say
  //    "wrong password" when greetd is simply unreachable).
  const sock = GLib.getenv("GREETD_SOCK")
  GLib.unsetenv("GREETD_SOCK")
  try {
    await greetdLogin("angel", "correct-horse", "/usr/bin/true")
    check("missing socket is not an auth failure", false, "resolved with no greetd")
  } catch (e: any) {
    check("missing socket is not an auth failure",
      !(e instanceof AuthError && e.isAuthFailure), String(e?.message ?? e))
  }
  if (sock) GLib.setenv("GREETD_SOCK", sock, true)

  print(results.join("\n"))
  print(failures === 0 ? "PROBE-RESULT ALL PASS" : `PROBE-RESULT ${failures} FAILED`)
}

// A bundle without app.start() has no main loop, so the async Gio callbacks
// would never fire — the process would exit at the first await.
const loop = GLib.MainLoop.new(null, false)
main()
  .catch(e => print("PROBE-RESULT harness crashed: " + e))
  .finally(() => loop.quit())
loop.run()
