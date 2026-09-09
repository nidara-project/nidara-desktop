import Gtk from "gi://Gtk?version=4.0"
import app from "../../ui/lib/host"
import { NidaraTable } from "../../ui/lib/nidara-kit"

app.start({
  applicationId: "org.nidara.kit.reservecount",
  applicationName: "Reserve count",
  logDomain: "reserve",
  main() {
  const t = NidaraTable([
    { title: "Partition", expand: true },
    { title: "Mount point" },
    { title: "Filesystem" },
  ])
  const ROWS = 8
  for (let i = 0; i < ROWS; i++) {
    const mount = new Gtk.DropDown({ model: Gtk.StringList.new(["", "/", "/boot", "/home", "swap"]) })
    const fs = new Gtk.DropDown({ model: Gtk.StringList.new(["btrfs", "ext4", "xfs", "f2fs", "vfat"]) })
    t.appendRow([`/dev/sda${i + 1}`, mount, fs])
  }
  // el reserveBox es el 2º hijo de box (headerBox, reserveBox, listBox)
  let n = 0, idx = 0, reserve: Gtk.Widget | null = null
  let c = t.box.get_first_child()
  while (c) { if (idx === 1) reserve = c; idx++; c = c.get_next_sibling() }
  let d = reserve?.get_first_child() ?? null
  while (d) { if (d instanceof Gtk.DropDown) n++; d = d.get_next_sibling() }
  print(`filas=${ROWS} columnas-dropdown=2  →  DropDown fantasma creados: ${n}`)
  print(`(lo que pide el issue: uno por COLUMNA = 2)`)
  app.quit()
  },
})
