import { displayLeases } from "../../ui/shell/core/DisplayLease"

let current = { scale: 1, transform: 0, mode: "1920x1080@60" }
let saved = { ...current }, counter = 0
const timers = new Set<() => void>()
const leases = displayLeases({ snapshot: () => ({ ...current }),
    apply: (_name, cfg) => { current = { ...cfg } as typeof current },
    save: (_name, cfg) => { saved = { ...cfg } as typeof saved },
    token: () => String(++counter),
    later: fn => { timers.add(fn); return () => { timers.delete(fn) } },
})
function check(ok: boolean, message: string) { if (!ok) throw Error(message); console.log(`PASS ${message}`) }
const original = JSON.stringify(current)
let token = leases.preview(":1.1", "DP-1", { mode: "1280x720@60" })
check(current.mode === "1280x720@60" && JSON.stringify(saved) === original, "preview does not persist")
check(JSON.stringify(leases.before("DP-1")) === original, "other saves can exclude the pending output")
let refused = false
try { leases.commit(token, ":1.2") } catch { refused = true }
check(refused, "another client cannot confirm")
leases.ownerLost(":1.1")
check(JSON.stringify(current) === original && timers.size === 0, "client death restores the display")
token = leases.preview(":1.3", "DP-1", { transform: 1 })
for (const timer of [...timers]) timer()
check(JSON.stringify(current) === original, "deadline restores the display")
refused = false
try { leases.commit(token, ":1.3") } catch { refused = true }
check(refused, "expired confirmation is refused")
token = leases.preview(":1.4", "DP-1", { mode: "1280x720@60" })
leases.commit(token, ":1.4")
leases.ownerLost(":1.4")
check(current.mode === "1280x720@60" && saved.mode === current.mode && timers.size === 0, "confirmed state survives client exit")
console.log("DISPLAY_LEASE_OK")
