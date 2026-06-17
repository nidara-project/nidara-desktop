import { Gtk, Gdk } from "ags/gtk4"
import { NidaraOverlayManager } from "./overlay-manager"

export interface SelectOption {
  label: string
  value: string
}

export interface NidaraSelectResult {
  widget: Gtk.Widget
  setOptions:   (opts: SelectOption[]) => void
  setSelected:  (value: string) => void
  getSelected:  () => string
  setSensitive: (v: boolean) => void
  onChanged:    (cb: (value: string) => void) => void
}

/**
 * NidaraSelect — custom dropdown using the window-level Gtk.Overlay.
 *
 * The trigger button lives in the normal layout flow.
 * The list is injected into the overlay when open — it floats without
 * disrupting the layout, and CSS always applies (same surface, same provider).
 *
 * Width strategy: the list matches the trigger width exactly.
 * Set width_request on the trigger from the call site; the list follows.
 * No measuring, no centering math — same width = perfectly aligned.
 */
export function NidaraSelect(
  options: SelectOption[],
  selectedValue: string,
  manager: NidaraOverlayManager,
  cssClass = "nidara-select",
): NidaraSelectResult {
  let current = selectedValue
  let opts    = [...options]
  let onChange: ((value: string) => void) | null = null

  // ── Trigger ───────────────────────────────────────────────────────────────
  const triggerLabel = new Gtk.Label({
    label: opts.find(o => o.value === current)?.label ?? opts[0]?.label ?? "",
    hexpand: true,
    halign: Gtk.Align.START,
    xalign: 0,
    ellipsize: 3,
  })
  const triggerArrow = new Gtk.Label({
    label: "▾",
    css_classes: ["nidara-select-arrow"],
  })
  const triggerInner = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 4,
  })
  triggerInner.append(triggerLabel)
  triggerInner.append(triggerArrow)

  const trigger = new Gtk.Button({ css_classes: [cssClass] })
  trigger.set_child(triggerInner)

  // ── List (injected into overlay when open) ────────────────────────────────
  const listBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    css_classes: ["nidara-select-list", `${cssClass}-list`],
  })
  // Scroll wrapper so long lists (themes, icons…) cap their height and scroll
  // instead of overflowing the window.
  const listScroll = new Gtk.ScrolledWindow({
    hscrollbar_policy: Gtk.PolicyType.NEVER,
    vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    propagate_natural_height: true,
    max_content_height: 300,
    css_classes: ["nidara-select-scroll", `${cssClass}-scroll`],
  })
  listScroll.set_child(listBox)

  // ── Open / close ──────────────────────────────────────────────────────────
  function open() {
    // Position of trigger's top-left within the overlay
    let ax = 0, ay = 0
    try {
      const r = (trigger as any).translate_coordinates(manager.overlay, 0, 0)
      if (Array.isArray(r)) {
        if (typeof r[0] === "boolean") { ax = r[1] ?? 0; ay = r[2] ?? 0 }
        else                           { ax = r[0] ?? 0; ay = r[1] ?? 0 }
      }
    } catch (e) { console.warn("[NidaraSelect]", e) }

    // List matches trigger width exactly — no centering needed.
    const tw = trigger.get_width()
    const th = trigger.get_height()
    listScroll.width_request = tw

    // Open below the trigger; flip above if it would overflow the bottom.
    const [, natH] = listScroll.measure(Gtk.Orientation.VERTICAL, tw)
    const overlayH = manager.overlay.get_height() || 600
    let y = ay + th + 2
    if (y + natH > overlayH - 8) y = Math.max(8, ay - natH - 2)

    manager.show(listScroll, ax, y)
  }

  trigger.connect("clicked", () => {
    if (listScroll.get_parent() !== null) manager.hide()
    else open()
  })

  // ── Build items ───────────────────────────────────────────────────────────
  function buildItems() {
    let child = listBox.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      listBox.remove(child)
      child = next
    }

    for (const opt of opts) {
      const isSelected = opt.value === current

      const itemLabel = new Gtk.Label({
        label: opt.label,
        halign: Gtk.Align.START,
        hexpand: true,
        xalign: 0,
        ellipsize: 3,        // PANGO_ELLIPSIZE_END — long names truncate, never overflow
      })
      itemLabel.add_css_class("nidara-select-item-label")

      const item = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: isSelected
          ? ["nidara-select-item", "nidara-select-item--selected"]
          : ["nidara-select-item"],
      })
      item.append(itemLabel)

      try { item.set_cursor(Gdk.Cursor.new_from_name("pointer", null)) } catch (_) {}

      const motion = new Gtk.EventControllerMotion()
      motion.connect("enter", () => item.add_css_class("nidara-select-item--hover"))
      motion.connect("leave", () => item.remove_css_class("nidara-select-item--hover"))
      item.add_controller(motion)

      const click = new Gtk.GestureClick()
      click.connect("pressed", () => {
        current = opt.value
        triggerLabel.label = opt.label
        manager.hide()
        buildItems()
        onChange?.(current)
      })
      item.add_controller(click)

      listBox.append(item)
    }
  }

  buildItems()

  return {
    widget: trigger,
    setOptions(newOpts)  { opts = [...newOpts]; buildItems() },
    setSelected(value)   {
      current = value
      triggerLabel.label = opts.find(o => o.value === value)?.label ?? ""
      buildItems()
    },
    getSelected: () => current,
    setSensitive(v) {
      trigger.sensitive = v
      if (!v) manager.hide()
    },
    onChanged: (cb) => { onChange = cb },
  }
}
