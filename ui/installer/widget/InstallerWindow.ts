// The frame: a header that names the current step, the flow's content, and the
// two buttons that move through it.
//
// Everything that varies lives in `lib/flow.ts` and in the steps — this file
// renders whatever the flow says is current and never learns what any step
// asks. Adding a screen is adding an entry to the array at the bottom.

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import app from "../../lib/host"
import { setWindowAppId } from "../../lib/app-id"
import { NidaraButton, NidaraCircleButton, NidaraClamp } from "../../lib/nidara-kit"
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

function header(onClose: () => void): {
  widget: Gtk.Widget
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

  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  box.add_css_class("installer-header")
  box.append(title)
  box.append(position)
  box.append(closeBtn)

  // The header is the drag handle: the window is undecorated, so without this it
  // can only be moved with a compositor keybind.
  const drag = new Gtk.WindowHandle({ child: box })

  return {
    widget: drag,
    set: (t: string, p: string) => { title.label = t; position.label = p },
    // Insensitive rather than hidden while the install runs: a control that
    // disappears reads as a bug, one that greys out reads as "not now".
    setCanClose: (can: boolean) => { closeBtn.sensitive = can },
  }
}

export interface InstallerWindowOpts {
  /**
   * The live session's mode, read from the shell's appearance mirror. The
   * installer has no toggle of its own on purpose: it is a window inside a
   * running Nidara, and a second opinion about light and dark on the same
   * screen is not a feature.
   */
  isDark: boolean
}

export function InstallerWindow(opts: InstallerWindowOpts): Gtk.Window {
  const steps: Step[] = [
    WelcomeStep(),
    DiskStep(),
    AccountStep(),
    SummaryStep(),
    RunStep(),
  ]
  const flow = Flow(steps)

  const win = new Gtk.Window({
    application: app as any,
    name: "nidara-installer",
    css_classes: ["nidara-installer-window"],
    decorated: false,
    default_width: CONTENT_WIDTH + 120,
    default_height: 620,
  })
  if (!opts.isDark) win.add_css_class("installer-light")
  // A real application window declares its own app-id, so the compositor files
  // it under a name the desktop registry has — not under the process-wide one.
  setWindowAppId(win, "nidara-installer")

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

  const close = () => {
    if (!canExit()) return
    win.destroy()
    app.quit()
  }

  win.connect("close-request", () => {
    close()
    // TRUE either way: the default handler must not run. When the exit was
    // allowed, `close()` has already destroyed the window; when it was refused,
    // letting GTK close it anyway is exactly what the refusal is for.
    return true
  })

  const escKey = new Gtk.EventControllerKey()
  escKey.connect("key-pressed", (_c, keyval) => {
    if (keyval !== Gdk.KEY_Escape) return false
    close()
    return true
  })
  win.add_controller(escKey)

  const head = header(close)

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

  // The glass is painted HERE, not on the window: the toplevel stays transparent
  // so the compositor has something to blur, which is how About and Settings are
  // built and why they look like Nidara rather than like a dark rectangle.
  // A height floor, not a width one. The steps have visibly different content
  // heights (three lines of prose, then a disk list, then four fields) and a frame
  // that resized under each one would read as a different window every time. Width
  // is left alone on purpose: the clamp above already holds the prose at a
  // constant, and a width_request would stop the window fitting a small screen —
  // which a live medium meets far more often than a desktop does.
  const root = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    height_request: 620,
  })
  root.add_css_class("nidara-window-glass")
  root.add_css_class("installer-root")
  root.append(head.widget)
  root.append(content)
  root.append(footer)
  win.set_child(root)

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
