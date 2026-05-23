/**
 * crystal-ui — GTK4 primitive widgets for Crystal Shell
 *
 * Rules:
 * - Only Gtk.Box, Gtk.Label, Gtk.Button, Gtk.Popover, Gtk.DrawingArea
 * - No ListBox, DropDown, ComboBox, MenuButton, TreeView, or any Adw.*
 * - All layout and state managed in TypeScript
 * - All styling via CSS class names we own
 */

import { Gtk } from "ags/gtk4"

// ─────────────────────────────────────────────────────────────────────────────
// CrystalSelect — dropdown selector
// Nodes: button.crystal-select > box > label + label(arrow)
//        popover.crystal-popup  > box.crystal-popup-list > button.crystal-popup-item*
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectOption {
  label: string
  value: string
}

export interface CrystalSelectResult {
  widget: Gtk.Button
  setOptions: (opts: SelectOption[]) => void
  setSelected: (value: string) => void
  getSelected: () => string
  setSensitive: (v: boolean) => void
  onChanged: (cb: (value: string) => void) => void
}

export function CrystalSelect(
  options: SelectOption[],
  selectedValue: string,
  cssClass = "crystal-select",
): CrystalSelectResult {
  let current = selectedValue
  let opts = [...options]
  let onChange: ((value: string) => void) | null = null

  // ── Trigger button ──────────────────────────────────────────────────────
  const triggerLabel = new Gtk.Label({
    label: opts.find(o => o.value === current)?.label ?? opts[0]?.label ?? "",
    hexpand: true,
    halign: Gtk.Align.CENTER,
  })
  const triggerArrow = new Gtk.Label({ label: "▾", css_classes: ["crystal-select-arrow"] })

  const triggerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 })
  triggerBox.append(triggerLabel)
  triggerBox.append(triggerArrow)

  const trigger = new Gtk.Button({ css_classes: [cssClass] })
  trigger.set_child(triggerBox)

  // ── Popup ────────────────────────────────────────────────────────────────
  const listBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    css_classes: ["crystal-popup-list"],
  })

  const popover = new Gtk.Popover({
    has_arrow: false,
    css_classes: ["crystal-popup"],
    autohide: true,
  })
  popover.set_child(listBox)
  popover.set_parent(trigger)

  // ── Build items ──────────────────────────────────────────────────────────
  function buildItems() {
    let child = listBox.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      listBox.remove(child)
      child = next
    }

    for (const opt of opts) {
      const item = new Gtk.Button({
        label: opt.label,
        css_classes: opt.value === current
          ? ["crystal-popup-item", "crystal-popup-item--selected"]
          : ["crystal-popup-item"],
      })
      item.connect("clicked", () => {
        current = opt.value
        triggerLabel.label = opt.label
        buildItems()
        popover.popdown()
        onChange?.(current)
      })
      listBox.append(item)
    }
  }

  buildItems()
  trigger.connect("clicked", () => popover.popup())

  return {
    widget: trigger,
    setOptions(newOpts) { opts = [...newOpts]; buildItems() },
    setSelected(value) {
      current = value
      triggerLabel.label = opts.find(o => o.value === value)?.label ?? ""
      buildItems()
    },
    getSelected: () => current,
    setSensitive: (v) => { trigger.sensitive = v },
    onChanged: (cb) => { onChange = cb },
  }
}
