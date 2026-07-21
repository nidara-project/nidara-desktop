import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import SquircleContainer from "../../common/SquircleContainer"
import { PANEL_W } from "../../common/widget-kit"
import { NidaraButton } from "../../../lib/nidara-kit"
import Icons from "../../core/Icons"
import agentService, { Turn, ToolCall } from "../../core/AgentService"
import shellActions from "../../core/ShellActions"
import status, { ISLAND_AGENT } from "../../core/Status"
import { t } from "../../core/i18n"

// The Activity Island's AGENT mode — the built-in Assistant's face. Both halves:
//
//   - AgentIsland(): the EXPANDED surface (a registered island mode, morphs out
//     of the capsule like the player/overview). Header + a scrolling transcript
//     of user/assistant bubbles with tool chips + a text entry. Empty state when
//     no provider is configured, pointing at Settings → AI.
//   - AgentCompact(): the capsule's COMPACT form while the agent is live — a
//     sparkles glyph + a status word ("Assistant" / "Thinking…" / "Working…").
//     This is the "working pill" the agent shows while a turn runs in the
//     background; clicking it (or Super+A) expands here.
//
// The WHEN (liveness, priority, expand-on-finish) lives in IslandActivities.tsx
// + AgentService; this file only renders. All model/keyring/transport logic is
// in bin/nidara-agent (see core/AgentService.ts).

// Glass recipe for the expanded container — exported for ActivityIsland's
// MorphRevealer (same contract as PLAYER_GLASS / WO_GLASS / BATTERY_GLASS).
export const AGENT_GLASS = { radius: 32, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

// 950 → "950", 5432 → "5.4k", 25310 → "25k". A long conversation must not push
// the header title around.
function compactCount(n: number): string {
    if (n < 1000) return String(n)
    return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

// Total tokens, plus the SHARE served from the provider's cache when there is
// one. The share, not the raw count: what the user wants at a glance is whether
// this conversation is being re-read cheaply — "74% cached" answers that where
// "9812" does not. `cached` is a subset of input, never added on top.
function formatUsage(u: { input: number; output: number; cached: number }): string {
    const label = t("island.agent.tokens").replace("%s", compactCount(u.input + u.output))
    if (u.input <= 0) return label
    // Shown even at 0%, deliberately. Hiding it when there is no cache hides the
    // number exactly when it matters most — "0% cached" means you are paying full
    // price for every token, which is the case worth noticing. Blank would be
    // indistinguishable from the feature not working (user-caught 2026-07-21).
    const pct = Math.round((u.cached / u.input) * 100)
    return `${label} · ${t("island.agent.tokens-cached").replace("%d", String(pct))}`
}

// Compact status word from the service state.
function statusWord(): string {
    if (agentService.state === "acting") return t("island.agent.status.acting")
    if (agentService.state === "thinking") return t("island.agent.status.thinking")
    return t("island.agent.status.idle")
}

// ── Compact form ─────────────────────────────────────────────────────────────
export function AgentCompact(opts: { ghost?: boolean } = {}): Gtk.Widget {
    const glyph = new Gtk.Image({ gicon: Icons.sparkles, pixel_size: 16, css_classes: ["nd-icon", "agent-glyph"], valign: Gtk.Align.CENTER })
    const label = new Gtk.Label({ css_classes: ["agent-compact-label"], valign: Gtk.Align.CENTER, label: statusWord() })
    // Ghost twins carry NO margins (MorphRevealer gotcha — snapshot_child already
    // applies the child's own margin offset). halign CENTER so the pill resizes
    // symmetrically mid-mutation (the compact-page rule in ActivityIsland.tsx).
    const box = opts.ghost
        ? new Gtk.Box({ spacing: 8 })
        : new Gtk.Box({ spacing: 8, margin_start: 16, margin_end: 16, halign: Gtk.Align.CENTER })
    box.append(glyph)
    box.append(label)
    // Both real and ghost track the status word so a dissolving twin matches the
    // capsule mid-morph (a label update is trivial — no timer, unlike the EQ).
    agentService.subscribe(() => { label.label = statusWord() })
    return box
}

// ── Transcript bubbles ───────────────────────────────────────────────────────

function makeToolChip(): { row: Gtk.Widget; update: (tc: ToolCall) => void } {
    const dot = new Gtk.Box({ css_classes: ["agent-tool-dot"], width_request: 6, height_request: 6, valign: Gtk.Align.CENTER })
    const label = new Gtk.Label({ css_classes: ["agent-tool-label"], valign: Gtk.Align.CENTER, ellipsize: 3, max_width_chars: 40, xalign: 0 })
    const row = new Gtk.Box({ css_classes: ["agent-tool-chip"], spacing: 6 })
    row.append(dot)
    row.append(label)
    return {
        row,
        update: (tc) => {
            label.label = tc.summary
            // Semantic, never accent: a shell rejection tints the dot danger.
            if (tc.ok === false) row.add_css_class("agent-tool-fail")
            else row.remove_css_class("agent-tool-fail")
        },
    }
}

interface RenderedTurn {
    // One updater per turn. A turn must paint AT CREATION, not only while it is
    // the streaming (last) one: send() pushes the user turn and an empty
    // assistant turn together, so the user's turn is never "last" and would
    // otherwise render as an empty bubble.
    update: (turn: Turn) => void
}

function makeBubble(turn: Turn): { row: Gtk.Widget; rendered: RenderedTurn } {
    const isUser = turn.role === "user"
    const textLabel = new Gtk.Label({
        css_classes: ["agent-bubble-text"],
        wrap: true,
        xalign: 0,
        halign: Gtk.Align.START,
        selectable: !isUser,
    })
    const toolsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, css_classes: ["agent-tool-chips"] })
    // Abnormal end (provider error, daemon death, empty completion). Its own row,
    // not appended to the text: a turn that streamed half an answer and then died
    // must SHOW that it died.
    //
    // The DOT carries the danger colour and the text stays neutral — the house
    // rule (same as the failed tool chip right above, same as the critical
    // battery glyph). Red text on glass reads badly, which is why the first cut
    // of this was rejected.
    const errorDot = new Gtk.Box({ css_classes: ["agent-error-dot"], width_request: 6, height_request: 6, valign: Gtk.Align.START })
    const errorText = new Gtk.Label({ css_classes: ["agent-error-text"], wrap: true, xalign: 0, halign: Gtk.Align.START })
    const errorLabel = new Gtk.Box({ css_classes: ["agent-error-row"], spacing: 6, visible: false })
    errorLabel.append(errorDot)
    errorLabel.append(errorText)
    const bubble = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        css_classes: ["agent-bubble", isUser ? "agent-bubble-user" : "agent-bubble-assistant"],
    })
    bubble.append(textLabel)
    bubble.append(toolsBox)
    bubble.append(errorLabel)
    // Assistant left, user right — the bubble hugs its content; the row aligns it.
    const row = new Gtk.Box({ halign: isUser ? Gtk.Align.END : Gtk.Align.START })
    row.append(bubble)

    const chips: Array<ReturnType<typeof makeToolChip>> = []
    const update = (tn: Turn) => {
        textLabel.label = tn.text
        textLabel.visible = !!tn.text
        for (let j = chips.length; j < tn.tools.length; j++) {
            const chip = makeToolChip()
            toolsBox.append(chip.row)
            chips.push(chip)
        }
        tn.tools.forEach((tc, j) => chips[j]?.update(tc))
        toolsBox.visible = tn.tools.length > 0
        errorText.label = tn.error ?? ""
        errorLabel.visible = !!tn.error
        // An assistant turn is pushed EMPTY the moment you send; without this it
        // paints as a bare padded pill until the first delta lands. The header's
        // "Thinking…" carries that beat instead.
        row.visible = !!tn.text || tn.tools.length > 0 || !!tn.error
    }
    update(turn)
    return { row, rendered: { update } }
}

