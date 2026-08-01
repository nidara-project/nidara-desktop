import { Gtk } from "ags/gtk4"
import agentConfig from "../../core/AgentConfig"
import { GRID_WIDTH } from "../control-center/CCLayoutManager"
import SquircleContainer, { Shape } from "../../common/SquircleContainer"
import { NidaraButton } from "../../../lib/nidara-kit/button"
import { t } from "../../core/i18n"

// ─────────────────────────────────────────────────────────────────────────────
// Status indicators — a PERMISSION the Control Center holds the switch for
// (AI control today; mic/camera/screen-share when they get source detection).
// Pattern: a small ALWAYS-VISIBLE badge on the bar's Control-Center button, with
// the detail + the switch inside the Control Center (a banner above the widgets).
// Adding one is a new INDICATORS entry.
//
// The badge means exactly ONE thing: "the Control Center has something for you."
// An indicator whose story is told in full somewhere else, or whose CC surface
// might not exist, does not belong here — that is why recording left (below).
//
// Three states per indicator:
//   hidden — not happening.
//   armed  — relevant but idle (AI control granted but not acting): subtle.
//   active — happening now (the agent just acted): full.
// ─────────────────────────────────────────────────────────────────────────────

export type IndicatorState = "hidden" | "armed" | "active"

interface BarIndicator {
    id: string
    label: () => string          // banner row title
    detail: () => string         // banner row subtitle (state description)
    state: () => IndicatorState
    // Register cb to run whenever state() may have changed. Shell-lifetime — the
    // badge/banner live as long as the bar, so subscriptions are never torn down.
    subscribe: (cb: () => void) => void
    // Stop/revoke, surfaced as the banner's action button.
    onClick: () => void
}

const INDICATORS: BarIndicator[] = [
    // RECORDING IS NOT HERE ANYMORE (2026-08-02). It was the original reason this
    // registry exists, and it left in two steps: first its banner row (the
    // Activity Island shows the live capture on a surface that is always on
    // screen), then the badge itself. The badge's whole meaning is "the Control
    // Center has something for you" — and for a capture the CC has nothing to
    // show: the screenrecord tile is opt-in (`defaultInCc: false`) and can be
    // placed in the BAR ONLY, so the badge was pointing at a panel that might
    // contain no word about the recording. It also brightened (armed → active)
    // when a capture started, promising an escalation with nothing behind it.
    // A capture lives in the island, end to end; see surfaces/island/RecordingIsland.
    // This registry is now for PERMISSIONS — things the CC genuinely holds the
    // switch for. `status.recording` is deliberately no longer read here.
    {
        // Computer-use awareness + kill switch. "armed" while control is GRANTED but
        // idle (so the badge is always visible while permitted), "active" for a few
        // seconds after a real action fires (agentConfig.pulseComputerAction).
        id: "ai-control",
        label: () => t("cc.status.ai.label"),
        detail: () => agentConfig.computerActing ? t("cc.status.ai.active") : t("cc.status.ai.armed"),
        state: () => !agentConfig.allowComputerControl
            ? "hidden"
            : agentConfig.computerActing ? "active" : "armed",
        subscribe: (cb) => { agentConfig.onChange(cb) },
        onClick: () => agentConfig.setAllowComputerControl(false),
    },
]

// Subscribe a callback to every indicator's change signal.
function subscribeAll(cb: () => void) {
    for (const ind of INDICATORS) ind.subscribe(cb)
}

// Aggregate state for the single bar badge: active if any is active, else armed if
// any is armed, else hidden.
function barState(): IndicatorState {
    let armed = false
    for (const ind of INDICATORS) {
        const s = ind.state()
        if (s === "active") return "active"
        if (s === "armed") armed = true
    }
    return armed ? "armed" : "hidden"
}

// ── Bar badge ─────────────────────────────────────────────────────────────────
// A small dot CENTRED on the Control-Center capsule's right-gap overlay (Bar.tsx packs
// the gear, then a 16px spacer with this dot overlaid). halign/valign CENTER → the
// Overlay centres it between the icon and the capsule's right edge (a Box would pack it
// left against the icon). Purely a signal — `can_target: false` so clicks reach the capsule.
export function ccBadge(): Gtk.Widget {
    const dot = new Gtk.Box({
        css_classes: ["bar-cc-badge"],
        width_request: 6, height_request: 6,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        can_target: false,
    })
    const sync = () => {
        const s = barState()
        dot.set_visible(s !== "hidden")
        if (s === "active") dot.add_css_class("is-active")
        else dot.remove_css_class("is-active")
    }
    subscribeAll(sync)
    sync()
    return dot
}

