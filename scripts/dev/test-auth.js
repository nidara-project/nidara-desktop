#!/usr/bin/env gjs -m
// ─────────────────────────────────────────────────────────────────────────────
// test-auth — end-to-end smoke of lib/nidara-auth against the REAL lock service.
//
// ⚠️ THIS COUNTS A FAILLOCK FAILURE AGAINST YOUR ACCOUNT. It authenticates
// through `nidara-lock` → `system-auth`, which starts with `pam_faillock`. Arch's
// defaults are deny=3 / unlock_time=600, so running this three times locks you out
// of your own session for ten minutes. Clear it with `faillock --user $USER --reset`.
//
// ⚠️ AND IT CANNOT CATCH THE CONVERSATION-ORDERING BUG. This drives the happy
// path: one prompt, no informational messages, so it never exercises what a
// chatty PAM stack does. It was the validation for #200 and it passed while the
// library was answering the next prompt with an empty password (see
// `scripts/dev/auth-probe.js`, which is the one that can fail). A green here
// means "the wiring works", not "the conversation is correct".
// ─────────────────────────────────────────────────────────────────────────────
import GLib from "gi://GLib"
// @ts-ignore
import NidaraAuth from "gi://NidaraAuth"

const loop = new GLib.MainLoop(null, false)
const pam = new NidaraAuth.Pam()

pam.username = GLib.get_user_name()
console.log(`[TestAuth] Testing auto-resolved service for user: ${pam.username}`)

pam.connect("auth-prompt-hidden", (_pam, prompt) => {
    console.log(`[TestAuth] auth-prompt-hidden received: "${prompt.trim()}"`)
    console.log("[TestAuth] Supplying intentionally wrong password...")
    pam.supply_secret("invalid_test_password_12345")
})

pam.connect("fail", (_pam, msg) => {
    console.log(`[TestAuth] SUCCESS: Received expected 'fail' signal: "${msg}"`)
    loop.quit()
})

pam.connect("success", () => {
    console.log("[TestAuth] Received 'success' signal!")
    loop.quit()
})

console.log("[TestAuth] Starting authentication...")
pam.start_authenticate()

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    console.error("[TestAuth] TIMEOUT - auth did not complete within 5s")
    loop.quit()
    return GLib.SOURCE_REMOVE
})

loop.run()
console.log("[TestAuth] Test completed cleanly.")
