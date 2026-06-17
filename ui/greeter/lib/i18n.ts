import GLib from "gi://GLib"

export type Locale = "en" | "es"

function detectLocale(): Locale {
  // Prefer saved greeter preference over LANG env
  try {
    const [ok, data] = GLib.file_get_contents("/var/lib/greeter/.config/nidara/greeter-prefs.json")
    if (ok) {
      const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
      if (cfg.locale === "es") return "es"
      if (cfg.locale === "en") return "en"
    }
  } catch {}
  const lang = (GLib.getenv("LANG") ?? "").toLowerCase()
  if (lang.startsWith("es")) return "es"
  return "en"
}

const strings = {
  en: {
    password:      "Password",
    login:         "Sign In",
    authenticating:"Authenticating…",
    wrongPassword: "Wrong password",
    noSession:     "No session available",
    loginError:    "Error signing in",
    capsLock:      "Caps Lock is on",
    unlock:        "Unlock",
    unlocking:     "Verifying…",
    suspend:       "Sleep",
    restart:       "Restart",
    shutdown:      "Shut Down",
  },
  es: {
    password:      "Contraseña",
    login:         "Iniciar sesión",
    authenticating:"Autenticando…",
    wrongPassword: "Contraseña incorrecta",
    noSession:     "No hay sesión disponible",
    loginError:    "Error al iniciar sesión",
    capsLock:      "Bloq Mayús activado",
    unlock:        "Desbloquear",
    unlocking:     "Verificando…",
    suspend:       "Suspender",
    restart:       "Reiniciar",
    shutdown:      "Apagar",
  },
} as const

export type StringKey = keyof typeof strings.en

let _locale: Locale = detectLocale()
const _listeners: Array<() => void> = []

export function t(key: StringKey): string {
  return strings[_locale][key]
}

export function getLocale(): Locale {
  return _locale
}

export function setLocale(locale: Locale) {
  if (_locale === locale) return
  _locale = locale
  _listeners.forEach(fn => fn())
}

export function onLocaleChange(fn: () => void): () => void {
  _listeners.push(fn)
  return () => {
    const i = _listeners.indexOf(fn)
    if (i !== -1) _listeners.splice(i, 1)
  }
}
