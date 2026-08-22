import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "../../../lib/process"
import status from "../../core/Status"
import Icons from "../../core/Icons"
import shellActions from "../../core/ShellActions"
import SquircleContainer, { GLASS_INSET } from "../../common/SquircleContainer"
import { RADIUS, rowInsetFor } from "../../../lib/tokens"
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
    // The halo from the GLASS, all four sides: the row's hover fill spans this box, so
    // this margin IS the gap between the hover and the card's edge. Default `n` (3.2):
    // this card is a squircle, which barely intrudes into its own corner, so it wants 6
    // where the bar's circular `perfect: true` panel wants 14 at the same radius.
    // ⚠️ Twice user-caught here. The first fix read `expansionInner`'s constructor
    // (12) and wrote 12 — but Bar.tsx REWRITES that margin on every open, and the
    // number that ships is measured from the widget rect, so this menu still sat
    // 10 from the glass against its siblings' 12. Use the token, not a literal
    // copied from another file's constructor.
    margin_top: rowInsetFor(RADIUS.lg) + GLASS_INSET, margin_bottom: rowInsetFor(RADIUS.lg) + GLASS_INSET,
    margin_start: rowInsetFor(RADIUS.lg) + GLASS_INSET, margin_end: rowInsetFor(RADIUS.lg) + GLASS_INSET,
  })

  const makeRow = (ico: Gio.FileIcon, txt: string, _danger: boolean, cmd: () => void) => {
    const lbl = new Gtk.Label({ label: txt, halign: Gtk.Align.START, hexpand: true,
      css_classes: ["nidara-menu-label"] })
    const img = new Gtk.Image({ gicon: ico, pixel_size: 16, css_classes: ["nd-icon"] })
    const b = new Gtk.Box({ spacing: 12 })
    b.append(img); b.append(lbl)
    const btn = new Gtk.Button({ child: b, css_classes: ["nidara-menu-row"], hexpand: true })
    btn.connect("clicked", cmd)
    return btn
  }

  const sep = () => new Gtk.Separator({ css_classes: ["nidara-menu-sep"], margin_top: 4, margin_bottom: 4 })

  const showConfirm = (ico: Gio.FileIcon, question: string, actionLabel: string, danger: boolean, cmd: () => void) => {
    pendingCmd = cmd
    confirmIcon.gicon = ico
    confirmQuestion.label = question
    confirmActionBtn.label = actionLabel
    if (danger) confirmActionBtn.add_css_class("danger-action")
    else confirmActionBtn.remove_css_class("danger-action")
    showPage(confirmBox)
  }

  // ── Single-action guard per menu opening ───────────────────────────────
  // Protects against accidental double-clicks or chattering mouse switches
  // triggering conflicting actions while the menu is closing (e.g. double-click
  // on Suspend sending an immediate wakeup interrupt to the kernel).
  let actionDispatched = false

  const closeAndRun = (cmd: string[]) => {
    if (actionDispatched) return
    actionDispatched = true
    pageHost.sensitive = false
    status.system_menu_open = false
    execAsync(cmd).catch(console.error)
  }

  const dispatchAction = (action: () => void) => {
    if (actionDispatched) return
    actionDispatched = true
    pageHost.sensitive = false
    status.system_menu_open = false
    action()
  }

  menuBox.append(makeRow(Icons.info, t("bar.system-menu.about"), false, () => {
    dispatchAction(() => status.toggleAbout())
  }))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.settings, t("bar.system-menu.settings"), false, () => {
    dispatchAction(() => shellActions.openSettings?.())
  }))
  menuBox.append(sep())
  menuBox.append(makeRow(Icons.lock, t("bar.system-menu.lock"), false, () => {
    dispatchAction(() => { execAsync(["nidara-lock"]).catch(console.error) })
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
  const confirmIcon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER, css_classes: ["nd-icon"] })
  const confirmQuestion = new Gtk.Label({
    halign: Gtk.Align.CENTER,
    justify: Gtk.Justification.CENTER,
    css_classes: ["nidara-menu-label"],
    wrap: true,
    max_width_chars: 20,
  })

  const confirmCancelBtn = new Gtk.Button({ label: t("bar.system-menu.confirm.cancel"), css_classes: ["nidara-menu-row", "nidara-confirm-secondary"], hexpand: true })
  confirmCancelBtn.connect("clicked", () => {
    pendingCmd = null
    showPage(menuBox)
  })

  const confirmActionBtn = new Gtk.Button({ label: "", css_classes: ["nidara-menu-row", "nidara-confirm-primary"], hexpand: true })
  confirmActionBtn.connect("clicked", () => {
    if (actionDispatched) return
    actionDispatched = true
    pageHost.sensitive = false
    pendingCmd?.()
    pendingCmd = null
    showPage(menuBox)
  })

  const confirmBtnRow = new Gtk.Box({ spacing: 8, homogeneous: true, margin_top: 4 })
  confirmBtnRow.append(confirmCancelBtn)
  confirmBtnRow.append(confirmActionBtn)

  const confirmBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 12,
    // Horizontal matches menuBox: the confirm page swaps INTO the same card, so its
    // content sits on the same axis as the menu rows it replaces. Vertical is
    // symmetric — the 16/14 this used to be was a 2px optical nudge nobody wrote
    // down, and the token sweep turned it into 16/12, a nudge nobody chose.
    margin_top: 16, margin_bottom: 16,
    margin_start: rowInsetFor(RADIUS.lg) + GLASS_INSET, margin_end: rowInsetFor(RADIUS.lg) + GLASS_INSET,
    width_request: 210,
  })
  confirmBox.append(confirmIcon)
  confirmBox.append(confirmQuestion)
  confirmBox.append(confirmBtnRow)

  // Reset to menu page and restore sensitivity when closed / reopened
  status.connect("notify::system-menu-open", () => {
    if (status.system_menu_open) {
      actionDispatched = false
      pageHost.sensitive = true
    } else {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        showPage(menuBox)
        pendingCmd = null
        actionDispatched = false
        pageHost.sensitive = true
        return GLib.SOURCE_REMOVE
      })
    }
  })

  showPage(menuBox)

  const squircleWrapper = SquircleContainer({
    child: pageHost,
    radius: RADIUS.lg,
    gloss: true,
    useShellOpacity: true,
    borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
    css_classes: ["nidara-menu"],
  })

  // Position (top/left margins, dock dodge) is owned by Bar.tsx — see
  // syncPanelMargins, same as CC/NC.
  const outerBox = new Gtk.Box({
    valign: Gtk.Align.START,
    halign: Gtk.Align.START,
  })
  outerBox.append(squircleWrapper)
  return outerBox
}

export default SystemMenuOverlay
