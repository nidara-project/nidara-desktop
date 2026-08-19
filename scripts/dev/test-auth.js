#!/usr/bin/env gjs -m
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
