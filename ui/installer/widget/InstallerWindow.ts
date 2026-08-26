// The frame: a header that names the current step, the flow's content, and the
// two buttons that move through it.
//
// Everything that varies lives in `lib/flow.ts` and in the steps — this file
// renders whatever the flow says is current and never learns what any step
// asks. Adding a screen is adding an entry to the array at the bottom.

import Gtk from "gi://Gtk?version=4.0"
import app from "../../lib/host"
import {
  NidaraButton, NidaraCircleButton, NidaraClamp, NidaraWindow,
  type NidaraWindowResult,
} from "../../lib/nidara-kit"
import { ndIcon } from "../../lib/icons"
import { Flow, type Step } from "../lib/flow"
import { WelcomeStep } from "../steps/welcome"
import { DiskStep } from "../steps/disk"
import { AccountStep } from "../steps/account"
import { SummaryStep } from "../steps/summary"
import { RunStep } from "../steps/run"
import { t } from "../lib/i18n"

/**
 * The reading width, and the window's own width follows from it.
 *
 * Same rule as Settings' geometry law: the box is a constant and the text scales
 * inside it. An installer's prose is the only thing on screen for most of its
 * steps, so a window sized to its content would grow with the longest sentence
 * in whichever language it was translated into.
 */
const CONTENT_WIDTH = 620

/**
 * The header's three slots, for `NidaraAppWindow` to place.
 *
 * It returns the widgets rather than a bar: the kit owns the `Gtk.CenterBox` and
 * the `Gtk.WindowHandle` that makes an undecorated window draggable, so this file
 * no longer builds either.
 */
function header(onClose: () => void): {
  start: Gtk.Widget
  end: Gtk.Widget
  set: (title: string, position: string) => void
  setCanClose: (can: boolean) => void
} {
  const title = new Gtk.Label({
    css_classes: ["installer-title"],
    halign: Gtk.Align.START,
    hexpand: true,
    xalign: 0,
  })
  const position = new Gtk.Label({
    css_classes: ["installer-position"],
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
  })

  // The kit's round glass icon button — the same control Settings and About wear
  // in their headers, from the same file since it moved into `nidara-kit`.
  const closeBtn = NidaraCircleButton({
    icon: ndIcon("x"),
    iconName: "window-close-symbolic",
    variant: "danger",
    valign: Gtk.Align.CENTER,
    halign: Gtk.Align.END,
    onClick: onClose,
  })
  closeBtn.name = "installer-close"

  const trailing = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  trailing.append(position)
  trailing.append(closeBtn)

  return {
    start: title,
    end: trailing,
    set: (t: string, p: string) => { title.label = t; position.label = p },
    // Insensitive rather than hidden while the install runs: a control that
    // disappears reads as a bug, one that greys out reads as "not now".
    setCanClose: (can: boolean) => { closeBtn.sensitive = can },
  }
}

/**
 * No options.
 *
 * There used to be an `isDark`, because the window carried a class that swapped
 * the ink. It does not any more: `installAppearance()` generates the whole token
 * ramp for whichever mode the session is in, so this frame never learns which one
 * that is — the same reason it has no light/dark toggle of its own. A second
 * opinion about light and dark on one screen is not a feature.
 */
