// appearance-contract-probe — what an APPLICATION sees of the desktop's appearance.
//
// Drives `ui/lib/appearance.ts` exactly as a bundle does, without GTK and without a
// display: one `readAppearance()`, then `watchAppearance()` for a while, printing
// every state it is handed. It is the client half of
// `scripts/dev/appearance-contract-probe.sh`, which builds the rest of the chain
// (a private bus, dconf, the real xdg-desktop-portal frontend and OUR backend) and
// moves settings underneath it. Run that, not this.
//
//   gjs -m appearance-contract-probe.js [portal|mirror] [watch-ms]
//
// Output lines are machine-greppable:
//   READ <source> <state-json>
//   CHANGE <n> <state-json>

import GLib from "gi://GLib"
import { readAppearance, watchAppearance, appearanceSource, type AppearanceChannel } from "../../ui/lib/appearance"

const argv: string[] = (globalThis as any).ARGV ?? []
const channel = (argv[0] === "mirror" ? "mirror" : "portal") as AppearanceChannel
const watchMs = Number(argv[1] ?? 0)

const pick = (s: ReturnType<typeof readAppearance>) =>
  JSON.stringify({ accent: s.accent, isDark: s.isDark, windowOpacity: +s.windowOpacity.toFixed(3) })

const first = readAppearance({ channel })
print(`READ ${appearanceSource()} ${pick(first)}`)

if (watchMs > 0) {
  const loop = new GLib.MainLoop(null, false)
  let n = 0
  watchAppearance(first, (s) => { n++; print(`CHANGE ${n} ${pick(s)}`) }, { channel })
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, watchMs, () => { loop.quit(); return GLib.SOURCE_REMOVE })
  loop.run()
}
