// Common helpers for installer step pages.
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { NidaraList, NidaraScrolled, NidaraSelectionCheck, NidaraEmptyRow } from "../../lib/nidara-kit"
import { searchFold } from "../../lib/locale-names"
import { t } from "../lib/i18n"

export function heading(text: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: ["installer-heading"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
  })
}

export function prose(text: string, extraClass?: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: extraClass ? ["installer-prose", extraClass] : ["installer-prose"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
    wrap: true,
    wrap_mode: Pango.WrapMode.WORD_CHAR,
  })
}

/**
 * A searchable list of things to pick one of.
 *
 * Second use in this bundle (the country list was the first, the language list is
 * this one), which is why it is factored out here rather than copied. It is a
 * candidate for `ui/lib/nidara-kit/` — a third use, or the first one outside the
 * installer, is what should promote it; Settings has no long pick-one list today.
 *
 * ⚠️ A plain `Gtk.Entry`, never a `Gtk.SearchEntry`. The installer's sheet styles
 * `entry`; a SearchEntry draws on `entry.search` with its own icon and clear
 * button, none of which is styled here, and on glass it arrives as an unstyled
 * native control.
 *
 * ⚠️ The filter runs over rows that already exist rather than rebuilding them, so
 * the list keeps its selection and its scroll position while somebody types.
 *
 * ⚠️ There is no `scrollTo`, and there was one. Scrolling a 328-row list to the
 * selected row is the wrong answer to "where is my language?" — it was also three
 * failed attempts (a stale `upper`, a guard on the row height, a `map` handler
 * one frame later, each of which left the list at the top). The right answer is
 * the one Anaconda and GNOME Initial Setup already use: put the current choice in
 * a SUGGESTED group at the top, where it needs no scrolling to be seen. The
 * caller orders `items`; this widget just draws them.
 * `haystack` returns everything a row should match — which is more than what it
 * DISPLAYS: a Spanish list showing "España" that matched only "Spain" is the bug
 * this signature exists to prevent.
 *
 * ⚠️ Both sides of the match are folded through `searchFold` (accents off, case
 * off), so "espana" finds España. The caller does not have to fold anything: what
 * it hands over is folded here, once, at construction — which is also why
 * `haystack` is called once per item rather than once per item per keystroke. It
 * used to run 249 ICU lookups on every letter typed.
 *
 * ⚠️ And the matches are RANKED, because a two-letter query is usually a code:
 * an exact hit first, then what starts with the query, then what merely contains
 * it — ties keep the caller's order, so an empty search box shows exactly the list
 * that was passed in, suggested rows and all.
 */