export function InstallerWindow(): Gtk.Window {
  const steps: Step[] = [
    WelcomeStep(),
    DiskStep(),
    AccountStep(),
    SummaryStep(),
    RunStep(),
  ]
  const flow = Flow(steps)

  /**
   * Can the window be left right now?
   *
   * Only the current step knows. On every screen but the last the answer is yes —
   * nothing has been written, so quitting costs the user their answers and
   * nothing else. On the last one, from the moment the plan is handed to
   * `archinstall` until it exits, the answer is no: this process is the only
   * thing watching a root process that is repartitioning a disk, and it owns the
   * plaintext credentials file it must delete afterwards.
   */
  const canExit = () => flow.current().busy?.() !== true

  const back = NidaraButton({ label: t("back"), variant: "secondary" })
  const next = NidaraButton({ label: t("continue"), variant: "primary" })

  back.connect("clicked", () => flow.back())
  next.connect("clicked", () => {
    const step = flow.current()
    if (step.ready && !step.ready()) return
    flow.next()
  })

  const footer = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 10,
    halign: Gtk.Align.END,
    css_classes: ["installer-footer"],
  })
  footer.append(back)
  footer.append(next)

  // maxWidth === minWidth: the content pane is a CONSTANT width, so widening the
  // window adds margin and never re-flows the prose.
  const content = NidaraClamp(flow.widget, CONTENT_WIDTH, true, CONTENT_WIDTH)
  // ⚠️ THE SIZE FLOOR IS WHAT DECIDES HERE, NOT `default_width`.
  //
  // Measured 2026-08-26: with `default_width: 900`, the window still came up 622
  // wide — the content's natural width (the 620 clamp plus its margins) — with
  // its prose running edge to edge. `main`'s build does the same, so it is not
  // something this file changed.
  //
  // The default size is a REQUEST, and on Wayland the compositor answers it: what
  // `get_width()` reports afterwards is the allocation Hyprland handed back, not
  // GTK's intent. (Do not read that number as "GTK ignored the default" — this
  // comment said exactly that for an hour, until the Settings window turned out
  // to be sized the same way for the plain reason that it was TILED.) A minimum
  // survives where a default does not: GTK forwards it as
  // `xdg_toplevel.set_min_size`, which the compositor honours.
  //
  // The width is a floor of 740 = the 620 reading column plus 120 of air. That
  // still fits the smallest screen a live medium plausibly meets (1024×768).
  // The height floor is a separate concern: the steps have visibly different
  // content heights (three lines of prose, then a disk list, then four fields) and
  // a frame that resized under each one would read as a different window each time.
  // The close button is built before the window, and the window's close policy is
  // what it calls — so the button gets a thunk rather than the function itself.
  // One path: this button, the compositor's close request and Escape all end in
  // `shell.close()`, which asks `canExit()` first.
  let shell: NidaraWindowResult
  const head = header(() => shell.close())

  // The kit owns the chrome: the undecorated toplevel, the glass card (painted by
  // a BOX inside it so the compositor has something to blur), the draggable
  // header, the app-id, and ONE close path that the button, the compositor's
  // request and Escape all go through. What is left here is what an installer
  // actually is — a flow, and the two buttons that move through it.
  //
  // No `sidebar` today, and that is the only thing standing between this and a
  // step list you can jump around in: fill in `sidebar: { widget, toggleIcon }`
  // and the capsule, the split view and the docking breakpoint arrive with it.
  // (Whether a wizard SHOULD let you skip ahead is a product question — the steps
  // depend on each other's answers — but it is no longer a structural one.)
  shell = NidaraWindow({
    app,
    title: "Nidara Installer",
    name: "nidara-installer",
    appId: "nidara-installer",
    cssClasses: ["nidara-installer-window"],
    glassClasses: ["installer-root"],
    content,
    footer,
    header: { cssClasses: ["installer-header"], start: head.start, end: head.end },
    closeOnEscape: true,
    // Refusing is the whole point: `true` here means "not now".
    onClose: () => !canExit(),
    defaultWidth: CONTENT_WIDTH + 120,
    defaultHeight: 620,
  })

  const win = shell.window
  // The size floor goes on the CARD, which is what holds the header, the content
  // and the footer — the same node the old hand-built root box was.
  shell.glass.set_size_request(CONTENT_WIDTH + 120, 620)
  // Closing the installer ends the process — it is the only window there is, and a
  // hidden one would keep the application alive with nothing on screen.
  win.connect("destroy", () => app.quit())

  function sync() {
    const step = flow.current()
    const index = steps.indexOf(step) + 1
    head.set(step.title, `${index} ${t("of")} ${steps.length}`)
    back.visible = flow.canBack() && step.id !== "run"
    next.visible = step.id !== "run"
    next.set_label(step.nextLabel)
    // A step that cannot be left forward disables the button rather than hiding
    // it: the disabled control is what says "there is a way on, and it is not
    // available yet".
    next.sensitive = step.ready ? step.ready() : true
    // The last step has nowhere to go until the flow grows one.
    if (index === steps.length) next.sensitive = false
    head.setCanClose(canExit())
  }
  flow.onChange(sync)
  sync()

  return win
}
