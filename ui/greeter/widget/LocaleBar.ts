import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { getLocale, setLocale, type Locale } from "../lib/i18n"
import { greeterPrefs, savePrefs } from "../lib/greeter-prefs"

// ── Keyboard layouts ──────────────────────────────────────────────────────────

interface KbLayout {
  id: string
  label: string
}

const KB_LAYOUTS: KbLayout[] = [
  { id: "us",    label: "US" },
  { id: "gb",    label: "UK" },
  { id: "es",    label: "ES" },
  { id: "latam", label: "LATAM" },
  { id: "de",    label: "DE" },
  { id: "fr",    label: "FR" },
  { id: "it",    label: "IT" },
  { id: "pt",    label: "PT" },
  { id: "br",    label: "BR" },
  { id: "ru",    label: "RU" },
]

function detectCurrentLayout(): string {
  return greeterPrefs.kbLayout || "us"
}

// ── Languages ─────────────────────────────────────────────────────────────────

interface Language {
  id: Locale
  label: string
}

// Endonyms, deliberately untranslated — everyone must be able to find their
// own language regardless of what the greeter currently speaks.
const LANGUAGES: Language[] = [
  { id: "en",    label: "English" },
  { id: "es",    label: "Español" },
  { id: "fr",    label: "Français" },
  { id: "de",    label: "Deutsch" },
  { id: "it",    label: "Italiano" },
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "pt-PT", label: "Português (Portugal)" },
  { id: "pl",    label: "Polski" },
  { id: "nl",    label: "Nederlands" },
  { id: "ru",    label: "Русский" },
  { id: "zh-CN", label: "简体中文" },
  { id: "ja",    label: "日本語" },
]

// ── Widget ────────────────────────────────────────────────────────────────────

export default function LocaleBar(): Gtk.Widget {
  // ── Keyboard layout selector — Gtk.DropDown (auto-positions, no off-screen bug)
  const currentLayout = detectCurrentLayout()
  const kbIds    = KB_LAYOUTS.map(l => l.id)
  const kbLabels = KB_LAYOUTS.map(l => l.label)

  const kbModel = new Gtk.StringList({ strings: kbLabels })
  const kbDrp = new Gtk.DropDown({
    model: kbModel,
    valign: Gtk.Align.CENTER,
    css_classes: ["locale-bar-dropdown"],
  })
  const initKbIdx = kbIds.indexOf(currentLayout)
  kbDrp.selected = initKbIdx >= 0 ? initKbIdx : 0

  kbDrp.connect("notify::selected", () => {
    const id = kbIds[kbDrp.selected]
    if (!id) return
    savePrefs({ kbLayout: id })
    // The greeter also runs under Hyprland's Lua parser (hyprland-greeter.lua),
    // which rejects `hyprctl keyword` — apply via eval.
    execAsync(["hyprctl", "eval", `hl.config({ input = { kb_layout = "${id}" } })`])
      .catch(e => console.warn("[LocaleBar] kb_layout change:", e))
  })

  // ── Language selector — same DropDown pattern as the keyboard one (12
  // languages don't scale as toggle buttons). Picking one re-strings the
  // GREETER only: the session's language still comes from /etc/locale.conf
  // (Settings → Language) — greetd starts the session with an empty env.
  const langIds   = LANGUAGES.map(l => l.id)
  const langModel = new Gtk.StringList({ strings: LANGUAGES.map(l => l.label) })
  const langDrp = new Gtk.DropDown({
    model: langModel,
    valign: Gtk.Align.CENTER,
    css_classes: ["locale-bar-dropdown"],
  })
  const initLangIdx = langIds.indexOf(getLocale())
  langDrp.selected = initLangIdx >= 0 ? initLangIdx : 0

  langDrp.connect("notify::selected", () => {
    const id = langIds[langDrp.selected]
    if (!id) return
    setLocale(id)
    savePrefs({ locale: id })
  })

  // ── Layout: [⌨ kbDrp] [sep] [langDrp] ─────────────────────────────────────
  const kbIcon = new Gtk.Image({ icon_name: "input-keyboard-symbolic", pixel_size: 12 })
  kbIcon.add_css_class("locale-bar-icon")

  const row = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 8,
    halign: Gtk.Align.CENTER,
    css_classes: ["locale-bar"],
  })
  row.append(kbIcon)
  row.append(kbDrp)
  row.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["locale-bar-sep"] }))
  row.append(langDrp)

  return row
}
