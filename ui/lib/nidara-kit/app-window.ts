import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { setWindowAppId } from "../app-id"

/**
 * NIDARA KIT — the base every Nidara application window is built from
 * ===================================================================
 *
 * A window in this desktop is a fixed set of decisions: undecorated, its glass
 * painted by a BOX inside the toplevel rather than by the toplevel itself, a
 * draggable header because there is no titlebar, an app-id of its own so the
 * compositor files it under a name the desktop registry has, and one policy for
 * what "close" means. Four windows had made those decisions separately —
 * `NidaraWindow` (Settings), About, the installer, and the two login screens —
 * and they had drifted: two spellings of the Escape keyval, three ways of
 * deciding whether closing hides or destroys, and one window that lost its glass
 * to a selector nobody re-checked.
 *
 * This is the base. `NidaraWindow` is this plus a sidebar and a split view; a
 * window with no sidebar uses this directly instead of re-assembling the chrome.
 *
 * ── WHY THE GLASS IS A CHILD BOX AND NOT THE WINDOW ─────────────────────────
 * The toplevel stays fully transparent so the compositor has a low-alpha region
 * to blur, and the card inside is what carries the colour. Painting the window
 * itself gives a pane you can read the desktop through, unblurred. It is also the
 * reason `background-color` must be set on the WINDOW NODE only: a
 * `window.foo *` rule is (0,1,1) and `.nidara-window-glass` is (0,1,0), so a
 * blanket transparent background out-ranks the glass and the card stops painting.
 */

/** What closing this window does when nothing overrides it. */
export type NidaraCloseMode = "hide" | "destroy"

export interface NidaraAppWindowHeader {
    /** Leading slot — a title, a back button, a toolbar. */
    start?: Gtk.Widget
    center?: Gtk.Widget
    /** Trailing slot — conventionally the close button (`NidaraCircleButton`). */
    end?: Gtk.Widget
    /** Extra classes on the header's `Gtk.CenterBox`. */
    cssClasses?: string[]
}

export interface NidaraAppWindowOpts {
    /** The bundle's `Gtk.Application` (`ui/lib/host`). */
    app: any
    title: string
    content: Gtk.Widget
    /**
     * The header bar. Omit for a window that has none — About puts its close
     * button inside its card, and the login screens have no chrome at all.
     * When present it is wrapped in a `Gtk.WindowHandle`: the window is
     * undecorated, so without that it can only be moved with a compositor keybind.
     */
    header?: NidaraAppWindowHeader
    /** Pinned below the content — a wizard's Back/Continue row. */
    footer?: Gtk.Widget

    /**
     * Hide or destroy on close. Default `"destroy"`.
     *
     * ⚠️ Not a style preference. Settings HIDES because it is reused across
     * toggles and rebuilding its 21 pages on every open would be visible; About
     * DESTROYS because a hidden window keeps the application alive and blocks the
     * process from quitting.
     */
    closeMode?: NidaraCloseMode
    /**
     * Called before every close, from the close button, the compositor's close
     * request and Escape alike. **Return `true` to REFUSE** — the installer does
     * that while `archinstall` is running. Anything else lets `closeMode` proceed.
     */
    onClose?: () => boolean | void
    /** Escape closes the window, through the same policy. Default false. */
    closeOnEscape?: boolean

    resizable?: boolean
    defaultWidth?: number
    defaultHeight?: number
    /** Floor for the toplevel (GTK sends it as `xdg_toplevel.set_min_size`). */
    minWidth?: number
    minHeight?: number

    cssClasses?: string[]
    /** Extra classes beside `nidara-window-glass` on the card. */
    glassClasses?: string[]
    /** `Gtk.Window` name, for `#id` CSS and compositor matching. */
    name?: string
    /**
     * The Wayland app-id this window declares for ITSELF, instead of inheriting
     * the process-wide one — see `ui/lib/app-id.ts`.
     */
    appId?: string
}

export interface NidaraAppWindowResult {
    window: Gtk.Window
    /** The glass card. Append to it only if you are NOT using `content`. */
    glass: Gtk.Box
    /** The header's CenterBox, or null when the window has no header. */
    header: Gtk.CenterBox | null
    /** Run the close policy — what the close button should call. */
    close: () => void
    /** Show, or hide if already visible (what a toggle action wants). */
    toggle: () => void
}

export function NidaraAppWindow(opts: NidaraAppWindowOpts): NidaraAppWindowResult {
    const {
        app, title, content, header, footer,
        closeMode = "destroy", onClose, closeOnEscape = false,
        resizable, defaultWidth, defaultHeight, minWidth, minHeight,
        cssClasses = [], glassClasses = [], name, appId,
    } = opts

    const win = new Gtk.Window({
        title,
        application: app,
        css_classes: cssClasses,
        decorated: false,
        visible: false,
    })
    if (defaultWidth) win.default_width = defaultWidth
    if (defaultHeight) win.default_height = defaultHeight
    if (resizable !== undefined) win.resizable = resizable
    if (minWidth || minHeight) win.set_size_request(minWidth ?? -1, minHeight ?? -1)
    if (name) win.set_name(name)
    if (appId) setWindowAppId(win, appId)

    // ── The one close path ───────────────────────────────────────────────────
    // The button, the compositor's request and Escape all arrive here, so a
    // window cannot end up with a header button that refuses and an Escape that
    // does not — which is exactly the shape of the installer bug this replaces.
    let closing = false
    const runClose = (): boolean => {
        if (closing) return false
        if (onClose?.() === true) return true       // refused
        closing = true
        if (closeMode === "hide") win.set_visible(false)
        else win.destroy()
        closing = false
        return true
    }

    win.connect("close-request", () => {
        runClose()
        // TRUE either way: the default handler must not also run. When the close
        // was allowed, `runClose` already did it; when it was refused, letting GTK
        // close the window anyway is precisely what the refusal is for.
        return true
    })

    if (closeOnEscape) {
        const esc = new Gtk.EventControllerKey()
        esc.connect("key-pressed", (_c, keyval) => {
            if (keyval !== Gdk.KEY_Escape) return false
            runClose()
            return true
        })
        win.add_controller(esc)
    }

    // ── The card ─────────────────────────────────────────────────────────────
    const glass = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["nidara-window-glass", ...glassClasses],
    })

    let headerBox: Gtk.CenterBox | null = null
    if (header) {
        headerBox = new Gtk.CenterBox({
            css_classes: ["nidara-window-header", ...(header.cssClasses ?? [])],
        })
        if (header.start) headerBox.set_start_widget(header.start)
        if (header.center) headerBox.set_center_widget(header.center)
        if (header.end) headerBox.set_end_widget(header.end)
        const handle = new Gtk.WindowHandle({ child: headerBox })
        glass.append(handle)
    }

    glass.append(content)
    if (footer) glass.append(footer)
    win.set_child(glass)

    return {
        window: win,
        glass,
        header: headerBox,
        close: () => { runClose() },
        toggle: () => {
            if (win.visible) win.set_visible(false)
            else win.present()
        },
    }
}