export function searchableList<T>(opts: {
  placeholder: string
  items: T[]
  /** The row for one item; the check widget is handed in so the caller can place it. */
  row: (item: T, check: Gtk.Widget) => Gtk.ListBoxRow
  haystack: (item: T) => string[]
  isSelected: (item: T) => boolean
  onActivate: (item: T) => void
  height: number
}): { widget: Gtk.Widget; repaint: () => void } {
  const search = new Gtk.Entry({ placeholder_text: opts.placeholder, hexpand: true })
  // ⚠️ `NidaraList()` returns a listbox that is ALREADY parented to the box it
  // also returns, and that box is not what we want around a scrolling list — so
  // the child has to be taken out before it can be given a new parent. Without
  // the unparent, GTK refuses the reparent with
  // `gtk_scrolled_window_set_child: assertion … failed` and draws nothing.
  const { box: unusedCard, listBox } = NidaraList()
  unusedCard.remove(listBox)
  listBox.selection_mode = Gtk.SelectionMode.NONE

  const rowOf = new Map<T, Gtk.ListBoxRow>()
  const checkOf = new Map<T, Gtk.Widget>()
  const itemOf = new Map<Gtk.ListBoxRow, T>()
  const orderOf = new Map<T, number>()
  const foldedOf = new Map<T, string[]>()

  for (const [i, item] of opts.items.entries()) {
    const check = NidaraSelectionCheck(16)
    check.visible = opts.isSelected(item)
    const row = opts.row(item, check)
    if (check.visible) row.add_css_class("is-selected")
    rowOf.set(item, row); checkOf.set(item, check); itemOf.set(row, item)
    orderOf.set(item, i)
    foldedOf.set(item, opts.haystack(item).map(searchFold))
    listBox.append(row)
  }

  // A list that filters down to nothing has to SAY so — an empty card reads as a
  // list that failed to load. GTK shows the placeholder exactly when the box has
  // no visible child, and a filtered-out row is not a visible child, so this
  // covers the empty search without any counting of our own.
  listBox.set_placeholder(NidaraEmptyRow(t("searchNoMatches")))

  const repaint = () => {
    for (const [item, row] of rowOf) {
      const on = opts.isSelected(item)
      row[on ? "add_css_class" : "remove_css_class"]("is-selected")
      const c = checkOf.get(item)
      if (c) c.visible = on
    }
  }

  // How well an item answers the current query: 0 exact, 1 prefix, 2 anywhere,
  // NO_MATCH filtered out. Computed once per keystroke for the whole list rather
  // than inside the sort comparator, which GTK calls O(n log n) times.
  const NO_MATCH = 3
  const rankOf = new Map<T, number>()
  const rerank = () => {
    const q = searchFold((search.get_text?.() ?? "").trim())
    for (const item of opts.items) {
      let rank = NO_MATCH
      for (const h of foldedOf.get(item) ?? []) {
        if (h === q) { rank = 0; break }
        if (h.startsWith(q)) rank = Math.min(rank, 1)
        else if (h.includes(q)) rank = Math.min(rank, 2)
      }
      rankOf.set(item, rank)
    }
  }
  rerank()

  listBox.set_filter_func((row) => {
    const item = itemOf.get(row as Gtk.ListBoxRow)
    if (!item) return true
    return (rankOf.get(item) ?? NO_MATCH) < NO_MATCH
  })
  // With an empty box every row ranks 1 (everything starts with ""), so the tie
  // break is what shows: the caller's own order, untouched.
  listBox.set_sort_func((a, b) => {
    const ia = itemOf.get(a as Gtk.ListBoxRow), ib = itemOf.get(b as Gtk.ListBoxRow)
    if (!ia || !ib) return 0
    return ((rankOf.get(ia) ?? NO_MATCH) - (rankOf.get(ib) ?? NO_MATCH))
        || ((orderOf.get(ia) ?? 0) - (orderOf.get(ib) ?? 0))
  })
  search.connect("changed", () => {
    rerank()
    listBox.invalidate_filter()
    listBox.invalidate_sort()
  })
  listBox.connect("row-activated", (_l, row) => {
    const item = itemOf.get(row)
    if (item) { opts.onActivate(item); repaint() }
  })

  // ⚠️ An explicit height, NOT `vexpand`. This list sits inside a page that is
  // itself inside a scroller, and a vexpanding widget in a scrolling page gets
  // its MINIMUM rather than the leftover — the page can always grow instead.
  // Measured: the language list rendered three rows tall on a 760px window while
  // asking for 220.
  //
  // ⚠️ And the CARD is outside the scroller, with the rows scrolling inside it.
  // `NidaraList` puts the card's material on the LISTBOX itself (`.nidara-list`
  // in ui/lib/styles/_components.scss), so scrolling the listbox scrolls its own
  // rounded top and bottom out of view — the card appeared to be sliced off at
  // both ends, which is what it was. The frame has to stay still while the
  // content moves; that is the whole idea of a frame.
  const { widget: scroller, scrolled } = NidaraScrolled({
    child: listBox,
    minContentHeight: opts.height,
    propagateNaturalHeight: false,
    reserveLane: false,
  })
  scrolled.set_size_request(-1, opts.height)

  const card = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    css_classes: ["installer-list-frame"],
    hexpand: true,
  })
  // ⚠️ In code, not in CSS. GTK4's CSS has no `overflow` property — the sheet
  // says so at the top of style.scss and it still cost a `CSS Error … No property
  // named "overflow"`. Clipping to the rounded corners is a WIDGET setting.
  card.overflow = Gtk.Overflow.HIDDEN
  card.append(scroller)

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true, vexpand: true })
  box.append(search)
  box.append(card)

  return { widget: box, repaint }
}
