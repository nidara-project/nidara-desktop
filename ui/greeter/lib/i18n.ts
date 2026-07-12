import GLib from "gi://GLib"

// Mini-catalog: 12 keys × 12 languages. Deliberately duplicated per bundle
// (greeter and lockscreen each ship their own i18n.ts — see the skill's
// tech-debt notes). Power/password terminology mirrors the shell catalogs
// (bar.system-menu.*, settings.users.password) so the same word never renders
// two ways across login, lock and session.
const strings = {
  en: {
    password:      "Password",
    login:         "Sign in",
    authenticating:"Authenticating…",
    wrongPassword: "Wrong password",
    noSession:     "No session available",
    loginError:    "Error signing in",
    capsLock:      "Caps Lock is on",
    unlock:        "Unlock",
    unlocking:     "Verifying…",
    suspend:       "Sleep",
    restart:       "Restart",
    shutdown:      "Shut down",
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
  fr: {
    password:      "Mot de passe",
    login:         "Se connecter",
    authenticating:"Authentification…",
    wrongPassword: "Mot de passe incorrect",
    noSession:     "Aucune session disponible",
    loginError:    "Erreur de connexion",
    capsLock:      "Verrouillage majuscule activé",
    unlock:        "Déverrouiller",
    unlocking:     "Vérification…",
    suspend:       "Veille",
    restart:       "Redémarrer",
    shutdown:      "Éteindre",
  },
  de: {
    password:      "Passwort",
    login:         "Anmelden",
    authenticating:"Authentifizierung…",
    wrongPassword: "Falsches Passwort",
    noSession:     "Keine Sitzung verfügbar",
    loginError:    "Fehler bei der Anmeldung",
    capsLock:      "Feststelltaste ist aktiviert",
    unlock:        "Entsperren",
    unlocking:     "Überprüfung…",
    suspend:       "Ruhezustand",
    restart:       "Neu starten",
    shutdown:      "Herunterfahren",
  },
  it: {
    password:      "Password",
    login:         "Accedi",
    authenticating:"Autenticazione…",
    wrongPassword: "Password errata",
    noSession:     "Nessuna sessione disponibile",
    loginError:    "Errore di accesso",
    capsLock:      "Bloc Maiusc attivo",
    unlock:        "Sblocca",
    unlocking:     "Verifica…",
    suspend:       "Sospendi",
    restart:       "Riavvia",
    shutdown:      "Arresta",
  },
  "pt-BR": {
    password:      "Senha",
    login:         "Entrar",
    authenticating:"Autenticando…",
    wrongPassword: "Senha incorreta",
    noSession:     "Nenhuma sessão disponível",
    loginError:    "Erro ao entrar",
    capsLock:      "Caps Lock ativado",
    unlock:        "Desbloquear",
    unlocking:     "Verificando…",
    suspend:       "Suspender",
    restart:       "Reiniciar",
    shutdown:      "Desligar",
  },
  "pt-PT": {
    password:      "Palavra-passe",
    login:         "Iniciar sessão",
    authenticating:"A autenticar…",
    wrongPassword: "Palavra-passe incorreta",
    noSession:     "Nenhuma sessão disponível",
    loginError:    "Erro ao iniciar sessão",
    capsLock:      "Caps Lock ativado",
    unlock:        "Desbloquear",
    unlocking:     "A verificar…",
    suspend:       "Suspender",
    restart:       "Reiniciar",
    shutdown:      "Desligar",
  },
  pl: {
    password:      "Hasło",
    login:         "Zaloguj się",
    authenticating:"Uwierzytelnianie…",
    wrongPassword: "Nieprawidłowe hasło",
    noSession:     "Brak dostępnej sesji",
    loginError:    "Błąd logowania",
    capsLock:      "Caps Lock jest włączony",
    unlock:        "Odblokuj",
    unlocking:     "Weryfikacja…",
    suspend:       "Uśpij",
    restart:       "Uruchom ponownie",
    shutdown:      "Wyłącz",
  },
  nl: {
    password:      "Wachtwoord",
    login:         "Inloggen",
    authenticating:"Authenticeren…",
    wrongPassword: "Onjuist wachtwoord",
    noSession:     "Geen sessie beschikbaar",
    loginError:    "Fout bij inloggen",
    capsLock:      "Caps Lock staat aan",
    unlock:        "Ontgrendelen",
    unlocking:     "Verifiëren…",
    suspend:       "Slaapstand",
    restart:       "Opnieuw opstarten",
    shutdown:      "Uitschakelen",
  },
  ru: {
    password:      "Пароль",
    login:         "Войти",
    authenticating:"Аутентификация…",
    wrongPassword: "Неверный пароль",
    noSession:     "Нет доступных сеансов",
    loginError:    "Ошибка входа",
    capsLock:      "Включён Caps Lock",
    unlock:        "Разблокировать",
    unlocking:     "Проверка…",
    suspend:       "Спящий режим",
    restart:       "Перезагрузить",
    shutdown:      "Выключить",
  },
  "zh-CN": {
    password:      "密码",
    login:         "登录",
    authenticating:"正在认证…",
    wrongPassword: "密码错误",
    noSession:     "没有可用的会话",
    loginError:    "登录出错",
    capsLock:      "大写锁定已开启",
    unlock:        "解锁",
    unlocking:     "正在验证…",
    suspend:       "睡眠",
    restart:       "重新启动",
    shutdown:      "关机",
  },
  ja: {
    password:      "パスワード",
    login:         "ログイン",
    authenticating:"認証中…",
    wrongPassword: "パスワードが違います",
    noSession:     "利用可能なセッションがありません",
    loginError:    "ログインエラー",
    capsLock:      "Caps Lock がオンになっています",
    unlock:        "ロック解除",
    unlocking:     "確認中…",
    suspend:       "スリープ",
    restart:       "再起動",
    shutdown:      "シャットダウン",
  },
} as const

export type Locale = keyof typeof strings
export type StringKey = keyof typeof strings.en

// Same LANG-prefix chain as the shell's detectLanguage(). pt_br must match
// BEFORE the generic pt rule: Brazil gets pt-BR, while pt_PT/pt_AO/pt_MZ
// follow the European norm (pt-PT).
function localeFromLang(lang: string): Locale {
  const l = lang.toLowerCase()
  if (l.startsWith("es")) return "es"
  if (l.startsWith("fr")) return "fr"
  if (l.startsWith("de")) return "de"
  if (l.startsWith("it")) return "it"
  if (l.startsWith("pt_br")) return "pt-BR"
  if (l.startsWith("pt")) return "pt-PT"
  if (l.startsWith("pl")) return "pl"
  if (l.startsWith("nl")) return "nl"
  if (l.startsWith("ru")) return "ru"
  if (l.startsWith("zh")) return "zh-CN"
  if (l.startsWith("ja")) return "ja"
  return "en"
}

function detectLocale(): Locale {
  // Prefer saved greeter preference over LANG env. Same path greeter-prefs.ts
  // reads/writes (the greeter user's own config dir, /var/lib/greeter/.config).
  try {
    const [ok, data] = GLib.file_get_contents(`${GLib.get_user_config_dir()}/nidara/greeter-prefs.json`)
    if (ok) {
      const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
      if (typeof cfg.locale === "string" && cfg.locale in strings)
        return cfg.locale as Locale
    }
  } catch {}
  return localeFromLang(GLib.getenv("LANG") ?? "")
}

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
