import GLib from "gi://GLib"

import en from "./locales/en"
import es from "./locales/es"
import fr from "./locales/fr"
import de from "./locales/de"
import ptBR from "./locales/pt-BR"
import it from "./locales/it"
import pl from "./locales/pl"
import nl from "./locales/nl"
import ru from "./locales/ru"
import zhCN from "./locales/zh-CN"

type TranslationMap = Record<string, string>

const locales: Record<string, TranslationMap> = {
    en,
    es,
    fr,
    de,
    "pt-BR": ptBR,
    it,
    pl,
    nl,
    ru,
    "zh-CN": zhCN
}

let activeLocale = "en"

export function detectLanguage() {
    const langEnv = GLib.getenv("LANG") || ""
    if (langEnv.toLowerCase().startsWith("en")) activeLocale = "en"
    else if (langEnv.toLowerCase().startsWith("es")) activeLocale = "es"
    else if (langEnv.toLowerCase().startsWith("fr")) activeLocale = "fr"
    else if (langEnv.toLowerCase().startsWith("de")) activeLocale = "de"
    else if (langEnv.toLowerCase().startsWith("pt")) activeLocale = "pt-BR"
    else if (langEnv.toLowerCase().startsWith("it")) activeLocale = "it"
    else if (langEnv.toLowerCase().startsWith("pl")) activeLocale = "pl"
    else if (langEnv.toLowerCase().startsWith("nl")) activeLocale = "nl"
    else if (langEnv.toLowerCase().startsWith("ru")) activeLocale = "ru"
    else if (langEnv.toLowerCase().startsWith("zh")) activeLocale = "zh-CN"
    else activeLocale = "en" // fallback default
}

// Initial detection
detectLanguage()

/** The locale currently in effect ("en", "es", …) — e.g. for dumpState/diagnostics. */
export function currentLocale(): string {
    return activeLocale
}

// Key type derives from `en` — the canonical English-first source of truth. es (and
// future locales) may lag behind; missing translations fall back to en at runtime
// (below). Deriving from `es` would break the typecheck every time an English key is
// added mid-development, which contradicts the i18n workflow (translate in bulk at
// publication, not per-key).
export function t(key: keyof typeof en): string {
    const dict = locales[activeLocale] || locales["en"]
    const text = dict[key]
    if (text !== undefined) return text
    // Fallback to english if translation is missing
    return locales["en"][key as keyof typeof en] || key
}
