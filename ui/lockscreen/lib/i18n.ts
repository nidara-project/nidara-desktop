import GLib from "gi://GLib"

// Mini-catalog: 10 keys × 12 languages. Deliberately duplicated per bundle
// (greeter and lockscreen each ship their own i18n.ts — see the skill's
// tech-debt notes). Terminology mirrors the shell catalogs (bar.system-menu.*,
// settings.users.password). No selector and no live-switch on purpose: the
// lockscreen speaks the language of the session it locks (LANG), resolved
// once at module load.
const strings = {
  en: {
    password:           "Password",
    unlock:             "Unlock",
    unlocking:          "Verifying…",
    wrongPassword:      "Wrong password",
    accountUnavailable: "Account unavailable",
    passwordExpired:    "Password expired",
    passwordExpiredHow: "Change it at your next login.",
    suspend:            "Sleep",
    restart:            "Restart",
    shutdown:           "Shut down",
  },
  es: {
    password:           "Contraseña",
    unlock:             "Desbloquear",
    unlocking:          "Verificando…",
    wrongPassword:      "Contraseña incorrecta",
    accountUnavailable: "Cuenta no disponible",
    passwordExpired:    "Contraseña caducada",
    passwordExpiredHow: "Cámbiala en el próximo inicio de sesión.",
    suspend:            "Suspender",
    restart:            "Reiniciar",
    shutdown:           "Apagar",
  },
  fr: {
    password:           "Mot de passe",
    unlock:             "Déverrouiller",
    unlocking:          "Vérification…",
    wrongPassword:      "Mot de passe incorrect",
    accountUnavailable: "Compte indisponible",
    passwordExpired:    "Mot de passe expiré",
    passwordExpiredHow: "Changez-le à votre prochaine connexion.",
    suspend:            "Veille",
    restart:            "Redémarrer",
    shutdown:           "Éteindre",
  },
  de: {
    password:           "Passwort",
    unlock:             "Entsperren",
    unlocking:          "Überprüfung…",
    wrongPassword:      "Falsches Passwort",
    accountUnavailable: "Konto nicht verfügbar",
    passwordExpired:    "Passwort abgelaufen",
    passwordExpiredHow: "Ändern Sie es bei der nächsten Anmeldung.",
    suspend:            "Ruhezustand",
    restart:            "Neu starten",
    shutdown:           "Herunterfahren",
  },
  it: {
    password:           "Password",
    unlock:             "Sblocca",
    unlocking:          "Verifica…",
    wrongPassword:      "Password errata",
    accountUnavailable: "Account non disponibile",
    passwordExpired:    "Password scaduta",
    passwordExpiredHow: "Cambiala al prossimo accesso.",
    suspend:            "Sospendi",
    restart:            "Riavvia",
    shutdown:           "Arresta",
  },
  "pt-BR": {
    password:           "Senha",
    unlock:             "Desbloquear",
    unlocking:          "Verificando…",
    wrongPassword:      "Senha incorreta",
    accountUnavailable: "Conta indisponível",
    passwordExpired:    "Senha expirada",
    passwordExpiredHow: "Altere-a no próximo login.",
    suspend:            "Suspender",
    restart:            "Reiniciar",
    shutdown:           "Desligar",
  },
  "pt-PT": {
    password:           "Palavra-passe",
    unlock:             "Desbloquear",
    unlocking:          "A verificar…",
    wrongPassword:      "Palavra-passe incorreta",
    accountUnavailable: "Conta indisponível",
    passwordExpired:    "Palavra-passe expirada",
    passwordExpiredHow: "Altere-a no próximo início de sessão.",
    suspend:            "Suspender",
    restart:            "Reiniciar",
    shutdown:           "Desligar",
  },
  pl: {
    password:           "Hasło",
    unlock:             "Odblokuj",
    unlocking:          "Weryfikacja…",
    wrongPassword:      "Nieprawidłowe hasło",
    accountUnavailable: "Konto niedostępne",
    passwordExpired:    "Hasło wygasło",
    passwordExpiredHow: "Zmień je przy następnym logowaniu.",
    suspend:            "Uśpij",
    restart:            "Uruchom ponownie",
    shutdown:           "Wyłącz",
  },
  nl: {
    password:           "Wachtwoord",
    unlock:             "Ontgrendelen",
    unlocking:          "Verifiëren…",
    wrongPassword:      "Onjuist wachtwoord",
    accountUnavailable: "Account niet beschikbaar",
    passwordExpired:    "Wachtwoord verlopen",
    passwordExpiredHow: "Wijzig het bij de volgende aanmelding.",
    suspend:            "Slaapstand",
    restart:            "Opnieuw opstarten",
    shutdown:           "Uitschakelen",
  },
  ru: {
    password:           "Пароль",
    unlock:             "Разблокировать",
    unlocking:          "Проверка…",
    wrongPassword:      "Неверный пароль",
    accountUnavailable: "Учётная запись недоступна",
    passwordExpired:    "Срок действия пароля истёк",
    passwordExpiredHow: "Измените его при следующем входе.",
    suspend:            "Спящий режим",
    restart:            "Перезагрузить",
    shutdown:           "Выключить",
  },
  "zh-CN": {
    password:           "密码",
    unlock:             "解锁",
    unlocking:          "正在验证…",
    wrongPassword:      "密码错误",
    accountUnavailable: "账户不可用",
    passwordExpired:    "密码已过期",
    passwordExpiredHow: "请在下次登录时更改。",
    suspend:            "睡眠",
    restart:            "重新启动",
    shutdown:           "关机",
  },
  ja: {
    password:           "パスワード",
    unlock:             "ロック解除",
    unlocking:          "確認中…",
    wrongPassword:      "パスワードが違います",
    accountUnavailable: "アカウントを利用できません",
    passwordExpired:    "パスワードの有効期限が切れています",
    passwordExpiredHow: "次回のログイン時に変更してください。",
    suspend:            "スリープ",
    restart:            "再起動",
    shutdown:           "シャットダウン",
  },
} as const

type Locale = keyof typeof strings

// Same LANG-prefix chain as the shell's detectLanguage(). pt_br must match
// BEFORE the generic pt rule: Brazil gets pt-BR, while pt_PT/pt_AO/pt_MZ
// follow the European norm (pt-PT).
function detectLocale(): Locale {
  const lang = (GLib.getenv("LANG") ?? "").toLowerCase()
  if (lang.startsWith("es")) return "es"
  if (lang.startsWith("fr")) return "fr"
  if (lang.startsWith("de")) return "de"
  if (lang.startsWith("it")) return "it"
  if (lang.startsWith("pt_br")) return "pt-BR"
  if (lang.startsWith("pt")) return "pt-PT"
  if (lang.startsWith("pl")) return "pl"
  if (lang.startsWith("nl")) return "nl"
  if (lang.startsWith("ru")) return "ru"
  if (lang.startsWith("zh")) return "zh-CN"
  if (lang.startsWith("ja")) return "ja"
  return "en"
}

export type StringKey = keyof typeof strings.en

const locale = detectLocale()

export function t(key: StringKey): string {
  return strings[locale][key]
}
