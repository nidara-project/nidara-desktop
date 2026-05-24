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

const LANGUAGES: Language[] = [
  { id: "en", label: "EN" },
  { id: "es", label: "ES" },
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
    execAsync(["hyprctl", "keyword", "input:kb_layout", id])
      .catch(e => console.warn("[LocaleBar] kb_layout change:", e))
  })

  // ── Language toggle buttons ───────────────────────────────────────────────
  const langBox = new Gtk.Box({ spacing: 2, css_classes: ["locale-bar-lang-group"] })

  for (const lang of LANGUAGES) {
    const btn = new Gtk.ToggleButton({
      label: lang.label,
      active: getLocale() === lang.id,
      css_classes: ["locale-bar-lang-btn"],
    })

    btn.connect("toggled", () => {
      if (!btn.active) return
      // Deactivate siblings
      let child = langBox.get_first_child()
      while (child) {
        if (child !== btn && child instanceof Gtk.ToggleButton)
          child.active = false
        child = child.get_next_sibling()
      }
      setLocale(lang.id)
      savePrefs({ locale: lang.id })
    })

    langBox.append(btn)
  }

  // ── Layout: [⌨ kbDrp] [sep] [lang buttons] ───────────────────────────────
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
  row.append(langBox)

  return row
}
