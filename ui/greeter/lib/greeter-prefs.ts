import GLib from "gi://GLib"
import { getUsers, getDefaultUser, type User } from "../../lib/users"

export interface GreeterPrefs {
  locale: string
  kbLayout: string
  lastUser: string
}

const DEFAULTS: GreeterPrefs = { locale: "", kbLayout: "", lastUser: "" }

const PREFS_PATH = `${GLib.get_user_config_dir()}/nidara/greeter-prefs.json`

function load(): GreeterPrefs {
  try {
    const [ok, data] = GLib.file_get_contents(PREFS_PATH)
    if (!ok) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(new TextDecoder().decode(data as Uint8Array)) }
  } catch {
    return { ...DEFAULTS }
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

// The login target the greeter should preselect: the last user who logged in
// from this greeter (saved by LoginCard on successful auth), falling back to
// the first human user. Also the right identity for the greeter's read of
// per-user config (appearance/region) — it belongs to whoever logs in here.
export function getPreferredUser(): User {
  const match = greeterPrefs.lastUser
    ? getUsers().find(u => u.username === greeterPrefs.lastUser)
    : undefined
  return match ?? getDefaultUser()
}
