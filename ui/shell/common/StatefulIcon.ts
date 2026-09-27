import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import { onInterfaceIconThemeChange, uiIcon, type IconName } from "../core/Icons"
import { reduceMotion, onReduceMotionChange } from "../core/ReduceMotion"

/**
 * An interface icon with STATES — one drawing that changes, and can animate the
 * change, when the thing it shows changes (the Control Centre's two switches flip
 * when it opens).
 *
 * The file is an ordinary `nd-*-symbolic.svg` carrying GTK's own extension of SVG
 * (`xmlns:gpa="https://www.gtk.org/grappa"`, GTK ≥ 4.22): `gpa:state-names` on the
 * root names the states, and `<animate begin="gpa:states(N).begin">` or a shape's
 * `gpa:states` / `gpa:transition-type` say what happens on the way into each one.
 * The format is documented at https://docs.gtk.org/gtk4/icon-format.html, and
 * `gtk4-icon-editor` edits it.
 *
 * ⚠️ `uiIcon()` hands back a `Gio.FileIcon`, and through that path GTK draws the file
 * in its INITIAL state and never lets anyone change it — measured, 2026-09-27. So a
 * stateful icon is loaded here into a `Gtk.Svg` and shown as the image's PAINTABLE.
 * Every other consumer of the same name keeps using `uiIcon()` and gets the still
 * drawing, which is why the initial state has to be a complete picture on its own.
 *
 * Measured the same day, and each one cost a try:
 *  - without `set_frame_clock` + `play()` a transition never leaves its first frame:
 *    a shape that fades IN on a state change stays invisible;
 *  - an animation tied to the state the file STARTS in does not run — only a change
 *    of state starts one;
 *  - `none` and `all` are keywords of `gpa:states`, so they cannot name a state: the
 *    whole state list is refused, and every shape with it.
 *
 * ⚠️ REDUCE MOTION holds the icon in its initial state — nothing else here honours
 * it. `Gtk.SvgFeatures.ANIMATIONS` does NOT stop an animation a state change starts:
 * measured with the feature on and off, the switches stood at the same point 150 ms
 * into the flip. So an icon whose states are only decoration (the CC's switches:
 * the open CC is marked by the item's pill anyway) simply stops changing. An icon
 * whose state carries MEANING needs another answer before it uses this.
 *
 * 🔑 Only momentary animation belongs here. A state change lasts a few hundred ms;
 * a loop re-blurs the surface every frame for as long as it lasts (design-system.md,
 * "continuous or punctual?").
 *
 * The drawing follows the interface icon theme like any `uiIcon`: a theme's file
 * is used when it has one, and a theme that draws the name WITHOUT states simply
 * shows the same picture in every state. `IconThemeRefresh` does not reach this
 * image (it holds no gicon), so it reloads itself.
 */
export interface StatefulIcon {
    readonly widget: Gtk.Image
    /** Go to the state called `name` in the file's `gpa:state-names`. Unknown names
     *  (a theme's drawing without states) are ignored. */
    setState(name: string): void
}

export function statefulIcon(name: IconName, opts: { pixelSize: number, cssClasses?: string[] }): StatefulIcon {
    const svg = new Gtk.Svg()
    const image = new Gtk.Image({ paintable: svg, pixel_size: opts.pixelSize, css_classes: opts.cssClasses ?? [] })
    let state = ""
    let reported = false

    svg.connect("error", (_s: Gtk.Svg, e: { message: string }) => {
        if (reported) return   // one line per load is enough to find the file
        reported = true
        console.warn(`[StatefulIcon] ${name}: ${e.message}`)
    })

    const apply = () => {
        if (reduceMotion()) return
        const [names] = svg.get_state_names()
        const index = names?.indexOf(state) ?? -1
        if (index >= 0 && svg.state !== index) svg.state = index
    }

    const load = () => {
        const path = uiIcon(name).get_file().get_path()
        if (!path) return
        try {
            const [, bytes] = Gio.File.new_for_path(path).load_contents(null)
            reported = false
            svg.load_from_bytes(GLib.Bytes.new(bytes))
            apply()
        } catch (e) {
            console.warn(`[StatefulIcon] ${name}: cannot read ${path}:`, e)
        }
    }

    image.connect("map", () => { svg.set_frame_clock(image.get_frame_clock()!); svg.play() })
    image.connect("unmap", () => svg.pause())

    const offTheme = onInterfaceIconThemeChange(load)
    // Reloading puts the drawing back in the file's own state; `apply` then moves it
    // on only while motion is allowed.
    const offMotion = onReduceMotionChange(load)
    image.connect("destroy", () => { offTheme(); offMotion() })

    load()

    return {
        widget: image,
        setState(next: string) {
            if (next === state) return
            state = next
            apply()
        },
    }
}
