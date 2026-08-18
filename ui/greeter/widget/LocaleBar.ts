import Gtk from "gi://Gtk?version=4.0"
import { NidaraDropDown } from "../../lib/nidara-kit/scrolled"
import { ndImageProps } from "../../lib/icons"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { execAsync } from "../../lib/process"
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
  // ── Keyboard layout selector ────────────────────────────────────────────────
  // `NidaraDropDown`, not a raw `Gtk.DropDown`: still the native widget (its
  // popover is a real Wayland popup, which an in-window list can never be), but
  // with the kit's list factory and the kit's scroll bar inside it. The greeter
  // ran the raw one until 2026-08-10 and therefore still had GTK's checkmark in
  // every row and GTK's pointer-seeking scroll bar. Only the TRIGGER stays
  // greeter-styled — `.locale-bar-dropdown`, see style.scss for why.
  const currentLayout = detectCurrentLayout()
  const kbIds    = KB_LAYOUTS.map(l => l.id)
  const kbLabels = KB_LAYOUTS.map(l => l.label)

  const kbModel = new Gtk.StringList({ strings: kbLabels })
  const kbDrp = NidaraDropDown({
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

  // ── Language selector — same pattern as the keyboard one (12 languages don't
  // scale as toggle buttons). This is the ONE list on either screen long enough
  // to scroll, so it is the one that was actually losing clicks to GTK's
  // proximity-grown scroll bar. Picking one re-strings the
  // GREETER only: the session's language still comes from /etc/locale.conf
  // (Settings → Language) — greetd starts the session with an empty env.
  const langIds   = LANGUAGES.map(l => l.id)
  const langModel = new Gtk.StringList({ strings: LANGUAGES.map(l => l.label) })
  const langDrp = NidaraDropDown({
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
  const kbIcon = new Gtk.Image(ndImageProps("keyboard", "input-keyboard-symbolic", 12))
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

  // Painted like every other capsule on these two screens. This one carried the
  // OTHER failure mode of a CSS pill — `border-radius: pill` with a visible 1px
  // border puts the two arcs of each cap exactly tangent, and GTK leaves one
  // brighter pixel right there. Greeter-only widget, but the shape is shared.
  return withGlassCapsule(row)
}
