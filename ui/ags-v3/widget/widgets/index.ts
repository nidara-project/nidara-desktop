import { AtomicWidget } from "../control-center/Types"
import cpuMemory from "./cpu-memory"
import volume    from "./volume"
import wifi      from "./wifi"
import ethernet  from "./ethernet"
import bluetooth from "./bluetooth"
import darkMode  from "./dark-mode"
import focus     from "./focus"
import calculator from "./calculator"
import media     from "./media"

const ALL_WIDGETS: AtomicWidget[] = [
    cpuMemory,
    volume,
    wifi,
    ethernet,
    bluetooth,
    darkMode,
    focus,
    calculator,
    media,
]

const _map = new Map<string, AtomicWidget>(ALL_WIDGETS.map(w => [w.id, w]))

export const registry = {
    get: (id: string): AtomicWidget | null => _map.get(id) ?? null,
    all: (): AtomicWidget[] => [...ALL_WIDGETS],
    barCapable: (): AtomicWidget[] => ALL_WIDGETS.filter(w => w.locations?.includes("bar")),
    ccCapable:  (): AtomicWidget[] => ALL_WIDGETS.filter(w => w.locations?.includes("cc")),
}

export default registry
