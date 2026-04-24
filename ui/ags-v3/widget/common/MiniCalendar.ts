import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import regionConfig from "../../core/RegionConfig"

const MONTH_NAMES = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
]
const DAY_MON = ["Mo","Tu","We","Th","Fr","Sa","Su"]
const DAY_SUN = ["Su","Mo","Tu","We","Th","Fr","Sa"]

function daysInMonth(year: number, month: number): number {
    const next = month === 12
        ? GLib.DateTime.new_local(year + 1, 1, 1, 0, 0, 0)
        : GLib.DateTime.new_local(year, month + 1, 1, 0, 0, 0)
    return next!.add_days(-1).get_day_of_month()
}

export function MiniCalendar(): Gtk.Widget {
    const now = GLib.DateTime.new_now_local()!
    let dispYear  = now.get_year()
    let dispMonth = now.get_month()  // 1-12

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        css_classes: ["nc-mini-cal"],
        hexpand: true,
    })

    // ── Header ──────────────────────────────────────────────────────────────
    const header = new Gtk.CenterBox({ css_classes: ["nc-mini-cal-header"], hexpand: true })
    const prevBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "pan-start-symbolic", pixel_size: 12 }),
        css_classes: ["nc-mini-cal-nav"],
    })
    const nextBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "pan-end-symbolic", pixel_size: 12 }),
        css_classes: ["nc-mini-cal-nav"],
    })
    const monthLabel = new Gtk.Label({ css_classes: ["nc-mini-cal-month"] })
    header.set_start_widget(prevBtn)
    header.set_center_widget(monthLabel)
    header.set_end_widget(nextBtn)
    root.append(header)

    // ── Grid ────────────────────────────────────────────────────────────────
    const grid = new Gtk.Grid({
        hexpand: true,
        column_homogeneous: true,
        row_spacing: 2,
        css_classes: ["nc-mini-cal-grid"],
    })
    root.append(grid)

    const render = () => {
        monthLabel.label = `${MONTH_NAMES[dispMonth - 1]} ${dispYear}`

        while (grid.get_first_child()) grid.get_first_child()!.unparent()

        const monday = regionConfig.weekStartsMonday
        const names = monday ? DAY_MON : DAY_SUN
        names.forEach((n, col) => {
            grid.attach(
                new Gtk.Label({ label: n, css_classes: ["nc-mini-cal-day-name"], hexpand: true }),
                col, 0, 1, 1,
            )
        })

        const firstDow = GLib.DateTime.new_local(dispYear, dispMonth, 1, 0, 0, 0)!.get_day_of_week()
        // GLib dow: 1=Mon … 7=Sun
        const startCol = monday ? (firstDow - 1) : (firstDow % 7)

        const todayY = now.get_year()
        const todayM = now.get_month()
        const todayD = now.get_day_of_month()
        const total  = daysInMonth(dispYear, dispMonth)

        let col = startCol, row = 1
        for (let d = 1; d <= total; d++) {
            const isToday = d === todayD && dispMonth === todayM && dispYear === todayY
            const css = isToday ? ["nc-mini-cal-day", "today"] : ["nc-mini-cal-day"]
            grid.attach(
                new Gtk.Label({ label: String(d), css_classes: css, hexpand: true }),
                col, row, 1, 1,
            )
            if (++col === 7) { col = 0; row++ }
        }
    }

    prevBtn.connect("clicked", () => {
        if (--dispMonth < 1)  { dispMonth = 12; dispYear-- }
        render()
    })
    nextBtn.connect("clicked", () => {
        if (++dispMonth > 12) { dispMonth = 1;  dispYear++ }
        render()
    })

    render()

    const sigId = regionConfig.connect("changed", render)
    root.connect("unrealize", () => { try { regionConfig.disconnect(sigId) } catch {} })

    return root
}
