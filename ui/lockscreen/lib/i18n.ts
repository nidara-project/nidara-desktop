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
    unlock:        "Unlock",
    unlocking:     "Verifying…",
    wrongPassword: "Wrong password",
    suspend:       "Sleep",
    restart:       "Restart",
    shutdown:      "Shut Down",
    dateFormat:    "%A, %B %-d",
  },
  es: {
    password:      "Contraseña",
    unlock:        "Desbloquear",
    unlocking:     "Verificando…",
    wrongPassword: "Contraseña incorrecta",
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
