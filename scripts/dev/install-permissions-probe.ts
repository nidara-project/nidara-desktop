// install-permissions-probe — ui/shell/core/FlatpakPermissions.ts against the real
// `flatpak override`, in a throwaway installation. Driven by install-permissions-probe.sh
// (which points FLATPAK_USER_DIR / FLATPAK_SYSTEM_DIR at scratch directories).
// Prints one assertion per line; exits 1 on the first surprise.
import GLib from "gi://GLib"
import System from "system"
import {
  readInstallPermissions, setInstallPermission, resetInstallPermissions, watchInstallPermissions,
  type InstallPermissions,
} from "../../ui/shell/core/FlatpakPermissions"
import { execAsync } from "../../ui/lib/process"

const app = "org.example.Probe"
const user = GLib.getenv("FLATPAK_USER_DIR")!
const overrideFile = `${user}/overrides/${app}`
const loop = new GLib.MainLoop(null, false)
let exitCode = 0
const fail = (m: string): never => { print(`FAIL ${m}`); exitCode = 1; loop.quit(); throw new Error(m) }
const tick = (ms: number) => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(null); return GLib.SOURCE_REMOVE }))
const read = (): InstallPermissions => readInstallPermissions(app) ?? fail("app not found")
const show = (p: Record<string, boolean>) => Object.entries(p).map(([k, v]) => `${k}=${v ? 1 : 0}`).join(" ")
const expect = (label: string, got: Record<string, boolean>, want: Record<string, boolean>) => {
  if (show(got) !== show(want)) fail(`${label}: got ${show(got)}, want ${show(want)}`)
  print(`ok   ${label} → ${show(got)}`)
}
const overrides = () => {
  try { return new TextDecoder().decode(GLib.file_get_contents(overrideFile)[1]).replace(/\s+/g, " ").trim() } catch { return "(no file)" }
}

;(async () => {
  if (readInstallPermissions("org.example.Absent") !== null) fail("an app with no metadata must read as null")
  print("ok   an app that is not installed → null")

  // Declared (install.sh): no network; pulseaudio; devices=all; filesystems=host;xdg-download:ro
  const declared = { network: false, sound: true, gpu: true, home: true }
  expect("declared layer", read().declared, declared)
  expect("effective with no overrides", read().effective, declared)

  // Watch BEFORE the overrides directory exists: the monitor must still see it appear,
  // and an EXTERNAL writer (the flatpak CLI, as Flatseal would) must reach it.
  let fired = 0
  const unwatch = watchInstallPermissions(app, () => fired++)
  await execAsync(["flatpak", "override", "--user", "--nosocket=pulseaudio", app])
  await tick(500)
  if (fired === 0) fail("an external override (directory created by it) did not reach the watcher")
  print(`ok   external write seen by the watcher (${fired} event(s))`)
  expect("effective after external !pulseaudio", read().effective, { ...declared, sound: false })
  expect("declared untouched by overrides", read().declared, declared)

  // Positive control for the reader: `!home` alone leaves `host`, so home must STILL read on.
  await execAsync(["flatpak", "override", "--user", "--nofilesystem=home", app])
  expect("control: !home alone keeps host ⇒ home still on", read().effective, { ...declared, sound: false })

  // Through the module: revoking home must revoke host too.
  await setInstallPermission(app, "home", false)
  expect("module: home off", read().effective, { ...declared, sound: false, home: false })
  if (!/!host/.test(overrides())) fail(`home off did not write !host: ${overrides()}`)
  print(`ok   home off wrote both names: ${overrides()}`)

  // devices=all counts as GPU; turning GPU off must take both.
  await setInstallPermission(app, "gpu", false)
  expect("module: gpu off (declared via all)", read().effective, { ...declared, sound: false, home: false, gpu: false })

  // Granting something the app never asked for.
  await setInstallPermission(app, "network", true)
  expect("module: network on (undeclared)", read().effective, { network: true, sound: false, gpu: false, home: false })

  // Giving back what was declared, one by one, lands on the declared set again.
  await setInstallPermission(app, "sound", true)
  expect("module: sound back on", read().effective, { network: true, sound: true, gpu: false, home: false })

  // A write that FAILS still notifies, so a switch re-syncs instead of lying.
  const bad = "bad id with spaces"
  let notified = 0, threw = false
  const unBad = watchInstallPermissions(bad, () => notified++)
  try { await setInstallPermission(bad, "sound", false) } catch { threw = true }
  unBad()
  if (!threw) fail("flatpak accepted an invalid app id — the failure path is untested")
  if (notified === 0) fail("a failed write did not notify its listeners")
  print("ok   a failed write rejects AND notifies")

  // Restore = exactly the declared set, and the user's file is gone.
  await resetInstallPermissions(app)
  expect("reset: effective equals declared", read().effective, declared)
  if (overrides() !== "(no file)") fail(`reset left an override file: ${overrides()}`)
  print("ok   reset removed the override file")

  // A system-wide global override is a lower layer the user file sits on.
  GLib.mkdir_with_parents(`${GLib.getenv("FLATPAK_SYSTEM_DIR")}/overrides`, 0o755)
  GLib.file_set_contents(`${GLib.getenv("FLATPAK_SYSTEM_DIR")}/overrides/global`, "[Context]\nshared=network;\n")
  expect("system global override grants network", read().effective, { ...declared, network: true })
  await setInstallPermission(app, "network", false)
  expect("user layer beats system global", read().effective, declared)

  unwatch()
  loop.quit()
})().catch(e => { if (!exitCode) { print(`FAIL ${e}`); exitCode = 1 } loop.quit() })
loop.run()
System.exit(exitCode)
