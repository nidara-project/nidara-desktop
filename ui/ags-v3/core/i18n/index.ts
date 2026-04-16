import GLib from "gi://GLib"

import en from "./locales/en"
import es from "./locales/es"

type TranslationMap = Record<string, string>

const locales: Record<string, TranslationMap> = {
    en,
    es
}

let activeLocale = "en"

export function detectLanguage() {
    const langEnv = GLib.getenv("LANG") || ""
    if (langEnv.toLowerCase().startsWith("en")) activeLocale = "en"
    else if (langEnv.toLowerCase().startsWith("es")) activeLocale = "es"
    else activeLocale = "en" // fallback default
}

// Initial detection
detectLanguage()

export function t(key: keyof typeof es): string {
    const dict = locales[activeLocale] || locales["en"]
    const text = dict[key]
    if (text !== undefined) return text
    // Fallback to english if translation is missing
    return locales["en"][key as keyof typeof en] || key
}
