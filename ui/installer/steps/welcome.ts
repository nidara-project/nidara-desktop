import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { readBaseConfig } from "../lib/base-config"
import { t } from "../lib/i18n"
import { nidaraLogoIcon } from "../../lib/icons"
import { heading, prose } from "./common"

export function WelcomeStep(): Step {
  const base = readBaseConfig()

  return {
    id: "welcome",
    title: () => t("welcomeTitle"),
    nextLabel: () => t("continue"),
    ready: () => base !== null,

    build() {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      const logoIcon = nidaraLogoIcon()
      if (logoIcon) {
        box.append(new Gtk.Image({
          gicon: logoIcon,
          pixel_size: 64,
          css_classes: ["installer-logo"],
          halign: Gtk.Align.START,
        }))
      }

      box.append(heading(t("welcomeHeading")))
      box.append(prose(t("welcomeIntro")))
      box.append(prose(
        t("welcomeWarning"),
        "installer-prose--dim",
      ))

      if (!base) {
        box.append(prose(
          t("welcomeNotMedium"),
          "installer-prose--warning",
        ))
      }

      return box
    },
  }
}
