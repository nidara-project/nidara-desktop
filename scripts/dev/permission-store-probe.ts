// permission-store-probe — ui/shell/core/PermissionStore.ts against a real
// xdg-permission-store. Driven by scripts/dev/permission-store-probe.sh (isolation).
// Prints one assertion per line; exits 1 on the first surprise.
import GLib from "gi://GLib"
import System from "system"
import Gio from "gi://Gio"
import { PORTAL_PERMISSIONS, getPortalPermission, setPortalPermission, watchPortalPermission } from "../../ui/shell/core/PermissionStore"

const app = "org.gnome.clocks", key = PORTAL_PERMISSIONS.camera
const loop = new GLib.MainLoop(null, false)
const seen: string[] = []
let exitCode = 0
const fail = (m: string): never => { print(`FAIL ${m}`); exitCode = 1; loop.quit(); throw new Error(m) }
const eq = async (label: string, want: string) => {
  const got = await getPortalPermission(key, app)
  if (got !== want) fail(`${label}: got ${got}, want ${want}`)
  print(`ok   ${label} → ${got}`)
}
const tick = (ms: number) => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(null); return GLib.SOURCE_REMOVE }))

;(async () => {
  await eq("fresh store (table does not exist)", "ask")
  const unwatch = watchPortalPermission(key, app, st => seen.push(st))
  await setPortalPermission(key, app, "allow"); await eq("after allow", "allow")
  await setPortalPermission(key, app, "deny");  await eq("after deny", "deny")
  await setPortalPermission(key, "org.other.App", "allow")
  await eq("another app's grant does not change this one", "deny")
  await setPortalPermission(key, app, "ask");   await eq("after ask", "ask")
  // "ask" must REMOVE the app's entry, not store a third value: read the raw table.
  // (A stored ["ask"] also reads back as "ask" through the client — this is the check
  // that tells the two apart.)
  const raw = Gio.DBus.session.call_sync("org.freedesktop.impl.portal.PermissionStore",
    "/org/freedesktop/impl/portal/PermissionStore", "org.freedesktop.impl.portal.PermissionStore",
    "Lookup", new GLib.Variant("(ss)", [key.table, key.id]), null, Gio.DBusCallFlags.NONE, 5000, null)
  const [perms] = raw.deepUnpack() as [Record<string, string[]>]
  if (app in perms) fail(`after ask the store still holds an entry for ${app}: ${JSON.stringify(perms[app])}`)
  print(`ok   after ask the entry is gone (table holds: ${Object.keys(perms).join(",") || "nothing"})`)
  await setPortalPermission(key, app, "ask");   await eq("ask twice is harmless", "ask")
  await tick(300)
  unwatch()
  // The store also emits for a DeletePermission that removed nothing, and for other
  // apps' changes to the same entry — both repeat the app's current state, which a
  // row applies as a no-op. So what must hold is the sequence of DISTINCT states.
  const distinct = seen.filter((st, i) => i === 0 || st !== seen[i - 1]).join(",")
  if (distinct !== "allow,deny,ask") fail(`Changed signals seen: ${seen.join(",")} (distinct ${distinct}, want allow,deny,ask)`)
  print(`ok   live updates → ${seen.join(",")} (distinct: ${distinct})`)
  loop.quit()
})().catch(e => { if (!exitCode) { print(`FAIL ${e}`); exitCode = 1 } loop.quit() })
loop.run()
System.exit(exitCode)
