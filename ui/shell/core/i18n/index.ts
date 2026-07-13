import GLib from "gi://GLib"

import en from "./locales/en"
import es from "./locales/es"
import fr from "./locales/fr"
import de from "./locales/de"
import ptBR from "./locales/pt-BR"
import ptPT from "./locales/pt-PT"
import it from "./locales/it"
import pl from "./locales/pl"
import nl from "./locales/nl"
import ru from "./locales/ru"
import zhCN from "./locales/zh-CN"
import ja from "./locales/ja"

type TranslationMap = Record<string, string>

const locales: Record<string, TranslationMap> = {
    en,
    es,
    fr,
    de,
    "pt-BR": ptBR,
    "pt-PT": ptPT,
    it,
    pl,
    nl,
    ru,
    "zh-CN": zhCN,
    ja
}

let activeLocale = "en"

export function detectLanguage() {
    const langEnv = GLib.getenv("LANG") || ""
    const l = langEnv.toLowerCase()
    // pt_br must match before the generic pt rule: Brazil gets pt-BR, while
    // pt_PT/pt_AO/pt_MZ/… follow the European norm (pt-PT). Same chain as the
    // greeter's detectLocale().
    if (l.startsWith("en")) activeLocale = "en"
    else if (l.startsWith("es")) activeLocale = "es"
    else if (l.startsWith("fr")) activeLocale = "fr"
    else if (l.startsWith("de")) activeLocale = "de"
    else if (l.startsWith("pt_br")) activeLocale = "pt-BR"
    else if (l.startsWith("pt")) activeLocale = "pt-PT"
    else if (l.startsWith("it")) activeLocale = "it"
    else if (l.startsWith("pl")) activeLocale = "pl"
    else if (l.startsWith("nl")) activeLocale = "nl"
    else if (l.startsWith("ru")) activeLocale = "ru"
    else if (l.startsWith("zh")) activeLocale = "zh-CN"
    else if (l.startsWith("ja")) activeLocale = "ja"
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