// ── Expanded surface ─────────────────────────────────────────────────────────

// The scrollbar's lane. It is the panel's own right padding, NOT a slice taken
// out of the text column: the transcript alone spans into it (every other row
// keeps margin_end: LANE), so the bar rides flush to the glass edge, ~11px clear
// of the bubbles, and its hover growth eats padding instead of text. The panel's
// outer size is unchanged — inner is LANE wider and its right margin is 0.
const LANE = 16

export default function AgentIsland() {
    const svc = agentService

    // Header: title + status + reset.
    const title = new Gtk.Label({ label: t("island.agent.title"), css_classes: ["agent-title"], halign: Gtk.Align.START })
    const statusLabel = new Gtk.Label({ css_classes: ["agent-status"], halign: Gtk.Align.END, valign: Gtk.Align.CENTER })
    const resetBtn = new Gtk.Button({ css_classes: ["agent-reset", "nd-icon-button"], valign: Gtk.Align.CENTER, tooltip_text: t("island.agent.reset") })
    resetBtn.set_child(new Gtk.Image({ gicon: Icons.rotateCcw, pixel_size: 16, css_classes: ["nd-icon"] }))
    resetBtn.connect("clicked", () => svc.reset())
    const header = new Gtk.Box({ css_classes: ["agent-header"], spacing: 8, margin_end: LANE })
    header.append(title)
    header.append(new Gtk.Box({ hexpand: true }))
    header.append(statusLabel)
    header.append(resetBtn)

    // Transcript (configured state).
    const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, css_classes: ["agent-transcript"] })
    const scroller = new Gtk.ScrolledWindow({
        propagate_natural_height: true,
        max_content_height: 300,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        // Overlay scrolling stays ON here (unlike Settings' lists): the bar must not
        // resize the chat when it appears. It rides a RESERVED lane instead — the
        // transcript's own right padding, pinned flush by the scrollbar block in
        // _bar.scss. See design-system.md, "Any ScrolledWindow".
        css_classes: ["agent-scroller"],
        child: listBox,
    })

    // Entry row.
    const entry = new Gtk.Text({ placeholder_text: t("island.agent.placeholder"), css_classes: ["agent-entry"], hexpand: true, valign: Gtk.Align.CENTER })
    const sendBtn = new Gtk.Button({ css_classes: ["agent-send", "nd-icon-button"], valign: Gtk.Align.CENTER })
    sendBtn.set_child(new Gtk.Image({ gicon: Icons.chevronUp, pixel_size: 16, css_classes: ["nd-icon"] }))
    const doSend = () => {
        const text = entry.get_text().trim()
        if (!text || svc.busy) return
        entry.set_text("")
        svc.send(text)
    }
    entry.connect("activate", doSend)
    sendBtn.connect("clicked", doSend)
    const entryBox = new Gtk.Box({ css_classes: ["agent-entry-box"], spacing: 8, margin_end: LANE })
    entryBox.append(entry)
    entryBox.append(sendBtn)

    const chatBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    chatBox.append(scroller)
    chatBox.append(entryBox)

    // Empty state (no provider configured).
    const emptyLabel = new Gtk.Label({ label: t("island.agent.empty"), css_classes: ["agent-empty-text"], wrap: true, xalign: 0, halign: Gtk.Align.START })
    const emptyBtn = NidaraButton({ label: t("island.agent.open-settings"), variant: "primary", pill: true })
    emptyBtn.connect("clicked", () => { shellActions.openSettingsPage?.("ai"); status.island_mode = "" })
    const emptyBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ["agent-empty"], margin_end: LANE })
    emptyBox.append(emptyLabel)
    emptyBox.append(emptyBtn)

    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    body.append(chatBox)
    body.append(emptyBox)

    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12,
        // margin_end 0 + a LANE-wider request: same outer glass as before, but the
        // right padding now lives INSIDE, where the scrollbar can use it.
        margin_top: 14, margin_bottom: 14, margin_start: 16, margin_end: 0,
        width_request: PANEL_W.full + LANE,
        css_classes: ["agent-panel"],
    })
    inner.append(header)
    inner.append(body)

    // ── Incremental render (deltas fire per token — never full rebuild) ──────
    const rendered: RenderedTurn[] = []
    const scrollToBottom = () => {
        const adj = scroller.get_vadjustment()
        if (adj) adj.set_value(Math.max(0, adj.get_upper() - adj.get_page_size()))
    }
    const reconcile = () => {
        const configured = svc.configured()
        chatBox.visible = configured
        emptyBox.visible = !configured
        resetBtn.visible = configured && svc.transcript.length > 0

        // Header status: the working word, else a token count.
        const u = svc.usage
        statusLabel.label = svc.busy
            ? statusWord()
            : (u.input + u.output > 0 ? formatUsage(u) : "")

        if (!configured) return

        const tr = svc.transcript
        for (let i = rendered.length; i < tr.length; i++) {
            const { row, rendered: r } = makeBubble(tr[i])
            listBox.append(row)
            rendered.push(r)
        }
        // Truncate on reset (transcript shrank): drop rendered rows.
        while (rendered.length > tr.length) {
            rendered.pop()
            const last = listBox.get_last_child()
            if (last) listBox.remove(last)
        }
        // Only the last turn mutates after creation (deltas + tool events stream
        // into it); every earlier turn already painted in makeBubble.
        if (tr.length) rendered[tr.length - 1].update(tr[tr.length - 1])
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => { scrollToBottom(); return GLib.SOURCE_REMOVE })
    }
    svc.subscribe(reconcile)
    reconcile()

    // Glass + morph wrapper, same shape as PlayerIsland/BatteryIsland.
    const squircle = SquircleContainer({
        child: inner,
        n: AGENT_GLASS.n,
        radius: AGENT_GLASS.radius,
        useShellOpacity: true,
        gloss: true,
        borderColor: AGENT_GLASS.border,
    })
    const windowContent = new Gtk.Box({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true })
    windowContent.append(squircle)

    // Morph handles (no morphArt — the sparkles compact dissolves via the source
    // twin, it doesn't fly a slot into the panel).
    ;(windowContent as any).morphContent = inner
    ;(windowContent as any).morphGlass = squircle

    // Keyboard-driven mode (needsKeyboard:true in the registration): grab the
    // entry on open (deferred one frame — the bar makes us visible AFTER this,
    // same as Prism). handleKey only claims Escape; everything else falls through
    // to the focused entry so typing works (the bar's CAPTURE controller forwards
    // keys here while island_mode is set).
    ;(windowContent as any).onOpen = () => {
        reconcile()
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (status.island_mode === ISLAND_AGENT && svc.configured()) entry.grab_focus()
            return GLib.SOURCE_REMOVE
        })
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => { scrollToBottom(); return GLib.SOURCE_REMOVE })
    }
    ;(windowContent as any).handleKey = (keyval: number): boolean => {
        if (keyval === Gdk.KEY_Escape) { status.island_mode = ""; return true }
        return false
    }
    return windowContent
}
