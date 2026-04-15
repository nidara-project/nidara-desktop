import GLib from "gi://GLib"
import Gio from "gi://Gio"

export interface Session {
  id: string
  name: string
  exec: string
  comment: string
}

function parseDesktop(text: string): { [key: string]: string } {
  const map: { [key: string]: string } = {}
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=")
    if (eq === -1 || line.startsWith("#") || line.startsWith("[")) continue
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return map
}

export function getSessions(): Session[] {
  const sessions: Session[] = []
  const dir = Gio.File.new_for_path("/usr/share/wayland-sessions")

  try {
    const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info: any

    while ((info = enumerator.next_file(null)) !== null) {
      const name: string = info.get_name()
      if (!name.endsWith(".desktop")) continue

      const file = dir.get_child(name)
      try {
        const [, contents] = file.load_contents(null)
        const text = new TextDecoder().decode(contents as Uint8Array)
        const props = parseDesktop(text)

        const exec = props["Exec"] ?? ""
        if (!exec) continue

        sessions.push({
          id: name.replace(".desktop", ""),
          name: props["Name"] ?? name.replace(".desktop", ""),
          exec,
          comment: props["Comment"] ?? "",
        })
      } catch (e) {
        console.warn(`[Greeter] Failed to parse ${name}:`, e)
      }
    }
  } catch (e) {
    console.error("[Greeter] getSessions:", e)
  }

  // Crystal Shell first, then alphabetical
  sessions.sort((a, b) => {
    if (a.id === "crystal-shell") return -1
    if (b.id === "crystal-shell") return 1
    return a.name.localeCompare(b.name)
  })

  return sessions
}
