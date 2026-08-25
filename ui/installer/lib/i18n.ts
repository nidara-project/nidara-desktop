import GLib from "gi://GLib"

// Mini-catalog: 22 keys × 12 languages. Deliberately duplicated per bundle
// (greeter, lockscreen, and installer each ship their own i18n.ts — see the skill's
// tech-debt notes).
const strings = {
  en: {
    back:                       "Back",
    continue:                   "Continue",
    of:                         "of",
    welcomeTitle:               "Install Nidara",
    welcomeHeading:             "Install Nidara on this computer",
    welcomeIntro:               "The installer asks for three things — which disk to use, the account to create, and a confirmation — and then installs the system you are looking at. Everything else it can read from this live session.",
    welcomeWarning:             "The disk you choose is erased. Nothing else on this computer is touched, and nothing is written until you confirm.",
    welcomeInstallsPrefix:      "This medium installs: ",
    welcomeReadingPrefix:       "Reading what this medium installs from ",
    welcomeNotMedium:           "This is not a Nidara installation medium: the product configuration at /usr/share/nidara-installer/base.json is missing, so there is nothing to install from. The window is running, but installation is unavailable.",
    diskTitle:                  "Select disk",
    diskHeading:                "Where should Nidara be installed?",
    diskWarning:                "The entire disk selected below will be erased. All existing partitions and data on it will be permanently destroyed.",
    diskNoDisks:                "No suitable installation disks found on this computer.",
    diskRemovable:              "Removable",
    pendingTitle:               "Not written yet",
    pendingHeading:             "The remaining steps are not built yet",
    pendingDisk:                "Disk — which one, and what is about to be destroyed",
    pendingAccount:             "Account — name, user name, password",
    pendingSummary:             "Summary — every default from this live session, editable",
    pendingProgress:            "Progress — archinstall's own output, with the log behind a disclosure",
    pendingFallback:            "Until they are, Nidara installs from a terminal: `archinstall`, with the medium's own configuration. nidara-iso/INSTALLER.md has the commands.",
  },
  es: {
    back:                       "Atrás",
    continue:                   "Continuar",
    of:                         "de",
    welcomeTitle:               "Instalar Nidara",
    welcomeHeading:             "Instalar Nidara en este equipo",
    welcomeIntro:               "El instalador te pedirá tres cosas: qué disco usar, la cuenta que deseas crear y una confirmación; luego instalará el sistema que estás viendo. Todo lo demás se obtiene de esta sesión en vivo.",
    welcomeWarning:             "El disco que elijas se borrará por completo. No se modificará nada más en este equipo y no se escribirá nada hasta que confirmes.",
    welcomeInstallsPrefix:      "Este medio instala: ",
    welcomeReadingPrefix:       "Leyendo lo que este medio instala desde ",
    welcomeNotMedium:           "Este no es un medio de instalación de Nidara: falta la configuración del producto en /usr/share/nidara-installer/base.json, por lo que no hay nada desde donde instalar. La ventana está abierta, pero la instalación no está disponible.",
    diskTitle:                  "Seleccionar disco",
    diskHeading:                "¿Dónde se debe instalar Nidara?",
    diskWarning:                "El disco seleccionado a continuación se borrará por completo. Todas las particiones y datos existentes en él se destruirán de forma permanente.",
    diskNoDisks:                "No se encontraron discos de instalación adecuados en este equipo.",
    diskRemovable:              "Extraíble",
    pendingTitle:               "Aún no desarrollado",
    pendingHeading:             "Los pasos restantes aún no están implementados",
    pendingDisk:                "Disco: cuál usar y qué datos se van a destruir",
    pendingAccount:             "Cuenta: nombre completo, usuario y contraseña",
    pendingSummary:             "Resumen: todas las opciones de esta sesión en vivo, editables",
    pendingProgress:            "Progreso: salida de archinstall, con el registro desplegable",
    pendingFallback:            "Mientras tanto, Nidara se instala desde la terminal: `archinstall`, con la configuración del propio medio. nidara-iso/INSTALLER.md contiene las instrucciones.",
  },
  fr: {
    back:                       "Retour",
    continue:                   "Continuer",
    of:                         "sur",
    welcomeTitle:               "Installer Nidara",
    welcomeHeading:             "Installer Nidara sur cet ordinateur",
    welcomeIntro:               "L'installateur demande trois choses : le disque à utiliser, le compte à créer et une confirmation, puis installe le système sous vos yeux. Tout le reste est extrait de cette session live.",
    welcomeWarning:             "Le disque sélectionné sera entièrement effacé. Rien d'autre sur cet ordinateur ne sera touché, et rien ne sera écrit avant votre confirmation.",
    welcomeInstallsPrefix:      "Ce support installe : ",
    welcomeReadingPrefix:       "Lecture du contenu à installer depuis ",
    welcomeNotMedium:           "Ceci n'est pas un support d'installation Nidara : la configuration du produit est absente de /usr/share/nidara-installer/base.json, il n'y a donc rien à installer. La fenêtre est active, mais l'installation est indisponible.",
    diskTitle:                  "Sélectionner le disque",
    diskHeading:                "Où installer Nidara ?",
    diskWarning:                "L'intégralité du disque sélectionné ci-dessous sera effacée. Toutes les partitions et données existantes seront définitivement détruites.",
    diskNoDisks:                "Aucun disque d'installation approprié trouvé sur cet ordinateur.",
    diskRemovable:              "Amovible",
    pendingTitle:               "Pas encore implémenté",
    pendingHeading:             "Les étapes restantes ne sont pas encore prêtes",
    pendingDisk:                "Disque : lequel utiliser et ce qui va être détruit",
    pendingAccount:             "Compte : nom, nom d'utilisateur, mot de passe",
    pendingSummary:             "Résumé : toutes les valeurs de cette session live, modifiables",
    pendingProgress:            "Progression : sortie d'archinstall, journal accessible via un volet",
    pendingFallback:            "En attendant, Nidara s'installe depuis un terminal : `archinstall`, avec la configuration du support. nidara-iso/INSTALLER.md contient les commandes.",
  },
  de: {
    back:                       "Zurück",
    continue:                   "Weiter",
    of:                         "von",
    welcomeTitle:               "Nidara installieren",
    welcomeHeading:             "Nidara auf diesem Computer installieren",
    welcomeIntro:               "Das Installationsprogramm fragt nach drei Dingen: welcher Datenträger verwendet werden soll, das zu erstellende Konto und eine Bestätigung — und installiert dann das System, das Sie vor sich sehen. Alles andere wird aus dieser Live-Sitzung übernommen.",
    welcomeWarning:             "Der ausgewählte Datenträger wird vollständig gelöscht. Auf diesem Computer wird nichts anderes verändert und vor Ihrer Bestätigung wird nichts geschrieben.",
    welcomeInstallsPrefix:      "Dieses Medium installiert: ",
    welcomeReadingPrefix:       "Lese die zu installierenden Pakete aus ",
    welcomeNotMedium:           "Dies ist kein Nidara-Installationsmedium: Die Produktkonfiguration unter /usr/share/nidara-installer/base.json fehlt, daher ist keine Installationsquelle vorhanden. Das Fenster läuft, aber die Installation ist nicht verfügbar.",
    diskTitle:                  "Datenträger auswählen",
    diskHeading:                "Wo soll Nidara installiert werden?",
    diskWarning:                "Der unten ausgewählte Datenträger wird vollständig gelöscht. Alle darauf vorhandenen Partitionen und Daten werden unwiderruflich zerstört.",
    diskNoDisks:                "Keine geeigneten Installationsdatenträger auf diesem Computer gefunden.",
    diskRemovable:              "Wechseldatenträger",
    pendingTitle:               "Noch nicht implementiert",
    pendingHeading:             "Die restlichen Schritte sind noch nicht implementiert",
    pendingDisk:                "Datenträger — welcher Datenträger und was gelöscht wird",
    pendingAccount:             "Konto — Name, Benutzername, Passwort",
    pendingSummary:             "Zusammenfassung — alle Vorgaben dieser Live-Sitzung, anpassbar",
    pendingProgress:            "Fortschritt — Ausgabe von archinstall mit Protokoll zum Aufklappen",
    pendingFallback:            "Bis dahin erfolgt die Installation von Nidara über ein Terminal: `archinstall` mit der Konfiguration des Mediums. Befehle siehe nidara-iso/INSTALLER.md.",
  },
  it: {
    back:                       "Indietro",
    continue:                   "Continua",
    of:                         "di",
    welcomeTitle:               "Installa Nidara",
    welcomeHeading:             "Installa Nidara su questo computer",
    welcomeIntro:               "L'installer richiede tre elementi: quale disco utilizzare, l'account da creare e una conferma, quindi installerà il sistema che stai visualizzando. Tutto il resto viene letto da questa sessione live.",
    welcomeWarning:             "Il disco selezionato verrà cancellato. Nessun altro dato su questo computer verrà toccato e nulla verrà scritto fino alla tua conferma.",
    welcomeInstallsPrefix:      "Questo supporto installa: ",
    welcomeReadingPrefix:       "Lettura dei pacchetti da installare da ",
    welcomeNotMedium:           "Questo non è un supporto di installazione di Nidara: la configurazione del prodotto in /usr/share/nidara-installer/base.json è assente, quindi non c'è nulla da installare. La finestra è attiva, ma l'installazione non è disponibile.",
    diskTitle:                  "Seleziona disco",
    diskHeading:                "Dove desideri installare Nidara?",
    diskWarning:                "L'intero disco selezionato qui sotto verrà cancellato. Tutte le partizioni e i dati esistenti saranno distrutti in modo permanente.",
    diskNoDisks:                "Nessun disco di installazione idoneo trovato su questo computer.",
    diskRemovable:              "Rimovibile",
    pendingTitle:               "Non ancora implementato",
    pendingHeading:             "I passaggi rimanenti non sono ancora stati creati",
    pendingDisk:                "Disco — quale utilizzare e cosa verrà eliminato",
    pendingAccount:             "Account — nome, nome utente, password",
    pendingSummary:             "Riepilogo — tutte le impostazioni della sessione live, modificabili",
    pendingProgress:            "Avanzamento — output di archinstall, con registro visualizzabile",
    pendingFallback:            "Nel frattempo, Nidara si installa da terminale: `archinstall`, con la configurazione del supporto. nidara-iso/INSTALLER.md contiene i comandi.",
  },
  "pt-BR": {
    back:                       "Voltar",
    continue:                   "Continuar",
    of:                         "de",
    welcomeTitle:               "Instalar o Nidara",
    welcomeHeading:             "Instalar o Nidara neste computador",
    welcomeIntro:               "O instalador solicita três coisas: qual disco usar, a conta a ser criada e uma confirmação — e depois instala o sistema que você está vendo. Todo o resto é lido a partir desta sessão live.",
    welcomeWarning:             "O disco selecionado será completamente apagado. Nada mais neste computador será alterado e nada será gravado até a sua confirmação.",
    welcomeInstallsPrefix:      "Este meio instala: ",
    welcomeReadingPrefix:       "Lendo o que este meio instala a partir de ",
    welcomeNotMedium:           "Este não é um meio de instalação do Nidara: a configuração do produto em /usr/share/nidara-installer/base.json está ausente, portanto não há de onde instalar. A janela está aberta, mas a instalação não está disponível.",
    diskTitle:                  "Selecionar disco",
    diskHeading:                "Onde o Nidara deve ser instalado?",
    diskWarning:                "O disco selecionado abaixo será totalmente apagado. Todas as partições e dados existentes nele serão permanentemente destruídos.",
    diskNoDisks:                "Nenhum disco de instalação adequado foi encontrado neste computador.",
    diskRemovable:              "Removível",
    pendingTitle:               "Ainda não implementado",
    pendingHeading:             "As etapas restantes ainda não foram criadas",
    pendingDisk:                "Disco — qual usar e o que será destruído",
    pendingAccount:             "Conta — nome, nome de usuário, senha",
    pendingSummary:             "Resumo — todos os padrões desta sessão live, editáveis",
    pendingProgress:            "Progresso — saída do archinstall, com log recolhível",
    pendingFallback:            "Enquanto isso, o Nidara é instalado pelo terminal: `archinstall`, com a configuração do próprio meio. nidara-iso/INSTALLER.md contém os comandos.",
  },
  "pt-PT": {
    back:                       "Voltar",
    continue:                   "Continuar",
    of:                         "de",
    welcomeTitle:               "Instalar o Nidara",
    welcomeHeading:             "Instalar o Nidara neste computador",
    welcomeIntro:               "O instalador solicita três coisas: qual disco utilizar, a conta a criar e uma confirmação — e depois instala o sistema que está a ver. Tudo o resto é lido a partir desta sessão live.",
    welcomeWarning:             "O disco selecionado será completamente apagado. Nada mais neste computador será alterado e nada será gravado até à sua confirmação.",
    welcomeInstallsPrefix:      "Este meio instala: ",
    welcomeReadingPrefix:       "A ler o que este meio instala a partir de ",
    welcomeNotMedium:           "Este não é um meio de instalação do Nidara: a configuração do produto em /usr/share/nidara-installer/base.json está em falta, pelo que não há de onde instalar. A janela está aberta, mas a instalação não está disponível.",
    diskTitle:                  "Selecionar disco",
    diskHeading:                "Onde deve o Nidara ser instalado?",
    diskWarning:                "O disco selecionado abaixo será totalmente apagado. Todas as partições e dados nele existentes serão permanentemente destruídos.",
    diskNoDisks:                "Nenhum disco de instalação adequado foi encontrado neste computador.",
    diskRemovable:              "Amovível",
    pendingTitle:               "Ainda não implementado",
    pendingHeading:             "Os passos restantes ainda não foram criados",
    pendingDisk:                "Disco — qual utilizar e o que será destruído",
    pendingAccount:             "Conta — nome, nome de utilizador, palavra-passe",
    pendingSummary:             "Resumo — todas as predefinições desta sessão live, editáveis",
    pendingProgress:            "Progresso — saída do archinstall, com registo recolhível",
    pendingFallback:            "Enquanto isso, o Nidara é instalado pelo terminal: `archinstall`, com a configuração do próprio meio. nidara-iso/INSTALLER.md contém os comandos.",
  },
  pl: {
    back:                       "Wstecz",
    continue:                   "Dalej",
    of:                         "z",
    welcomeTitle:               "Zainstaluj Nidara",
    welcomeHeading:             "Zainstaluj Nidara na tym komputerze",
    welcomeIntro:               "Instalator zapyta o trzy rzeczy: który dysk wybrać, konto do utworzenia oraz potwierdzenie — a następnie zainstaluje system, który widzisz. Cała reszta zostanie odczytana z tej sesji live.",
    welcomeWarning:             "Wybrany dysk zostanie całkowicie wymazany. Nic innego na tym komputerze nie zostanie naruszone i nic nie zostanie zapisane przed Twoim potwierdzeniem.",
    welcomeInstallsPrefix:      "Ten nośnik instaluje: ",
    welcomeReadingPrefix:       "Odczytywanie zawartości instalatora z ",
    welcomeNotMedium:           "To nie jest nośnik instalacyjny Nidara: brak konfiguracji produktu w /usr/share/nidara-installer/base.json, więc nie ma z czego zainstalować systemu. Okno jest uruchomione, ale instalacja jest niedostępna.",
    diskTitle:                  "Wybierz dysk",
    diskHeading:                "Gdzie zainstalować Nidara?",
    diskWarning:                "Cały wybrany poniżej dysk zostanie wymazany. Wszystkie istniejące na nim partycje i dane zostaną trwale zniszczone.",
    diskNoDisks:                "Nie znaleziono odpowiednich dysków instalacyjnych na tym komputerze.",
    diskRemovable:              "Dysk wymienny",
    pendingTitle:               "Jeszcze nie zaimplementowano",
    pendingHeading:             "Pozostałe kroki nie zostały jeszcze zaimplementowane",
    pendingDisk:                "Dysk — który wybrać i co zostanie usunięte",
    pendingAccount:             "Konto — imię i nazwisko, nazwa użytkownika, hasło",
    pendingSummary:             "Podsumowanie — wszystkie ustawienia z tej sesji live, edytowalne",
    pendingProgress:            "Postęp — bezpośrednie wyjście archinstall z rozwijanym dziennikiem",
    pendingFallback:            "Do tego czasu Nidara instaluje się z terminala: `archinstall` z konfiguracją nośnika. Instrukcje znajdują się w nidara-iso/INSTALLER.md.",
  },
  nl: {
    back:                       "Terug",
    continue:                   "Doorgaan",
    of:                         "van",
    welcomeTitle:               "Nidara installeren",
    welcomeHeading:             "Nidara op deze computer installeren",
    welcomeIntro:               "Het installatieprogramma vraagt om drie dingen: welke schijf te gebruiken, het aan te maken account en een bevestiging — en installeert vervolgens het systeem dat u ziet. Al het overige wordt uit deze live-sessie gelezen.",
    welcomeWarning:             "De geselecteerde schijf wordt gewist. Er wordt niets anders op deze computer gewijzigd en er wordt niets geschreven totdat u bevestigt.",
    welcomeInstallsPrefix:      "Dit medium installeert: ",
    welcomeReadingPrefix:       "Lezen wat dit medium installeert vanaf ",
    welcomeNotMedium:           "Dit is geen Nidara-installatiemedium: de productconfiguratie op /usr/share/nidara-installer/base.json ontbreekt, dus er is niets om vanaf te installeren. Het venster is geopend, maar installatie is niet beschikbaar.",
    diskTitle:                  "Schijf selecteren",
    diskHeading:                "Waar moet Nidara worden geïnstalleerd?",
    diskWarning:                "De hieronder geselecteerde schijf wordt volledig gewist. Alle bestaande partities en gegevens erop worden definitief vernietigd.",
    diskNoDisks:                "Geen geschikte installatieschijven gevonden op deze computer.",
    diskRemovable:              "Verwijderbaar",
    pendingTitle:               "Nog niet geïmplementeerd",
    pendingHeading:             "De resterende stappen zijn nog niet gebouwd",
    pendingDisk:                "Schijf — welke te gebruiken en wat er gewist wordt",
    pendingAccount:             "Account — naam, gebruikersnaam, wachtwoord",
    pendingSummary:             "Samenvatting — alle standaardwaarden van deze live-sessie, bewerkbaar",
    pendingProgress:            "Voortgang — uitvoer van archinstall, met het logboek achter een uitklapmenu",
    pendingFallback:            "Tot die tijd installeert Nidara vanaf een terminal: `archinstall`, met de configuratie van het medium. nidara-iso/INSTALLER.md bevat de opdrachten.",
  },
  ru: {
    back:                       "Назад",
    continue:                   "Продолжить",
    of:                         "из",
    welcomeTitle:               "Установить Nidara",
    welcomeHeading:             "Установить Nidara на этот компьютер",
    welcomeIntro:               "Программа установки запрашивает три вещи: используемый диск, создаваемую учётную запись и подтверждение — после чего устанавливает систему, которую вы видите. Всё остальное считывается из этого live-сеанса.",
    welcomeWarning:             "Выбранный диск будет полностью стёрт. Никакие другие данные на этом компьютере затронуты не будут, и запись начнётся только после вашего подтверждения.",
    welcomeInstallsPrefix:      "Этот носитель устанавливает: ",
    welcomeReadingPrefix:       "Чтение списка устанавливаемых пакетов из ",
    welcomeNotMedium:           "Это не установочный носитель Nidara: отсутствует конфигурация продукта в /usr/share/nidara-installer/base.json, поэтому устанавливать не из чего. Окно открыто, но установка недоступна.",
    diskTitle:                  "Выбор диска",
    diskHeading:                "Куда установить Nidara?",
    diskWarning:                "Выбранный ниже диск будет полностью стёрт. Все существующие на нём разделы и данные будут безвозвратно уничтожены.",
    diskNoDisks:                "На этом компьютере не найдено подходящих дисков для установки.",
    diskRemovable:              "Съёмный",
    pendingTitle:               "Ещё не реализовано",
    pendingHeading:             "Остальные шаги ещё не реализованы",
    pendingDisk:                "Диск — какой выбрать и что будет удалено",
    pendingAccount:             "Учётная запись — имя, имя пользователя, пароль",
    pendingSummary:             "Сводка — все параметры из этого live-сеанса, доступные для изменения",
    pendingProgress:            "Ход выполнения — вывод archinstall с журналом под спойлером",
    pendingFallback:            "Пока этого нет, Nidara устанавливается через терминал: `archinstall` с конфигурацией носителя. Команды описаны в nidara-iso/INSTALLER.md.",
  },
  "zh-CN": {
    back:                       "后退",
    continue:                   "继续",
    of:                         "/",
    welcomeTitle:               "安装 Nidara",
    welcomeHeading:             "在此计算机上安装 Nidara",
    welcomeIntro:               "安装程序需要三项信息：要使用的磁盘、要创建的账户以及最终确认 — 然后安装您当前看到的系统。其他所有内容均从本次实时会话中读取。",
    welcomeWarning:             "所选磁盘将被完全抹除。此计算机上的其他任何内容均不会被改动，在您确认之前不会写入任何数据。",
    welcomeInstallsPrefix:      "此介质将安装：",
    welcomeReadingPrefix:       "正在读取此介质的安装内容：",
    welcomeNotMedium:           "这不是 Nidara 安装介质：缺少位于 /usr/share/nidara-installer/base.json 的产品配置，因此无法进行安装。窗口正在运行，但安装不可用。",
    diskTitle:                  "选择磁盘",
    diskHeading:                "在何处安装 Nidara？",
    diskWarning:                "下方选定的整个磁盘将被抹除。其上的所有现有分区和数据都将被永久销毁。",
    diskNoDisks:                "在此计算机上未找到合适的安装磁盘。",
    diskRemovable:              "可移动",
    pendingTitle:               "尚未实现",
    pendingHeading:             "其余步骤尚未构建",
    pendingDisk:                "磁盘 — 选择目标磁盘及将被清除的内容",
    pendingAccount:             "账户 — 姓名、用户名、密码",
    pendingSummary:             "摘要 — 来自当前实时会话的所有默认项，可编辑",
    pendingProgress:            "进度 — archinstall 自身输出，附带可折叠的日志",
    pendingFallback:            "在此之前，可以通过终端安装 Nidara：使用介质自带的配置运行 `archinstall`。命令请参考 nidara-iso/INSTALLER.md。",
  },
  ja: {
    back:                       "戻る",
    continue:                   "続ける",
    of:                         "/",
    welcomeTitle:               "Nidara をインストール",
    welcomeHeading:             "このコンピューターに Nidara をインストール",
    welcomeIntro:               "インストーラーは、使用するディスク、作成するアカウント、そして確認の3点を確認し、現在表示されているシステムをインストールします。それ以外の設定はすべてこのライブセッションから読み込まれます。",
    welcomeWarning:             "選択したディスクは完全に消去されます。このコンピューター上の他のデータには一切影響せず、確認するまで何も書き込まれません。",
    welcomeInstallsPrefix:      "このメディアがインストールするパッケージ: ",
    welcomeReadingPrefix:       "インストール内容を読み込み中: ",
    welcomeNotMedium:           "これは Nidara のインストールメディアではありません。/usr/share/nidara-installer/base.json に製品設定が見つからないため、インストールできません。ウィンドウは実行中ですが、インストールは利用できません。",
    diskTitle:                  "ディスクの選択",
    diskHeading:                "Nidara をどこにインストールしますか？",
    diskWarning:                "以下で選択したディスク全体が消去されます。既存のすべてのパーティションとデータは完全に破棄されます。",
    diskNoDisks:                "このコンピューターに適したインストールディスクが見つかりませんでした。",
    diskRemovable:              "リムーバブル",
    pendingTitle:               "未実装",
    pendingHeading:             "残りのステップはまだ作成されていません",
    pendingDisk:                "ディスク — 使用するディスクと消去される内容",
    pendingAccount:             "アカウント — 氏名、ユーザー名、パスワード",
    pendingSummary:             "概要 — このライブセッションのすべての既定値（編集可能）",
    pendingProgress:            "進行状況 — archinstall の出力（ログは折りたたみ表示）",
    pendingFallback:            "実装されるまでは、ターミナルからインストールします。メディア付属の設定で `archinstall` を実行してください。コマンドは nidara-iso/INSTALLER.md に記載されています。",
  },
} as const

export type Locale = keyof typeof strings
export type StringKey = keyof typeof strings.en

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
  const lang = GLib.getenv("LANG")
  if (lang) return localeFromLang(lang)
  try {
    const [ok, data] = GLib.file_get_contents("/etc/locale.conf")
    if (ok) {
      const m = new TextDecoder().decode(data as Uint8Array).match(/^LANG=["']?([^"'\n]+)/m)
      if (m) return localeFromLang(m[1])
    }
  } catch {}
  return "en"
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
