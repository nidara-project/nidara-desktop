import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import app from "../../lib/host"
import {
  NidaraButton, NidaraCircleButton, NidaraClamp, NidaraWindow,
  NidaraScrolled, NidaraSidebar, NIDARA_WINDOW_RADIUS,
  showNidaraAlert,
  type NidaraWindowResult,
} from "../../lib/nidara-kit"
import { ndIcon } from "../../lib/icons"
import { Flow, type Step } from "../lib/flow"
import { WelcomeStep } from "../steps/welcome"
import { RegionStep } from "../steps/region"
import { DiskStep } from "../steps/disk"
import { AccountStep } from "../steps/account"
import { SummaryStep } from "../steps/summary"
import { RunStep } from "../steps/run"
import { WINDOW_LAYOUT, WIZARD_LAYOUT, ROW_HEIGHT } from "../../lib/tokens"
import { t, onLocaleChange } from "../lib/i18n"
import { isPreview } from "../lib/preview"

function header(onClose: () => void): {
  start: Gtk.Widget
  end: Gtk.Widget
  set: (title: string) => void
  setCanClose: (can: boolean) => void
} {
  const title = new Gtk.Label({
    css_classes: ["installer-title"],
    halign: Gtk.Align.START,
    hexpand: true,
    xalign: 0,
    can_target: false,
  })

  const closeBtn = NidaraCircleButton({
    icon: ndIcon("x"),
    iconName: "window-close-symbolic",
    variant: "danger",
    valign: Gtk.Align.CENTER,
    halign: Gtk.Align.END,
    onClick: onClose,
  })
  closeBtn.name = "installer-close"

  return {
    start: title,
    end: closeBtn,
    set: (t: string) => { title.label = t },
    setCanClose: (can: boolean) => { closeBtn.sensitive = can },
  }
}

