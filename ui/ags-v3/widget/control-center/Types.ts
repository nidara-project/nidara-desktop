import { Gtk } from "ags/gtk4"
import { Shape } from "../common/SquircleContainer"

export interface AtomicWidget {
    id: string
    grid: { x: number, y: number, w: number, h: number }
    shape: Shape
    child: Gtk.Widget
    name: string
}
