// The languages Nidara SPEAKS, and the locale each one means.
//
// ─── WHY THIS LIST IS SHORT ON PURPOSE ───────────────────────────────────────
// The region work briefly offered all 328 locales glibc can generate, on the
// grounds that archinstall does. It was wrong, and the reason is the rule we had
// already written down and then walked past: **reduce the promise to what you can
// keep.** Offering Afar meant an installer that would carry on in English and an
// installed desktop that would too — the list said "you can have this" about a
// thing nobody can have.
//
// Calamares and Anaconda both curate to exactly what they translate
// (INFORME-LOCALE.md, question 2), for the stated reason that there is no point
// offering to install in a language the installer will not speak. This is that
// list, and it is the same twelve `ui/shell/core/i18n` ships, so the installed
// desktop speaks whatever was chosen here.
//
// ⚠️ A language is NOT a locale. "Spanish" is `es_ES`, `es_AR`, `es_MX` … — the
// TERRITORY comes from the country asked on the next page, which is why the two
// questions are separate and why this file only names a DEFAULT per language.
// `localeFor()` in lib/region.ts refines it once the country is known.
//
// ⚠️ Adding a language here without adding its catalogue to `lib/i18n.ts` puts the
// promise back exactly where it was.

import type { Locale } from "./i18n"

export interface Language {
  /** Our translation key — what `setLocale()` takes. */
  key: Locale
  /** The locale to use when the country says nothing more specific. */
  defaultLocale: string
  /** Two-letter glibc language code, for pairing with a country. */
  lang: string
}

export const LANGUAGES: Language[] = [
  { key: "en",    lang: "en", defaultLocale: "en_US.UTF-8" },
  { key: "es",    lang: "es", defaultLocale: "es_ES.UTF-8" },
  { key: "fr",    lang: "fr", defaultLocale: "fr_FR.UTF-8" },
  { key: "de",    lang: "de", defaultLocale: "de_DE.UTF-8" },
  { key: "it",    lang: "it", defaultLocale: "it_IT.UTF-8" },
  { key: "pt-BR", lang: "pt", defaultLocale: "pt_BR.UTF-8" },
  { key: "pt-PT", lang: "pt", defaultLocale: "pt_PT.UTF-8" },
  { key: "pl",    lang: "pl", defaultLocale: "pl_PL.UTF-8" },
  { key: "nl",    lang: "nl", defaultLocale: "nl_NL.UTF-8" },
  { key: "ru",    lang: "ru", defaultLocale: "ru_RU.UTF-8" },
  { key: "zh-CN", lang: "zh", defaultLocale: "zh_CN.UTF-8" },
  { key: "ja",    lang: "ja", defaultLocale: "ja_JP.UTF-8" },
]

/**
 * Which of the twelve a locale belongs to — the chain the shell's
 * `detectLanguage` and the greeter's `detectLocale` use, and it has to stay the
 * same chain or the installer and the desktop it installs would disagree about
 * what "pt" means.
 */
export function languageFor(locale: string): Language {
  const l = locale.toLowerCase()
  if (l.startsWith("pt_br")) return LANGUAGES.find(x => x.key === "pt-BR")!
  if (l.startsWith("pt")) return LANGUAGES.find(x => x.key === "pt-PT")!
  if (l.startsWith("zh")) return LANGUAGES.find(x => x.key === "zh-CN")!
  return LANGUAGES.find(x => l.startsWith(x.lang)) ?? LANGUAGES[0]
}