export function InstallerWindow(): Gtk.Window {
  const steps: Step[] = [
    WelcomeStep(),
    RegionStep(),
    DiskStep(),
    AccountStep(),
    SummaryStep(),
    RunStep(),
  ]
  const flow = Flow(steps)

  const canExit = () => flow.current().busy?.() !== true
  // Set by the confirmation dialog so the close it then asks for is not questioned
  // a second time by the very hook that raised it.
  let confirmedQuit = false

  const sidebarDefs = [
    { id: "welcome", titleKey: "welcomeTitle", iconName: "hand" },
    { id: "region", titleKey: "regionTitle", iconName: "globe" },
    { id: "disk", titleKey: "diskTitle", iconName: "hard-drive" },
    { id: "account", titleKey: "accountTitle", iconName: "user-round" },
    { id: "summary", titleKey: "summaryTitle", iconName: "clipboard-list" },
    { id: "run", titleKey: "runTitle", iconName: "rocket" },
  ]

  const sidebar = NidaraSidebar(
    sidebarDefs.map(d => ({
      id: d.id,
      label: t(d.titleKey as any),
      icon: ndIcon(d.iconName) as any,
    })),
    (id) => {
      if (flow.current().id === "run") return
      flow.goTo(id)
    },
  )
  sidebar.widget.set_name("nidara-installer-sidebar-list")

  function updateSidebarLabels() {
    for (let i = 0; ; i++) {
      const row = sidebar.widget.get_row_at_index(i)
      if (!row) break
      const id = row.get_name()
      const def = sidebarDefs.find(d => d.id === id)
      if (def) {
        const box = row.get_child() as Gtk.Box
        if (box) {
          let child = box.get_first_child()
          while (child) {
            if (child instanceof Gtk.Label) {
              child.label = t(def.titleKey as any)
            }
            child = child.get_next_sibling()
          }
        }
      }
    }
  }

  const back = NidaraButton({ label: t("back"), variant: "secondary" })
  const next = NidaraButton({ label: t("continue"), variant: "primary" })
  const closeActionBtn = NidaraButton({ label: t("runClose"), variant: "secondary" })
  const restartActionBtn = NidaraButton({ label: t("runRestart"), variant: "primary" })

  back.connect("clicked", () => flow.back())
  next.connect("clicked", () => {
    const step = flow.current()
    if (step.ready && !step.ready()) return
    flow.next()
  })
  closeActionBtn.connect("clicked", () => shell.close())
  restartActionBtn.connect("clicked", () => {
    // Reachable in preview, because preview walks the flow to its end — and there
    // the last button on the last page reboots the machine you are working on.
    if (isPreview()) {
      console.log("[PREVIEW] not executed: systemctl reboot")
      return
    }
    try {
      Gio.Subprocess.new(["systemctl", "reboot"], Gio.SubprocessFlags.NONE)
    } catch {}
  })

  const navBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 10,
    halign: Gtk.Align.END,
  })
  navBox.append(back)
  navBox.append(next)
  navBox.append(closeActionBtn)
  navBox.append(restartActionBtn)

  const position = new Gtk.Label({
    css_classes: ["installer-position"],
    halign: Gtk.Align.START,
    valign: Gtk.Align.CENTER,
    can_target: false,
  })

  const footer = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    halign: Gtk.Align.FILL,
    css_classes: ["installer-footer"],
  })
  footer.append(position)
  const footerSpacer = new Gtk.Box({ hexpand: true })
  footer.append(footerSpacer)
  footer.append(navBox)

  flow.widget.add_css_class("installer-body")
  // ⚠️ `propagateNaturalHeight` is what makes the window's size follow the LAYOUT
  // instead of the other way round. Without it this scroller reports no natural
  // height of its own, the window falls back to the two-pane default of 760, and
  // every list inside it has to be given a pixel height that fits — which is
  // exactly the tail wagging the dog that WIZARD_LAYOUT exists to end. With it,
  // the page's own natural height (heading, prose, six whole rows, whatever sits
  // under them) is what the window asks for, and the scroller goes back to being
  // what a scroller is for: the case where the window is smaller than that.
  const { widget: scrolledContent, scrolled } = NidaraScrolled({
    child: NidaraClamp(flow.widget, WINDOW_LAYOUT.wizardContent, true, WINDOW_LAYOUT.wizardContent),
    reserveLane: false,
    hscrollPolicy: Gtk.PolicyType.EXTERNAL,
    propagateNaturalHeight: true,
    cornerRadius: NIDARA_WINDOW_RADIUS,
    cssClasses: ["installer-page-scroll"],
  })
  scrolled.hexpand = true
  scrolled.vexpand = true
  scrolledContent.hexpand = true
  scrolledContent.vexpand = true

  let shell: NidaraWindowResult
  const head = header(() => shell.close())
  const sidebarIcon = ndIcon("sidebar") ?? Gio.ThemedIcon.new("sidebar-symbolic")

  // The banner is the whole reason preview is allowed to look like the installer:
  // a screenshot of a preview must never be mistakable for a screenshot of an
  // install. It sits above the content rather than in the header so it survives
  // the sidebar being collapsed, and it is the first thing in the reading order.
  const rootContent = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true })
  if (isPreview()) {
    const banner = new Gtk.Label({
      label: t("previewBanner"),
      css_classes: ["installer-preview-banner"],
      halign: Gtk.Align.FILL,
      xalign: 0,
      wrap: true,
      can_target: false,
    })
    rootContent.append(banner)
  }
  rootContent.append(scrolledContent)

  shell = NidaraWindow({
    app,
    title: "Nidara Installer",
    name: "nidara-installer",
    appId: "nidara-installer",
    cssClasses: ["nidara-installer-window"],
    glassClasses: ["installer-root"],
    content: rootContent,
    sidebar: {
      widget: sidebar.widget,
      toggleIcon: sidebarIcon as any,
      width: WINDOW_LAYOUT.sidebar,
      contentWidth: WINDOW_LAYOUT.wizardContent,
    },
    footer,
    header: { start: head.start, end: head.end },
    closeOnEscape: true,
    // Refused while the install is running (that has always been true), and now
    // also questioned once anything has been answered.
    //
    // Nidara had never implemented an "are you sure" on any window, and both
    // halves of one were already sitting here: NidaraWindow's `onClose` hook
    // refuses a close by returning true, and the kit ships `showNidaraAlert`.
    // Nothing had wired them together, so the X and Escape threw away a filled-in
    // form — a chosen disk, a typed password — on one stray click, with no undo
    // and nothing on screen to suggest one was possible.
    //
    // Past the welcome page is the test, which is where Calamares draws the same
    // line: before that there is nothing to lose and a confirmation is just a
    // second click.
    onClose: () => {
        if (!canExit()) return true
        if (confirmedQuit || flow.currentIndex() === 0) return false
        // ⚠️ The body depends on WHERE the flow is. "Nothing has been written to
        // the disk" is true on every page before the install and flatly wrong
        // after one — and it is the sentence somebody reads while deciding
        // whether it is safe to close (D-28). Reaching the run step at all means
        // the install was started; not being busy there means it has finished.
        const installed = flow.current().id === "run"
        showNidaraAlert({
            parent: win,
            heading: t("quitHeading"),
            body: installed ? t("quitBodyAfter") : t("quitBody"),
            responses: [
                { id: "stay", label: t("quitStay"), suggested: true },
                { id: "quit", label: t("quitConfirm"), destructive: true },
            ],
            onResponse: (id) => {
                if (id !== "quit") return
                confirmedQuit = true
                shell.close()
            },
        })
        return true
    },
    // No WIDTH of our own. NidaraWindow derives it from WINDOW_LAYOUT — an opening
    // width that keeps the sidebar docked at the pane's full width, and a minimum
    // at the distress floor. This asked for 960×760 by hand, which is 108px wider
    // than its own layout needs (250 sidebar + 600 pane + 2 rim = 852) and 280px
    // taller than the minimum two cards and a header require. A 1366×768 laptop
    // could not fit the window it was being handed. Closes #312.
    //
    // And no HEIGHT of our own either, now: -1 turns off the two-pane default of
    // 760 so that the measurement below is what decides. See WIZARD_LAYOUT.
    defaultHeight: -1,
    resizable: true,
  })

  const win = shell.window

  // ── The opening height is MEASURED, not chosen ───────────────────────────────
  // The width comes from a law (sidebar + pane + rim); the height used to come
  // from a literal 760 that the lists were then cut to fit. It comes from the same
  // place now: ask the layout, open at what it says.
  //
  //   glass          the footer and the card's own padding
  // + contentColumn  the header, and the page under it with its list at the FLOOR
  // + the rows       the difference between that floor and WIZARD_LAYOUT.listRows
  //
  // Only the last term is a number somebody chose. The other two are GTK adding up
  // a heading, a paragraph wrapped in whatever language this is, a search box and
  // whatever the page puts below the list — none of which can be written down
  // honestly, because a paragraph's height is a property of the language.
  //
  // ⚠️ The list is measured at its FLOOR on purpose, and the rows are added back
  // here rather than asked for down there. That way a page carrying more than a
  // list — the region page has a card and a keyboard test box under it — still
  // fits inside this height: its extra content eats into the list's share instead
  // of pushing the page into a scroll. The list is the only thing on the page that
  // vexpands, so it is the only thing that gives.
  //
  // ⚠️ Measured before `present()`: the widgets exist, so GTK can add them up, and
  // the window has not been sized yet. And measured through `contentColumn`, not
  // through the window — see NidaraWindowResult for why the window cannot see its
  // own content.
  //
  // ⚠️ The cap uses the SMALLEST monitor. A window has no monitor before it is
  // mapped and the compositor decides where it lands, so a height computed for a
  // 1440p screen would open a window that does not fit the 1366×768 laptop beside
  // it — and Hyprland CENTRES what does not fit rather than clipping it, which
  // puts the header above the top edge with no way to reach it.
  //
  // ⚠️ The WIDTH is read back from the window, never recomputed. NidaraWindow has
  // already derived it — the breakpoint plus WINDOW_LAYOUT.openGutter, which is
  // the air on either side of the pane — and a second copy of that derivation is
  // a copy that can disagree with the first. Mine did, on the day it was written:
  // it left the gutter out and the window opened 852 instead of 898, with the page
  // flush against the sidebar on one side and the glass rim on the other.
  const openWidth = win.default_width
  const monitorHeights = app.get_monitors().map(m => m.get_geometry().height).filter(h => h > 0)
  const cap = Math.round(
      Math.min(...(monitorHeights.length ? monitorHeights : [WINDOW_LAYOUT.minHeight]))
      * WIZARD_LAYOUT.maxMonitorFraction,
  )
  const [, chromeHeight] = shell.glass.measure(Gtk.Orientation.VERTICAL, openWidth)
  const [, columnHeight] = shell.contentColumn!.measure(Gtk.Orientation.VERTICAL, WINDOW_LAYOUT.wizardContent)
  const listBudget = (WIZARD_LAYOUT.listRows - WIZARD_LAYOUT.minListRows) * ROW_HEIGHT.double
  // The HEIGHT only. `set_default_size` would take the width with it, and the
  // width is not ours to state.
  win.default_height = Math.max(
      WINDOW_LAYOUT.minHeight,
      Math.min(chromeHeight + columnHeight + listBudget, cap),
  )
  win.connect("destroy", () => app.quit())

  function sync() {
    if (scrolled?.vadjustment) {
      scrolled.vadjustment.value = 0
    }

    const step = flow.current()
    const index = flow.currentIndex() + 1
    const title = typeof step.title === "function" ? step.title() : step.title
    const nextLabel = typeof step.nextLabel === "function" ? step.nextLabel() : step.nextLabel

    const isRunStep = step.id === "run"
    const isBusy = step.busy?.() === true
    const maxIdx = flow.maxReachedIndex()

    sidebarDefs.forEach((def, i) => {
      if (isRunStep || isBusy) {
        sidebar.setItemSensitive(def.id, false)
      } else {
        sidebar.setItemSensitive(def.id, i <= maxIdx && def.id !== "run")
      }
    })

    sidebar.select(step.id)
    updateSidebarLabels()

    head.set(title)
    position.label = `${index} ${t("of")} ${steps.length}`

    if (step.id === "run") {
      position.visible = false
      back.visible = false
      next.visible = false
      if (step.busy?.() === true) {
        closeActionBtn.visible = false
        restartActionBtn.visible = false
      } else {
        closeActionBtn.visible = true
        restartActionBtn.visible = true
      }
    } else {
      position.visible = true
      closeActionBtn.visible = false
      restartActionBtn.visible = false
      back.visible = flow.canBack()
      next.visible = true
      next.set_label(nextLabel)
      back.set_label(t("back"))
      next.sensitive = step.ready ? step.ready() : true
      if (index === steps.length) next.sensitive = false
    }

    closeActionBtn.set_label(t("runClose"))
    restartActionBtn.set_label(t("runRestart"))
    head.setCanClose(canExit())
  }
  flow.onChange(sync)
  // A language change invalidates every page, because a page translates itself
  // once, inside build(). The frame and the summary were the only two things
  // subscribed here; the other six steps held 72 strings frozen at whatever the
  // language happened to be when each was first reached.
  //
  // ⚠️ Deferred to an idle, and it has to be: the only thing that changes the
  // language is activating a row on the language page, so this fires from inside
  // that row's own "row-activated" handler — and the rebuild destroys the list
  // that handler is still running on. Let the emission finish first.
  onLocaleChange(() => {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      flow.invalidate()
      sync()
      return GLib.SOURCE_REMOVE
    })
    sync()
  })
  sync()

  return win
}
