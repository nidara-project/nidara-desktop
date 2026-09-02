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
import { LanguageStep } from "../steps/language"
import { KeyboardStep } from "../steps/keyboard"
import { TimezoneStep } from "../steps/timezone"
import { DiskStep } from "../steps/disk"
import { AccountStep } from "../steps/account"
import { SummaryStep } from "../steps/summary"
import { RunStep } from "../steps/run"
import { WINDOW_LAYOUT } from "../../lib/tokens"
import { t, onLocaleChange } from "../lib/i18n"

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
    LanguageStep(),
    KeyboardStep(),
    TimezoneStep(),
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
    { id: "language", titleKey: "languageTitle", iconName: "globe" },
    { id: "keyboard", titleKey: "keyboardTitle", iconName: "keyboard" },
    { id: "timezone", titleKey: "timezoneTitle", iconName: "clock" },
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
  const { widget: scrolledContent, scrolled } = NidaraScrolled({
    child: NidaraClamp(flow.widget, WINDOW_LAYOUT.wizardContent, true, WINDOW_LAYOUT.wizardContent),
    reserveLane: false,
    hscrollPolicy: Gtk.PolicyType.EXTERNAL,
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

  shell = NidaraWindow({
    app,
    title: "Nidara Installer",
    name: "nidara-installer",
    appId: "nidara-installer",
    cssClasses: ["nidara-installer-window"],
    glassClasses: ["installer-root"],
    content: scrolledContent,
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
        showNidaraAlert({
            parent: win,
            heading: t("quitHeading"),
            body: t("quitBody"),
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
    // No geometry of our own. NidaraWindow already derives both numbers from
    // WINDOW_LAYOUT — an opening width that keeps the sidebar docked at the pane's
    // full width, and a minimum at the distress floor. This asked for 960×760 by
    // hand, which is 108px wider than its own layout needs (250 sidebar + 600 pane
    // + 2 rim = 852) and 280px taller than the minimum two cards and a header
    // require. A 1366×768 laptop could not fit the window it was being handed.
    // Closes #312.
    resizable: true,
  })

  const win = shell.window
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
