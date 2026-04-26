import GLib from "gi://GLib"

type Locale = "en" | "es"

function detectLocale(): Locale {
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
    suspend:       "Sleep",
    restart:       "Restart",
    shutdown:      "Shut Down",
    dateFormat:    "%A, %B %-d",
  },
  es: {
    password:      "Contraseña",
    login:         "Iniciar sesión",
    authenticating:"Autenticando…",
    wrongPassword: "Contraseña incorrecta",
    noSession:     "No hay sesión disponible",
    loginError:    "Error al iniciar sesión",
    suspend:       "Suspender",
    restart:       "Reiniciar",
    shutdown:      "Apagar",
    dateFormat:    "%A, %-d de %B",
  },
} as const

export type StringKey = keyof typeof strings.en

const locale = detectLocale()

export function t(key: StringKey): string {
  return strings[locale][key]
}