// ── Control-Center banner ─────────────────────────────────────────────────────
// A card above the CC widgets, one row per non-hidden indicator: dot +
// label/detail + a Stop/Revoke button. The kill switch lives HERE. Hidden (no
// space at all) when nothing is active.
//
// It is a real CC island — a Cairo-painted capsule from SquircleContainer, the
// same material/gloss/border every tile below it is made of — not a CSS card.
// A `@include material-card` box (flat CSS background + 1px CSS border) sitting
// on top of a grid of Cairo glass reads as a foreign element pasted over the
// panel, however close the colours get: it misses the inner specular rim, the
// squircle profile and the shell-opacity tracking (user call 2026-08-02, and the
// same reason the CC's own tiles stopped being CSS boxes long ago).
function buildBannerRow(ind: BarIndicator, s: IndicatorState): Gtk.Widget {
    const dot = new Gtk.Box({
        css_classes: s === "active" ? ["cc-status-dot", "is-active"] : ["cc-status-dot"],
        width_request: 10, height_request: 10, valign: Gtk.Align.CENTER,
    })
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    text.append(new Gtk.Label({ label: ind.label(), halign: Gtk.Align.START, css_classes: ["nidara-row-title"] }))
    text.append(new Gtk.Label({ label: ind.detail(), halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))

    // NidaraButton, `secondary` — NOT Adwaita's `destructive-action`, which is
    // both off-system (raw GTK red: this row is outside the `.cc-detail-panel`
    // scope that restyles Adwaita button classes, so it rendered as pure Adwaita)
    // and wrong: revoking a permission is reversible, and the shell's own rule is
    // that danger means destructive. See nidara-kit/button.ts — page code never
    // uses Adwaita button classes.
    const btn = NidaraButton({ label: t("cc.status.stop"), variant: "secondary", valign: Gtk.Align.CENTER })
    btn.connect("clicked", () => ind.onClick())

    const row = new Gtk.Box({ spacing: 12, css_classes: ["cc-status-row"], valign: Gtk.Align.CENTER })
    row.append(dot)
    row.append(text)
    row.append(btn)
    return row
}

export function ccStatusBanner(): Gtk.Widget {
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })

    // CAPSULE, not a fixed radius: it collapses to a perfect arc on the short
    // side whatever the row count works out to (resolveDrawParams), which is the
    // silhouette the CC's own WIDE and 4×1 tiles have. Padding, border width and
    // inset are BaseIsland's numbers so the glass reads as one family; the size
    // request goes on the CAPSULE (like BaseIsland's set_size_request), never on
    // the inner box — padding is drawn INSIDE the requested width, so requesting
    // GRID_WIDTH on the child would make the card 24px wider than the grid and
    // break the right edge every tile below is aligned to.
    const banner = SquircleContainer({
        child: list,
        shape: Shape.CAPSULE,
        gloss: true,
        useShellOpacity: true,
        borderWidth: 1.5,
        inset: 2.0,
        padding: 12,
        // NOT `.cc-island`, tempting as it is: that class carries
        // `.cc-island button { @include nidara-reset }` to strip Adwaita defaults
        // out of tile content, and `.cc-island button` matches `button.nidara-btn`
        // at EQUAL specificity — with _control-center imported after _components,
        // the reset wins and the Stop button loses its background and border
        // entirely. `.cc-status-banner` carries the transparent background itself.
        css_classes: ["cc-status-banner"],
    })
    banner.set_size_request(GRID_WIDTH, -1)
    banner.halign = Gtk.Align.END      // the grid is END-aligned; share its right edge

    const rebuild = () => {
        let c = list.get_first_child()
        while (c) { const n = c.get_next_sibling(); list.remove(c); c = n }
        let any = false
        for (const ind of INDICATORS) {
            const s = ind.state()
            if (s === "hidden") continue
            any = true
            list.append(buildBannerRow(ind, s))
        }
        // Hide the CAPSULE, not the list: an empty squircle would still paint
        // its glass and hold the block gap open.
        banner.set_visible(any)
    }
    subscribeAll(rebuild)
    rebuild()
    return banner
}
