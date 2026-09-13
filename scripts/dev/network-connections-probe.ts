// network-connections-probe — what a saved network looks like after it is carried
// from the live medium into the installed system.
//
//   ./scripts/bundle.sh --js scripts/dev/network-connections-probe.ts /tmp/network-probe.js \
//     && gjs -m /tmp/network-probe.js
//
// No NetworkManager, no disk: every input is the text of a keyfile.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Connections saved on the medium did not reach the installed system at all
// (lib/network-connections.ts). Carrying them is a copy — the part worth checking
// is the one edit made on the way: a connection restricted to the live user has
// to name the new account, or NetworkManager on the target hides it from everybody.
// And that edit must not reach anything else in the file, least of all a secret.

import { withOwner, connectionFiles } from "../../ui/installer/lib/network-connections"

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) print(`   ok           ${name}`)
  else { failures++; print(`   ✗ ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`) }
}

// The shape NetworkManager writes for a Wi-Fi network joined from a session
// (`nmcli`/D-Bus AddConnection with a user restriction).
const WIFI = [
  "[connection]",
  "id=live",                       // an SSID that happens to be the user's name
  "uuid=2f1a0c6e-9a53-4b4e-8a57-2c1f0d3b9e11",
  "type=wifi",
  "permissions=user:live;",
  "",
  "[wifi]",
  "ssid=live",
  "",
  "[wifi-security]",
  "key-mgmt=wpa-psk",
  "psk=user:live;not-a-permission",  // a password may contain anything
  "",
].join("\n")

print("\n── Who the connection belongs to ───────────────────────────────────")
const moved = withOwner(WIFI, "live", "ana")
check("the live user becomes the new account", moved.includes("permissions=user:ana;"), true)
check("the SSID that equals the user name is untouched", moved.includes("id=live\n") && moved.includes("ssid=live\n"), true)
check("the password is byte-for-byte the same", moved.includes("psk=user:live;not-a-permission"), true)
check("nothing else in the file moved", moved.replace("permissions=user:ana;", "permissions=user:live;"), WIFI)
check("another user's restriction is not ours to change",
  withOwner("[connection]\npermissions=user:bob;user:live;\n", "live", "ana"), "[connection]\npermissions=user:bob;user:ana;\n")
check("an unrestricted connection is left alone",
  withOwner("[connection]\nid=home\ntype=ethernet\n", "live", "ana"), "[connection]\nid=home\ntype=ethernet\n")
check("`permissions` outside [connection] is not the restriction",
  withOwner("[vpn]\npermissions=user:live;\n", "live", "ana"), "[vpn]\npermissions=user:live;\n")
check("a user whose name only starts the same is not the live user",
  withOwner("[connection]\npermissions=user:liveuser;\n", "live", "ana"), "[connection]\npermissions=user:liveuser;\n")

print("\n── Which files are connections ─────────────────────────────────────")
check("keyfiles only, no dotfiles, no paths",
  connectionFiles(["Home.nmconnection", ".hidden.nmconnection", "notes.txt", "Café 5G.nmconnection", "../x.nmconnection"]),
  ["Home.nmconnection", "Café 5G.nmconnection"])

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
