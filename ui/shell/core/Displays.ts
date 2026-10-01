// Displays.ts — the monitors, from whichever compositor the shell is running on.
//
// On Hyprland they come from HyprlandState's cache (`hyprctl monitors`); on Hyalo, the
// compositor of our own (#680), from its IPC (`core/hyalo-ipc.ts`), kept fresh by its
// `outputs_changed` events. Both are handed out in ONE shape, so the Display page and
// MonitorConfig do not care which. The rest of the shell's Hyprland dependency moves
// behind a facade like this one in #682; this is the part #681 asks for — the Display
// page drives Hyalo's outputs through IPC.

import GObject from "gi://GObject"
import hs from "./HyprlandState"
import * as hyalo from "./hyalo-ipc"

export interface DisplayMonitor {
    name: string
    make: string
    model: string
    description: string
    width: number
    height: number
    refreshRate: number
    scale: number
    /** wl_output transform: 0 normal, 1 90°, 2 180°, 3 270°, 4–7 the same flipped. */
    transform: number
    /** "WxH@Hz", Hz with decimals — what `hyprctl monitors` lists. */
    availableModes: string[]
    vrrSupported: boolean
    /** Hyalo only: VRR on for this output. Hyprland's is the global `misc:vrr`. */
    vrrEnabled: boolean
}

/** Hyalo's transform names, in wl_output order — Hyprland's ints index this. */
export const TRANSFORM_NAMES = [
    "normal", "90", "180", "270", "flipped", "flipped-90", "flipped-180", "flipped-270",
]

function fromHyalo(o: hyalo.HyaloOutput): DisplayMonitor {
    const m = o.current_mode
    return {
        name: o.name,
        make: o.make,
        model: o.model,
        description: [o.make, o.model].filter(Boolean).join(" "),
        width: m?.width ?? 0,
        height: m?.height ?? 0,
        refreshRate: (m?.refresh ?? 0) / 1000,
        scale: o.scale,
        transform: Math.max(0, TRANSFORM_NAMES.indexOf(o.transform)),
        availableModes: o.modes.map(md => `${md.width}x${md.height}@${(md.refresh / 1000).toFixed(2)}Hz`),
        vrrSupported: o.vrr_supported,
        vrrEnabled: o.vrr_enabled,
    }
}

class DisplaysClass extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraDisplays",
            // Something about the monitors changed (on Hyprland: whenever HyprlandState
            // refreshes, which is often — consumers compare what they care about).
            Signals: { "changed": {} },
        }, this)
    }

    /** Which compositor answers. */
    readonly onHyalo = hyalo.isHyalo()
    private _hyaloOutputs: DisplayMonitor[] = []

    constructor() {
        super()
        if (this.onHyalo) {
            this._refreshHyalo()
            hyalo.subscribeEvents(ev => {
                if (ev.event !== "outputs_changed") return
                this._hyaloOutputs = (ev.outputs ?? []).filter((o: hyalo.HyaloOutput) => o.enabled).map(fromHyalo)
                this.emit("changed")
            })
        } else {
            hs.connect("changed", () => this.emit("changed"))
        }
    }

    private _refreshHyalo() {
        this._hyaloOutputs = hyalo.getOutputs().filter(o => o.enabled).map(fromHyalo)
    }

    /** The monitors that are on. */
    get monitors(): DisplayMonitor[] {
        if (this.onHyalo) return this._hyaloOutputs
        return hs.monitors.map(m => ({
            name: m.name,
            make: m.make ?? "",
            model: m.model ?? "",
            description: m.description ?? "",
            width: m.width ?? 0,
            height: m.height ?? 0,
            refreshRate: m.refreshRate ?? 0,
            scale: m.scale ?? 1,
            transform: m.transform ?? 0,
            availableModes: m.availableModes ?? [],
            // Hyprland's VRR is one global option (`misc:vrr`), not per monitor.
            vrrSupported: true,
            vrrEnabled: false,
        }))
    }
}

const displays = new DisplaysClass()
export default displays
