import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import status from "../../core/Status"
import Icons from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import SquircleContainer from "../common/SquircleContainer"
import { t } from "../../core/i18n"

// System menu dropdown (About / Settings / Lock / Suspend / Logout / Restart / Shutdown)
// with an inline confirmation page for destructive actions.
//
// Page switching uses a single-child swap (not Gtk.Stack) — a hidden 0×0 Stack
// child triggers a pixman "Invalid rectangle" warning, the same issue fixed in
// the Settings window (commit 2dc6f52).
export function SystemMenuOverlay() {
  // ── Shared confirm state ───────────────────────────────────────────────
  let pendingCmd: (() => void) | null = null

  // Single host whose child is swapped between the menu and the confirm page.
  const pageHost = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  const showPage = (child: Gtk.Widget) => {
    const cur = pageHost.get_first_child()
    if (cur === child) return
    if (cur) pageHost.remove(cur)
    pageHost.append(child)
  }

  // ── Normal menu page ───────────────────────────────────────────────────
  const menuBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 2,
    margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
  })

  const makeRow = (ico: Gio.FileIcon, txt: string, _danger: boolean, cmd: () => void) => {
    const lbl = new Gtk.Label({ label: txt, halign: Gtk.Align.START, hexpand: true,
      css_classes: ["crystal-menu-label"] })
    const img = new Gtk.Image({ gicon: ico, pixel_size: 16, css_classes: ["cs-icon"] })
    const b = new Gtk.Box({ spacing: 12 })
    b.append(img); b.append(lbl)
    const btn = new Gtk.Button({ child: b, css_classes: ["crystal-menu-row"], hexpand: true })
    btn.connect("clicked", cmd)
    return btn
  }

  const sep = () => new Gtk.Separator({ css_classes: ["crystal-menu-sep"], margin_top: 4, margin_bottom: 4 })

  const showConfirm = (ico: Gio.FileIcon, question: string, actionLabel: string, danger: boolean, cmd: () => void) => {
    pendingCmd = cmd
    confirmIcon.gicon = ico
    confirmQuestion.label = question
    confirmActionBtn.label = actionLabel
    if (danger) confirmActionBtn.add_css_class("danger-action")
    else confirmActionBtn.remove_css_class("danger-action")
    showPage(confirmBox)
  }

  const closeAndRun = (cmd: string[]) => {
    status.system_menu_open = false
    execAsync(cmd).catch(console.error)
  }

  menuBox.append(makeRow(Icons.info, t("bar.system-menu.about"), false, () => {
    status.system_menu_open = false; status.toggleAbout()
  }))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.settings, t("bar.system-menu.settings"), false, () => {
    status.system_menu_open = false; shellActions.toggleSettings?.()
  }))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.lock, t("bar.system-menu.lock"), false, () => {
    status.system_menu_open = false
    execAsync(["crystal-lock"]).catch(console.error)
  }))
  menuBox.append(makeRow(Icons.moon, t("bar.system-menu.suspend"), false, () =>
    closeAndRun(["systemctl", "suspend"])
  ))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.logOut, t("bar.system-menu.logout"), true, () =>
    showConfirm(Icons.logOut, t("bar.system-menu.confirm.logout"), t("bar.system-menu.confirm.action.logout"), true,
      () => closeAndRun(["uwsm", "stop"]))
  ))
  menuBox.append(makeRow(Icons.rotateCcw, t("bar.system-menu.restart"), false, () =>
    showConfirm(Icons.rotateCcw, t("bar.system-menu.confirm.restart"), t("bar.system-menu.confirm.action.restart"), false,
      () => closeAndRun(["systemctl", "reboot"]))
  ))
  menuBox.append(makeRow(Icons.power, t("bar.system-menu.shutdown"), true, () =>
    showConfirm(Icons.power, t("bar.system-menu.confirm.shutdown"), t("bar.system-menu.confirm.action.shutdown"), true,
      () => closeAndRun(["systemctl", "poweroff"]))
  ))

  // ── Confirmation page ──────────────────────────────────────────────────
  const confirmIcon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER, css_classes: ["cs-icon"] })
  const confirmQuestion = new Gtk.Label({
    halign: Gtk.Align.CENTER,
    justify: Gtk.Justification.CENTER,
    css_classes: ["crystal-menu-label"],
    wrap: true,
    max_width_chars: 20,
  })

  const confirmCancelBtn = new Gtk.Button({ label: t("bar.system-menu.confirm.cancel"), css_classes: ["crystal-menu-row", "system-confirm-secondary"], hexpand: true })
  confirmCancelBtn.connect("clicked", () => {
    pendingCmd = null
    showPage(menuBox)
  })

  const confirmActionBtn = new Gtk.Button({ label: "", css_classes: ["crystal-menu-row", "system-confirm-primary"], hexpand: true })
  confirmActionBtn.connect("clicked", () => {
    pendingCmd?.()
    pendingCmd = null
    showPage(menuBox)
  })

  const confirmBtnRow = new Gtk.Box({ spacing: 6, homogeneous: true, margin_top: 4 })
  confirmBtnRow.append(confirmCancelBtn)
  confirmBtnRow.append(confirmActionBtn)

  const confirmBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 10,
    margin_top: 16, margin_bottom: 14, margin_start: 10, margin_end: 10,
    width_request: 210,
  })
  confirmBox.append(confirmIcon)
  confirmBox.append(confirmQuestion)
  confirmBox.append(confirmBtnRow)

  // Reset to menu page when closed
  status.connect("notify::system-menu-open", () => {
    if (!status.system_menu_open) {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        showPage(menuBox)
        pendingCmd = null
        return GLib.SOURCE_REMOVE
      })
    }
  })

  showPage(menuBox)

  const squircleWrapper = SquircleContainer({
    child: pageHost,
    radius: 24,
    gloss: true,
    useShellOpacity: true,
    borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
    css_classes: ["crystal-menu"],
  })

  const outerBox = new Gtk.Box({
    valign: Gtk.Align.START,
    halign: Gtk.Align.START,
    margin_top: 56,
    margin_start: 16,
    visible: false,
    css_classes: ["overlay-fade"],
  })
  outerBox.append(squircleWrapper)
  return outerBox
}

export default SystemMenuOverlay
