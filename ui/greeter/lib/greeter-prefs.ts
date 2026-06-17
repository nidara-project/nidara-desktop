import GLib from "gi://GLib"

export interface GreeterPrefs {
  locale: string
  kbLayout: string
}

const PREFS_PATH = `${GLib.get_user_config_dir()}/nidara/greeter-prefs.json`

function load(): GreeterPrefs {
  try {
    const [ok, data] = GLib.file_get_contents(PREFS_PATH)
    if (!ok) return { locale: "", kbLayout: "" }
    return { locale: "", kbLayout: "", ...JSON.parse(new TextDecoder().decode(data as Uint8Array)) }
  } catch {
    return { locale: "", kbLayout: "" }
  }
}

function save(prefs: GreeterPrefs) {
  try {
    const dir = GLib.path_get_dirname(PREFS_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
      GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(PREFS_PATH, JSON.stringify(prefs, null, 2))
  } catch (e) {
    console.warn("[GreeterPrefs] save failed:", e)
  }
}

export const greeterPrefs = load()

export function savePrefs(update: Partial<GreeterPrefs>) {
  Object.assign(greeterPrefs, update)
  save(greeterPrefs)
}
