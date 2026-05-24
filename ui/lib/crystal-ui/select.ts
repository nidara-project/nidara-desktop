import { Gtk, Gdk } from "ags/gtk4"
import { CrystalOverlayManager } from "./overlay-manager"

export interface SelectOption {
  label: string
  value: string
}

export interface CrystalSelectResult {
  widget: Gtk.Widget
  setOptions:   (opts: SelectOption[]) => void
  setSelected:  (value: string) => void
  getSelected:  () => string
  setSensitive: (v: boolean) => void
  onChanged:    (cb: (value: string) => void) => void
}

/**
 * CrystalSelect — custom dropdown using the window-level Gtk.Overlay.
 *
 * The trigger button lives in the normal layout flow.
 * The list is injected into the overlay when open — it floats without
 * disrupting the layout, and CSS always applies (same surface, same provider).
 *
 * Width strategy: the list matches the trigger width exactly.
 * Set width_request on the trigger from the call site; the list follows.
 * No measuring, no centering math — same width = perfectly aligned.
 */
export function CrystalSelect(
  options: SelectOption[],
  selectedValue: string,
  manager: CrystalOverlayManager,
  cssClass = "crystal-select",
): CrystalSelectResult {
  let current = selectedValue
  let opts    = [...options]
  let onChange: ((value: string) => void) | null = null

  // ── Trigger ───────────────────────────────────────────────────────────────
  const triggerLabel = new Gtk.Label({
    label: opts.find(o => o.value === current)?.label ?? opts[0]?.label ?? "",
    hexpand: true,
    halign: Gtk.Align.CENTER,
  })
  const triggerArrow = new Gtk.Label({
    label: "▾",
    css_classes: ["crystal-select-arrow"],
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
    css_classes: ["crystal-select-list", `${cssClass}-list`],
  })

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
    } catch (e) { console.warn("[CrystalSelect]", e) }

    // List matches trigger width exactly — no centering needed.
    // Callers set width_request on the trigger widget; the list follows.
    listBox.width_request = trigger.get_width()

    manager.show(listBox, ax, ay + trigger.get_height())
  }

  trigger.connect("clicked", () => {
    if (listBox.get_parent() !== null) manager.hide()
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
      })
      itemLabel.add_css_class("crystal-select-item-label")

      const item = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: isSelected
          ? ["crystal-select-item", "crystal-select-item--selected"]
          : ["crystal-select-item"],
      })
      item.append(itemLabel)

      try { item.set_cursor(Gdk.Cursor.new_from_name("pointer", null)) } catch (_) {}

      const motion = new Gtk.EventControllerMotion()
      motion.connect("enter", () => item.add_css_class("crystal-select-item--hover"))
      motion.connect("leave", () => item.remove_css_class("crystal-select-item--hover"))
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
