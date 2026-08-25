// Step 1 — what is about to happen, and whether this machine can do it.
//
// A welcome screen usually earns nothing. This one does two jobs: it states the
// one destructive fact up front (a disk gets erased), and it answers a question
// only this process can answer — is this a Nidara medium at all? The product's
// base config is ISO-only content, so its absence is the difference between "the
// installer is running" and "the installer can install".

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { readBaseConfig, basePackages } from "../lib/base-config"

function heading(text: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: ["installer-heading"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
  })
}

function prose(text: string, extraClass?: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: extraClass ? ["installer-prose", extraClass] : ["installer-prose"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
    wrap: true,
    wrap_mode: 2, // Pango.WrapMode.WORD_CHAR
  })
}

export function WelcomeStep(): Step {
  const base = readBaseConfig()

  return {
    id: "welcome",
    title: "Install Nidara",
    nextLabel: "Continue",
    // Without the product's config there is nothing honest to continue TO, so
    // the flow stops here rather than collecting answers it cannot use.
    ready: () => base !== null,

    build() {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading("Install Nidara on this computer"))
      box.append(prose(
        "The installer asks for three things — which disk to use, the account to "
        + "create, and a confirmation — and then installs the system you are "
        + "looking at. Everything else it can read from this live session.",
      ))
      box.append(prose(
        "The disk you choose is erased. Nothing else on this computer is touched, "
        + "and nothing is written until you confirm.",
        "installer-prose--warning",
      ))

      if (base) {
        const packages = basePackages(base.config)
        box.append(prose(
          packages.length
            ? `This medium installs: ${packages.join(", ")}.`
            : `Reading what this medium installs from ${base.path}.`,
          "installer-prose--dim",
        ))
      } else {
        // Said plainly, because the alternative is an installer that looks ready
        // and fails at the end: the ISO ships this file, a development checkout
        // does not.
        box.append(prose(
          "This is not a Nidara installation medium: the product configuration at "
          + "/usr/share/nidara-installer/base.json is missing, so there is nothing "
          + "to install from. The window is running, but installation is unavailable.",
          "installer-prose--warning",
        ))
      }

      return box
    },
  }
}
