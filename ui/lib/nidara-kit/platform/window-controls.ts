// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"

/**
 * The client half of nidara-window-controls-v1 (`protocols/` at the repository root, #708
 * point 5): on a compositor of our own (Hyalo) a window's controls — close, minimize,
 * maximize — are the compositor's. It draws them, the same in every window, over the app's
 * own header, and takes their clicks; the app only leaves room for them. The compositor
 * says how big the room is and on which side it goes (the user's setting); the window has
 * SLOTS — places that can hold it, each saying for which side and in which state of the
 * layout it is the one — and the first slot that applies gets the room, and its position is
 * sent with every frame that moves it (the frame clock's layout phase, so it lands with the
 * buffer that left the room).
 *
 * Where the compositor draws none (Hyprland), nothing changes: the slots stay hidden and the
 * window's own close button (its FALLBACK) is shown, as before.
 *
 * Loaded lazily and tolerated missing, like the material: a checkout updated without
 * reinstalling libnidara-wl keeps its own buttons.
 */

export type ControlsSide = "right" | "left"

export type ControlsSlot = {
    widget: Gtk.Widget
    /** Whether this slot holds the controls now, for the user's side. */
    when: (side: ControlsSide) => boolean
}

type Shim = {
    init(): boolean
    has_window_controls?(): boolean
    window_controls_set_layout_func?(f: (surface: Gdk.Surface, side: number, w: number, h: number) => void): void
    window_controls_request?(surface: Gdk.Surface): boolean
    window_controls_set_position?(surface: Gdk.Surface, x: number, y: number): boolean
    window_controls_unset_position?(surface: Gdk.Surface): void
}

const SHIM_MODULE = "gi://NidaraWl"   // in a variable on purpose: see VisibleRegion.ts

type Layout = { side: ControlsSide, width: number, height: number }

class Controller {
    layout: Layout | null = null
    /** The position last sent, or "" for none. */
    sent = "\u0000"
    surface: Gdk.Surface | null = null
    tick = 0

    constructor(
        readonly win: Gtk.Window,
        readonly slots: ControlsSlot[],
        readonly fallbacks: Gtk.Widget[],
    ) {}

    /** The compositor's layout (or none): which widgets show. Out of the frame clock. */
    refresh() {
        const l = this.layout
        for (const f of this.fallbacks) f.visible = !l
        let taken = false
        for (const s of this.slots) {
            const on = !!l && !taken && s.when(l.side)
            if (on) taken = true
            s.widget.visible = on
            if (l) s.widget.set_size_request(Math.ceil(l.width), Math.ceil(l.height))
        }
        this.win.queue_allocate()
    }

    /** Where the active slot is, surface-local: sent when it moved. In the layout phase. */
    place() {
        const surface = this.surface
        if (!surface || !shim || !this.layout) return
        const slot = this.slots.find(s => s.widget.visible && s.widget.get_mapped())
        let key = ""
        let x = 0, y = 0
        if (slot) {
            const [ok, p] = slot.widget.compute_point(this.win, new Graphene.Point({ x: 0, y: 0 }))
            if (ok) {
                const [tx, ty] = this.win.get_surface_transform()
                x = p.x + tx
                y = p.y + ty
                key = `${x.toFixed(2)},${y.toFixed(2)}`
            }
        }
        if (key === this.sent) return
        this.sent = key
        if (key) shim.window_controls_set_position?.(surface, x, y)
        else shim.window_controls_unset_position?.(surface)
    }

    attach() {
        const surface = this.win.get_surface()
        if (!surface || !shim?.window_controls_request?.(surface)) return
        this.surface = surface
        controllers.set(surface, this)
        const clock = surface.get_frame_clock()
        if (clock && !this.tick) this.tick = clock.connect_after("layout", () => this.place())
    }

    detach() {
        if (this.surface) {
            controllers.delete(this.surface)
            if (this.tick) this.surface.get_frame_clock()?.disconnect(this.tick)
        }
        this.tick = 0
        this.surface = null
        this.sent = "\u0000"
    }
}

let shim: Shim | null = null
let loadStarted = false
const pending: Controller[] = []
const controllers = new Map<Gdk.Surface, Controller>()

function load() {
    if (shim || loadStarted) return
    loadStarted = true
    import(SHIM_MODULE)
        .then(mod => {
            const wl = (mod.default ?? mod) as unknown as Shim
            if (!wl.init() || !wl.has_window_controls?.()) return
            shim = wl
            wl.window_controls_set_layout_func?.((surface, side, width, height) => {
                const c = controllers.get(surface)
                if (!c) return
                c.layout = { side: side === 1 ? "left" : "right", width, height }
                c.sent = "\u0000"
                c.refresh()
            })
            for (const c of pending.splice(0)) if (c.win.get_realized()) c.attach()
        })
        .catch(e => console.log(`[WindowControls] unavailable: ${e}`))
}

/**
 * Lets the compositor draw `win`'s controls in one of `slots` — or, where it draws none,
 * leaves `fallbacks` (the window's own close button) as they are. The slots start hidden.
 * Call `refresh` when the layout a slot's `when` reads changes (a sidebar shown or hidden).
 */
export function attachWindowControls(win: Gtk.Window, slots: ControlsSlot[], fallbacks: Gtk.Widget[]): { refresh: () => void } {
    for (const s of slots) s.widget.visible = false
    const c = new Controller(win, slots, fallbacks)
    if (GLib.getenv("NIDARA_WINDOW_CONTROLS") === "0") return { refresh: () => {} }
    win.connect("realize", () => { if (shim) c.attach(); else pending.push(c) })
    win.connect("unrealize", () => { c.detach(); c.layout = null; c.refresh() })
    if (win.get_realized()) pending.push(c)
    load()
    return { refresh: () => { if (c.layout) c.refresh() } }
}

/** An empty slot: the room the controls take, with its alignment in the row. */
export function controlsSlotWidget(halign: Gtk.Align = Gtk.Align.CENTER): Gtk.Box {
    return new Gtk.Box({ name: "nidara-window-controls-slot", valign: Gtk.Align.CENTER, halign, can_target: false })
}
