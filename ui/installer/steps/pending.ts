// Step 2 — the placeholder, and it is deliberately not a mock-up.
//
// The frame, the flow and the seam are real; the questions are not written yet.
// A screen that PRETENDED to ask them — a disk list that does nothing, a password
// field that goes nowhere — would make the skeleton look finished, and the next
// person would have to find out by clicking. So this step says what is missing,
// in the order it will be filled in, and points at the thing that installs
// Nidara today.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { t } from "../lib/i18n"

export function PendingStep(): Step {
  const remaining = [
    t("pendingDisk"),
    t("pendingAccount"),
    t("pendingSummary"),
    t("pendingProgress"),
  ]

  return {
    id: "pending",
    title: t("pendingTitle"),
    nextLabel: t("continue"),

    build() {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        hexpand: true,
      })

      box.append(new Gtk.Label({
        label: t("pendingHeading"),
        css_classes: ["installer-heading"],
        halign: Gtk.Align.FILL,
        hexpand: true,
        xalign: 0,
      }))

      for (const item of remaining) {
        box.append(new Gtk.Label({
          label: `·  ${item}`,
          css_classes: ["installer-prose", "installer-prose--dim"],
          halign: Gtk.Align.FILL,
          hexpand: true,
          xalign: 0,
          wrap: true,
          wrap_mode: 2, // Pango.WrapMode.WORD_CHAR
        }))
      }

      box.append(new Gtk.Label({
        label: t("pendingFallback"),
        css_classes: ["installer-prose"],
        halign: Gtk.Align.FILL,
        hexpand: true,
        xalign: 0,
        wrap: true,
        wrap_mode: 2, // Pango.WrapMode.WORD_CHAR
        margin_top: 8,
      }))

      return box
    },
  }
}
