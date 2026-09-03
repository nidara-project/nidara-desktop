import Gtk from "gi://Gtk?version=4.0"
import { NidaraDropDown } from "../../lib/nidara-kit/scrolled"
import { ndImageProps } from "../../lib/icons"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { execAsync } from "../../lib/process"
import { languageMenuLabels } from "../../lib/locale-names"
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

// Endonyms, deliberately untranslated — everyone must be able to find their
// own language regardless of what the greeter currently speaks.
//
// ⚠️ The twelve labels are DERIVED, and they used to be twelve string literals
// here. The installer asks the same question two screens earlier and was
// answering it in another shape entirely ("español de España" against this
// file's "Español"), which is the drift `ui/lib/locale-names.ts` exists to end.
// `languageMenuLabels` decides the shape for both; the only visible change on
// this screen is 简体中文 → 中文, ICU's own name for the language while there is
// one Chinese in the list.
//
// ⚠️ Sorted by the label, in the collation of the language the greeter starts
// in — the same rule as the installer's list. Once, at load: the bar is built a
// single time (Greeter.ts) and re-strings itself in place afterwards, and a list
// that reshuffled itself under the pointer every time somebody browsed the
// dropdown would be worse than one whose order is a few percent off in another
// language's collation.
const LANGUAGE_IDS: Locale[] = [
  "en", "es", "fr", "de", "it", "pt-BR", "pt-PT", "pl", "nl", "ru", "zh-CN", "ja",
]

const LANGUAGES = languageMenuLabels(LANGUAGE_IDS)
  .map((label, i) => ({ id: LANGUAGE_IDS[i], label }))
  .sort((a, b) => a.label.localeCompare(b.label, getLocale()))

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
