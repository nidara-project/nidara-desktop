// keyboard-row-probe — the Settings keyboard row on its own, to be looked at.
//
//   ./scripts/bundle.sh scripts/dev/keyboard-row-probe.ts /tmp/kbrow && /tmp/kbrow
//
// It mounts ONE ROW, not Settings: the window builds all 21 pages eagerly and
// starting a second shell beside a running one is a way to lose an afternoon.
// This imports `ui/lib/keyboards.ts` and the kit, and nothing else.
//
// What it is for: the keyboard row is the one deliverable of #473 that no type,
// count or bundle can check. The catalogue is 597 entries, so the dropdown gets a
// search box — and the FIRST version of that search returned an empty list for
// "colemak", because GtkDropDown matches by PREFIX unless told otherwise and every
// entry is named "English (Colemak) · us-colemak". The box was there, it took the
// text, and it found nothing. Open it and type; that is the whole test.
//
// ⚠️ It is also the reason to kill probes BY PID. `pkill -x gjs` takes the running
// shell with it — the bar, the dock and the island are gjs too.

import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { installAppearance } from "../../ui/lib/appearance-css"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { NidaraWindow, NidaraList, NidaraDropDownRow } from "../../ui/lib/nidara-kit"
import { allKeyboards, bridgedKeyboards, keyboardById } from "../../ui/lib/keyboards"

const here = GLib.get_current_dir()
const css = [`${here}/ui/shell/style.css`, "./ui/shell/style.css", "./style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

app.start({
  applicationId: "org.nidara.keyboardrowprobe",
  applicationName: "Keyboard row probe",
  logDomain: "kbrow",
  css,

  main() {
    applyCrispFontRendering()
    installAppearance()

    const all = allKeyboards()
    const bridged = bridgedKeyboards()
    const noKeymap = bridged.filter(k => !k.keymap)
    print(`[catalogue] ${all.length} keyboards · ${bridged.length} bridged · ${noKeymap.length} bridged with no console keymap`)
    for (const k of noKeymap) print(`[no keymap] ${k.id} — ${k.label}`)

    // KEYBOARD_ROW_PROBE_ID=us-colemak opens on a specific one; the default is
    // whatever this machine is actually typing on, read from Hyprland's config the
    // same way Settings does — minus the shell, so a plain fallback.
    const wanted = GLib.getenv("KEYBOARD_ROW_PROBE_ID") ?? "es"
    const cur = keyboardById(wanted) ?? all[0]
    print(`[current] ${cur.id} → ${cur.label}`)

    const { box: card, listBox } = NidaraList()
    listBox.append(NidaraDropDownRow(
      "Keyboard layout",
      "What this desktop types with. The text console keeps the layout the installer set",
      cur.label,
      all.map(k => k.label),
      v => print(`[picked] ${v}`),
    ))

    const shell = NidaraWindow({
      app,
      title: "Keyboard row probe",
      name: "nidara-settings",
      appId: "nidara-kbrow-probe",
      content: card,
      closeOnEscape: true,
    })
    shell.window.connect("destroy", () => app.quit())
    shell.window.present()
  },
})
