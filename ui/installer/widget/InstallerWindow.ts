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

  const win = new Gtk.Window({
    application: app as any,
    name: "nidara-installer",
    css_classes: ["nidara-installer-window"],
    decorated: false,
    default_width: CONTENT_WIDTH + 120,
    default_height: 620,
  })
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
  // ⚠️ THE SIZE COMES FROM HERE, NOT FROM `default_width`.
  //
  // Measured 2026-08-26: with `default_width: 900` set on the window, GTK itself
  // reports `get_width() === 622` — the content's natural width (the 620 clamp
  // plus its margins). The default size is not being honoured for this window at
  // all, and the same is true of the version on `main`, so it is not something
  // this file changed. Until that is understood, the size request is the only
  // mechanism that actually decides, and a window whose prose runs edge to edge
  // is what happens when nothing does.
  //
  // The width is a floor of 740 = the 620 reading column plus 120 of air. That
  // still fits the smallest screen a live medium plausibly meets (1024×768), which
  // is what the earlier worry about width requests was really about.
  //
  // The height floor is a separate concern: the steps have visibly different
  // content heights (three lines of prose, then a disk list, then four fields) and
  // a frame that resized under each one would read as a different window each time.
  const root = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    width_request: CONTENT_WIDTH + 120,
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
