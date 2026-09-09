// Prueba que la reserva de #464 elige por CARACTERES y no por PÍXELES.
// Copiar a scripts/dev/ del worktree, construir con ./scripts/bundle.sh y correr:
//   env -u DISPLAY WLR_BACKENDS=headless cage -- /tmp/reserve-px
import Gtk from "gi://Gtk?version=4.0"
import app from "../../ui/lib/host"
import { NidaraTable } from "../../ui/lib/nidara-kit"

const CASES: Array<[string, string[], number]> = [
  ["latin  iiiiiiiiiiii vs WWWWWW", ["iiiiiiiiiiii", "WWWWWW"], 1],
  ["mixto  shortest vs 宽宽宽宽宽宽", ["shortest", "宽宽宽宽宽宽"], 1],
]

app.start({
  applicationId: "org.nidara.kit.reservepx",
  applicationName: "Reserve px",
  logDomain: "reserve-px",
  main() {
    for (const [name, items, widestIdx] of CASES) {
      const t = NidaraTable([{ title: "x" }])
      const dd = new Gtk.DropDown({ model: Gtk.StringList.new(items) })
      t.appendRow([dd])
      const win = new Gtk.Window({ child: t.box })
      const nat = () => t.box.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
      const reserved = nat()
      dd.selected = widestIdx
      const withWidest = nat()
      const longestByChars = items.reduce((a, b) => (b.length > a.length ? b : a))
      print(`${name}`)
      print(`   más largo por CARACTERES: "${longestByChars}"`)
      print(`   reservado = ${reserved}px · con el más ancho puesto = ${withWidest}px` +
            `  →  ${withWidest > reserved ? `SE DESBORDA en ${withWidest - reserved}px` : "cubre"}`)
      win.destroy()
    }
    app.quit()
  },
})
