import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { getLocale, setLocale, type Locale } from "../lib/i18n"
import { greeterPrefs, savePrefs } from "../lib/greeter-prefs"
import { CrystalSelect, CrystalOverlayManager } from "../../lib/crystal-ui"

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

export default function LocaleBar(manager: CrystalOverlayManager): Gtk.Widget {
  // ── Keyboard layout selector (CrystalSelect) ──────────────────────────────
  const currentLayout = detectCurrentLayout()

  const kbSelect = CrystalSelect(
    KB_LAYOUTS.map(l => ({ label: l.label, value: l.id })),
    currentLayout,
    manager,
    "locale-bar-dropdown",
  )

  // Explicit width so the list inherits a stable, consistent size
  kbSelect.widget.width_request = 100

  kbSelect.onChanged(value => {
    savePrefs({ kbLayout: value })
    execAsync(["hyprctl", "keyword", "input:kb_layout", value])
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

  // ── Layout: [⌨ kbSelect] [sep] [lang buttons] ────────────────────────────
  const kbIcon = new Gtk.Image({ icon_name: "input-keyboard-symbolic", pixel_size: 12 })
  kbIcon.add_css_class("locale-bar-icon")

  const row = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 8,
    halign: Gtk.Align.CENTER,
    css_classes: ["locale-bar"],
  })
  row.append(kbIcon)
  row.append(kbSelect.widget)
  row.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["locale-bar-sep"] }))
  row.append(langBox)

  return row
}
