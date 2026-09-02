import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { readBaseConfig } from "../lib/base-config"
import { t } from "../lib/i18n"
import { nidaraLogoIcon } from "../../lib/icons"
import { heading, prose } from "./common"
import { connectivity, isUsable } from "../lib/network"

export function WelcomeStep(): Step {
  const base = readBaseConfig()

  // Advisory here, enforced in the run step. Warning without blocking is the
  // right shape: the person can walk over to the desktop behind this window,
  // join a network, and come back — and coming back re-runs onEnter, which is
  // the whole reason the check can live on a page instead of in a dialog.
  let netWarn: Gtk.Label | null = null
  let netOk = true

  const refreshNetwork = () => {
    connectivity().then(c => {
      netOk = isUsable(c)
      if (netWarn) netWarn.visible = !netOk
    })
  }

  return {
    id: "welcome",
    title: () => t("welcomeTitle"),
    nextLabel: () => t("continue"),
    ready: () => base !== null,

    onEnter: refreshNetwork,

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

      netWarn = prose(t("welcomeNoNetwork"), "installer-prose--warning")
      netWarn.visible = !netOk
      box.append(netWarn)
      refreshNetwork()

      return box
    },
  }
}
