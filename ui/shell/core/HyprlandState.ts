import GObject from "gi://GObject"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import { execAsync, exec } from "ags/process"
import { safeDisconnect } from "./signals"

// Tracked IPC event names that require a full state refresh
const TRACKED_EVENTS = [
    "workspace", "workspacev2", "activewindow", "activewindowv2",
    "movewindow", "movewindowv2",
    "openwindow", "closewindow",
    "focusedmon", "fullscreen",
    "changefloatingmode",
    "monitor-added", "monitor-removed",
]

// Minimum ms between refreshes — see _scheduleRefresh (caps the tech-debt #11 storm).
const REFRESH_MIN_INTERVAL_MS = 60

// AstalHyprland reports window addresses with and without the "0x" prefix depending
// on where they came from — always compare bare (same convention as resolveWindow).
export const bareAddr = (s?: string) => (s ?? "").toLowerCase().replace(/^0x/, "")

/** One window's live rect, in Hyprland (logical, monitor-absolute) coordinates. */
export interface ClientGeom { x: number; y: number; width: number; height: number }
/** readGeometry()'s snapshot: BARE address → rect. See readGeometry for why it exists. */
export type ClientGeometry = Map<string, ClientGeom>

class HyprlandStateClass extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraHyprlandState",
            // "changed" = structural window/workspace state (fires often).
            // "config-reloaded" = Hyprland re-read its config (`hyprctl reload` or a
            //   hyprland-user.lua edit). Effective-config consumers (InputConfig,
            //   MonitorConfig) listen to THIS, not "changed", to re-sync from the live
            //   config so they don't clobber external edits on their next write.
            Signals: { "changed": {}, "config-reloaded": {} },
        }, this)
    }

    private readonly hl: AstalHyprland.Hyprland
    private _refreshPending = false
    private _lastRefreshUs = 0
    private _lastSig = ""
    private _geomInFlight: Promise<ClientGeometry> | null = null

    // Hyprland announces "no active window" (`activewindow>>,` + `activewindowv2>>`)
    // when one of OUR OWN layer surfaces RELEASES an EXCLUSIVE keyboard grab — the
    // island's overview and assistant, Prism, the app grid — and then never announces
    // a restore, even though the window is still there and focused. Measured on the
    // event socket 2026-07-26: taking the grab emits nothing at all, releasing it
    // emits the null, and `hyprctl activewindow` reports the real window throughout.
    // The only thing that ever heals it is an unrelated re-emission of activewindow
    // (Hyprland re-sends it when the focused window's TITLE changes), which is why a
    // terminal recovers on its own and a static window stays "unfocused" forever.
    //
    // The blast radius is everything that asks who is focused: the bar's title
    // capsule falls back to the workspace name, the window menu finds no window, the
    // dock loses its focus ring, "screenshot the focused window" has no target.
    //
    // So we keep the last real focus and re-validate it against the live client list.
    // That also states the rule the UI actually wants, instead of merely papering over
    // the event: the workspace name is the fallback for an EMPTY workspace, not for
    // "the compositor went quiet". A remembered window that has been closed, or moved
    // to another workspace, correctly stops being the answer.
    //
    // The compositor's LIVE answer needs the same validation, for the mirror-image
    // failure: while a layer surface holds an EXCLUSIVE grab, Hyprland *refuses* to
    // move window focus at all ("Refusing a keyboard focus to a window because of an
    // exclusive ls"), so switching workspace from the app grid's strip leaves
    // `focused_client` pointing at a window on the workspace you LEFT — no event, no
    // null, just a confident wrong answer. Measured 2026-07-26: on ws4 with the grid
    // open, `hyprctl activewindow` still named the ws1 terminal while ws4's own
    // `lastwindow` correctly named the browser. Hence the invariant below, which both
    // halves now share: THE FOCUSED WINDOW IS ALWAYS ON THE FOCUSED WORKSPACE.
    private _lastFocusedAddr = ""
    private _focusFallback: AstalHyprland.Client | null = null

    // Cached raw arrays — one refresh per signal batch, shared by all consumers
    clients:    AstalHyprland.Client[]    = []
    workspaces: AstalHyprland.Workspace[] = []
    monitors:   AstalHyprland.Monitor[]   = []

    // AstalHyprland.Monitor.available_modes is always null, so the mode list is read
    // from `hyprctl monitors -j` and cached here (refreshed only on monitor add/remove,
    // not on every event). Consumers (Display settings) read it instead of re-shelling.
    availableModesByName = new Map<string, string[]>()

    // Pre-computed derived state — rebuilt on every refresh
    clientsByWorkspace = new Map<number, AstalHyprland.Client[]>()
    occupiedWorkspaces = new Set<number>()
    specialWorkspaces:  AstalHyprland.Workspace[] = []
    submap = ""

    // Synced synchronously from the IPC event data so it's always up-to-date
    // even before AstalHyprland has settled its own property updates.
    focusedWorkspaceId = 0

    // Direct proxies — no caching needed, these are lightweight GObject accessors
    get focusedWorkspace() { return this.hl.focused_workspace }
    get focusedMonitor()   { return this.hl.focused_monitor }

    /** The focused window — held steady across Hyprland's spurious "no active
     *  window", and never a window from the workspace you just left. Falls back to
     *  `_focusFallback` (see it) whenever the compositor's own answer fails the
     *  invariant, so consumers only ever see null when there is genuinely nothing
     *  focused on the focused workspace. */
    get focusedClient(): AstalHyprland.Client | null {
        const raw = this.hl.focused_client as AstalHyprland.Client | null
        return this._focusIsHere(raw) ? raw : this._focusFallback
    }

    /** Is the compositor's answer about the workspace the user is looking AT?
     *  Special (scratchpad) workspaces overlay the active one and are announced on
     *  `activespecial`, never on `workspace`, so `focusedWorkspaceId` keeps naming
     *  the normal workspace underneath — a window on a special one (negative id)
     *  therefore counts as here, or focusing the scratchpad would blank the title. */
    private _focusIsHere(c: AstalHyprland.Client | null): boolean {
        const id = (c as any)?.workspace?.id
        return typeof id === "number" && (id === this.focusedWorkspaceId || id < 0)
    }

    /** True ONLY for real fullscreen (Hyprland FSMODE 2), not "maximized" (FSMODE 1)
     *  or none. AstalHyprland exposes Client.fullscreen as the Fullscreen ENUM, not a
     *  boolean — a plain `!!client.fullscreen` is truthy for MAXIMIZED too, which is
     *  why maximize used to hide the bar/dock. Chrome-hiding (bar opacity, dock
     *  auto-hide) keys off THIS; maximize deliberately keeps all chrome visible and
     *  clickable (fill-the-workspace, like the Windows/GNOME maximize convention). */
    isRealFullscreen(client: AstalHyprland.Client | null | undefined): boolean {
        return !!client && client.fullscreen === AstalHyprland.Fullscreen.FULLSCREEN
    }

    constructor() {
        super()
        this.hl = AstalHyprland.get_default()

        const refresh = () => this._scheduleRefresh()
        const onMonitors = () => { this._refreshModes(); refresh() }
        // Avoid notify::clients and notify::focused-* — AstalHyprland re-emits them
        // whenever it rebuilds its internal state (e.g. on windowtitle events from Chrome/
        // YouTube), even when the logical state hasn't changed. TRACKED_EVENTS IPC signals
        // cover all structural changes: focus (activewindow), workspace (workspace),
        // open/close (openwindow/closewindow), move (movewindow), monitor (focusedmon).
        this.hl.connect("monitor-added",   onMonitors)
        this.hl.connect("monitor-removed", onMonitors)
        this.hl.connect("event", (_h: any, name: string, data: string) => {
            if (name === "submap") {
                this.submap = data || ""
                this._scheduleRefresh()
                return
            }
            // Hyprland re-read its config (`hyprctl reload`, or a hyprland-user.lua
            // edit). Refresh the modes cache (a monitor's modes can change) and let
            // effective-config consumers re-sync via "config-reloaded".
            if (name === "configreloaded") {
                this._refreshModes()
                this.emit("config-reloaded")
                return
            }
            // Sync workspace ID from IPC data directly — before idle_add fires —
            // so hs.focusedWorkspaceId is always current when "changed" is emitted.
            if (name === "workspace") {
                const id = parseInt(data)
                if (!isNaN(id)) this.focusedWorkspaceId = id
            } else if (name === "workspacev2") {
                // format: "ID,name"
                const id = parseInt(data.split(",")[0])
                if (!isNaN(id)) this.focusedWorkspaceId = id
            }
            if (TRACKED_EVENTS.includes(name)) refresh()
        })

        this._refresh()
        this._refreshModes()
    }

    // Cache available modes per monitor from hyprctl (one sync read; modes only
    // change when a monitor is added/removed). Returns [] if unknown.
    private _refreshModes() {
        try {
            const arr = JSON.parse(exec(["hyprctl", "monitors", "-j"]))
            this.availableModesByName.clear()
            for (const m of arr) this.availableModesByName.set(m.name, m.availableModes ?? [])
        } catch (e) { console.error("[HyprlandState] modes refresh failed:", e) }
    }

    getAvailableModes(name: string): string[] {
        return this.availableModesByName.get(name) ?? []
    }

    /** Read an effective Hyprland option's int value via `hyprctl getoption` (works
     *  with the Lua parser, unlike `keyword`). On-demand read — the first of the
     *  "effective config in HyprlandState" idea (gaps etc. could follow the same way). */
    getOptionInt(name: string): number {
        try {
            const opt = JSON.parse(exec(["hyprctl", "getoption", name, "-j"]))
            if (typeof opt.int === "number") return opt.int
            // css_gap-typed options (gaps_in/gaps_out) carry no .int — they
            // report `css: "4 4 4 4"` (top right bottom left). Use the first.
            if (typeof opt.css === "string") return parseInt(opt.css, 10) || 0
            return 0
        }
        catch (e) { console.error("[HyprlandState] getOptionInt", name, e); return 0 }
    }

    /** Async read of an effective option: resolves the parsed `getoption -j` JSON
     *  ({int, float, str, set…}) or null on failure. Use for batch re-syncs
     *  (InputConfig); prefer getOptionInt for one-off sync reads. */
    async getOptionJson(name: string): Promise<any | null> {
        try { return JSON.parse(await execAsync(["hyprctl", "getoption", "-j", name])) }
        catch (e) { console.error("[HyprlandState] getOptionJson", name, e); return null }
    }

    /** Top edge (screen y) of one of OUR layer surfaces, by namespace — or null if
     *  it is not mapped on that monitor.
     *
     *  Exists so the Activity Island can FOLLOW the bar instead of guessing where
     *  it is. The two surfaces answer to different rules on purpose: the bar asks
     *  for `exclusive_zone = 40` (it reserves space, and a surface with zone >= 0
     *  also RESPECTS everyone else's reservations), while the island asks for `-1`
     *  so nothing displaces it — if it respected reservations, the first one it
     *  would respect is the bar's own 40px and the capsule would leave the bar row.
     *  Both choices are right alone and wrong together: let anything reserve space
     *  ABOVE the bar — Hyprland's own config-error bar is the case in the wild —
     *  and the bar slides down while the island stays, so the capsule floats above
     *  the row it belongs to. Reproduced 2026-08-02 with a 60px reserving layer
     *  created before the shell: `nidara-bar` at `0 60`, `nidara-island` at `0 0`.
     *
     *  Reading the bar's real position beats computing it from `reserved`: it is
     *  exact whatever did the pushing, and it needs no model of who reserves what.
     *  Setting the island to zone 0 is NOT the fix — it would respect the full
     *  100px and land 40px below the bar instead of 60px above it.
     *
     *  `monitor` is the connector (DP-1): the error bar reserves on the FOCUSED
     *  monitor only, so on a multi-head setup one bar moves and the others do not.
     *  Without it the first surface found answers for all of them. The y is in
     *  GLOBAL layout coordinates — subtract the monitor's own origin to get the
     *  offset from its top edge.
     *
     *  There is no event for this. A layer surface only hears from the compositor
     *  when its SIZE changes, and the bar's does not: it is anchored top/left/right
     *  with no bottom anchor, so its height is client-chosen and a pure vertical
     *  move is invisible client-side. Polling is the only instrument — which is why
     *  callers should poll only while displaced (see Bar.tsx). */
    async layerTop(namespace: string, monitor?: string): Promise<number | null> {
        try {
            const byMonitor = JSON.parse(await execAsync(["hyprctl", "layers", "-j"]))
            for (const [name, mon] of Object.entries<any>(byMonitor)) {
                if (monitor && name !== monitor) continue
                for (const level of Object.values<any>(mon?.levels ?? {}))
                    for (const l of level as any[])
                        if (l?.namespace === namespace) return l.y ?? 0
            }
        } catch (e) { console.error("[HyprlandState] layerTop", namespace, e) }
        return null
    }

    /** Run a Lua-parser eval — the ONLY way to change Hyprland config live (the Lua
     *  parser rejects `hyprctl keyword`). Failures are logged with the offending call. */
    evalLua(luaCall: string) {
        return execAsync(["hyprctl", "eval", luaCall])
            .catch(e => console.error("[HyprlandState] evalLua:", luaCall, e))
    }

    /** Set the compositor cursor theme + size (`hyprctl setcursor`). */
    setCursor(theme: string, size: number) {
        return execAsync(["hyprctl", "setcursor", theme, String(size)]).catch(() => {})
    }

    /** Show/hide the REAL pointer (`cursor:invisible`). Rendering only — input is
     *  unaffected, so hover and clicks still land while it is hidden.
     *
     *  The only caller is the agent-pointer overlay, and the reason is physical:
     *  the hardware cursor plane paints above every layer surface, so the fake AI
     *  cursor cannot be drawn on top of the real one — the real one has to go away
     *  for the length of an AI action. **Whoever hides it owns restoring it on
     *  every exit path**, including crashes; see `surfaces/agent-pointer/`. */
    setRealCursorVisible(visible: boolean) {
        return this.evalLua(`hl.config({ cursor = { invisible = ${visible ? "false" : "true"} } })`)
    }

    /** Turn the inner glow on/off (`decoration:glow:enabled`). Everything else
     *  about the glow — range, colors, and the transparent `color_inactive` that
     *  limits it to the FOCUSED window — is set once in hyprland.lua; this is the
     *  only knob anyone flips at runtime. Driven by core/AgentGlow.ts. */
    setGlow(enabled: boolean) {
        return this.evalLua(`hl.config({ decoration = { glow = { enabled = ${enabled} } } })`)
    }

    /** Does this Hyprland have the inner glow (0.56+)? `getoption` answers an
     *  unknown option with the bare string "no such option", not JSON, so the
     *  parse failing IS the answer — no version arithmetic needed, and a future
     *  rename degrades to "feature off" instead of to a stream of eval errors. */
    async supportsGlow(): Promise<boolean> {
        const o = await this.getOptionJson("decoration:glow:enabled")
        return typeof o?.bool === "boolean"
    }

    /** Hyprland version, e.g. "0.55.2" ("" on failure). */
    async version(): Promise<string> {
        try {
            const out = await execAsync(["hyprctl", "version"])
            const m = out.match(/Hyprland\s+v?([\d][\w.-]*)/)
            return m ? m[1] : out.split("\n")[0].trim()
        } catch { return "" }
    }

    // Coalesces multiple signals that fire in the same GLib iteration into one
    // refresh, AND throttles to a minimum interval. AstalHyprland re-emits "event"
    // spuriously while _refresh reads get_clients()/get_monitors(), which on some
    // instances forms a SELF-SUSTAINING storm: event → refresh → _refresh → (re-emit)
    // → event → … driving _refresh (and thus "changed" → bar+dock repaint) at
    // monitor-refresh rate (tech-debt #11). Real Hyprland events are sparse, so a
    // small floor is imperceptible but caps that loop. Throttling _refresh throttles
    // the whole loop (the re-emit only fires when _refresh runs).
    private _scheduleRefresh() {
        if (this._refreshPending) return
        this._refreshPending = true
        const sinceMs = (GLib.get_monotonic_time() - this._lastRefreshUs) / 1000
        const wait = Math.max(0, REFRESH_MIN_INTERVAL_MS - sinceMs)
        const run = () => {
            this._refreshPending = false
            this._lastRefreshUs = GLib.get_monotonic_time()
            this._refresh()
            return GLib.SOURCE_REMOVE
        }
        if (wait <= 0) GLib.idle_add(GLib.PRIORITY_DEFAULT, run)
        else GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), run)
    }

    private _refresh() {
        try {
            this.clients    = this.hl.get_clients()    || []
            this.workspaces = this.hl.get_workspaces() || []
            this.monitors   = this.hl.get_monitors()   || []

            // Keep focusedWorkspaceId in sync with AstalHyprland's view
            // (handles named workspaces and the initial state before any IPC fires).
            const fwId = this.hl.focused_workspace?.id
            if (fwId != null) this.focusedWorkspaceId = fwId

            this.clientsByWorkspace.clear()
            this.occupiedWorkspaces.clear()
            this.specialWorkspaces = []

            for (const ws of this.workspaces) {
                if (!ws) continue
                const name: string = (ws as any).name || ""
                if (name.startsWith("special:")) {
                    this.specialWorkspaces.push(ws)
                } else {
                    this.occupiedWorkspaces.add(ws.id)
                }
            }

            for (const c of this.clients) {
                if (!c?.workspace?.id) continue
                const wsId = c.workspace.id
                if (!this.clientsByWorkspace.has(wsId))
                    this.clientsByWorkspace.set(wsId, [])
                this.clientsByWorkspace.get(wsId)!.push(c)
            }

            // Reconcile focus BEFORE the signature: a grab release that only silenced
            // the compositor must not read as a structural change, or every consumer
            // repaints to say the same thing.
            const raw = this.hl.focused_client as AstalHyprland.Client | null
            // Trust the compositor's answer only while it is ON the focused workspace:
            // under an EXCLUSIVE grab it keeps naming the window you left behind.
            const live = this._focusIsHere(raw) ? raw : null
            if (live) {
                this._lastFocusedAddr = bareAddr((live as any).address)
                this._focusFallback = null
            } else {
                // Still open, and still on the workspace we're looking at? Then the
                // null is the compositor going quiet, not a window losing focus.
                const remembered = this._lastFocusedAddr
                    ? this.clients.find(c =>
                        bareAddr((c as any).address) === this._lastFocusedAddr
                        && c?.workspace?.id === this.focusedWorkspaceId) ?? null
                    : null
                // Otherwise ask the workspace itself which window it would focus.
                // `last_client` is Hyprland's own `lastwindow`, so this is still the
                // compositor's answer, not an invention — and it stays correct while
                // a grab blocks the focus from actually moving. Re-validated against
                // the live client list because it can name a window that has closed.
                this._focusFallback = remembered ?? this._workspaceLastClient()
            }

            // Only notify when the STRUCTURAL state actually changed. AstalHyprland
            // re-emits "event" spuriously (and a focused window's title can churn fast,
            // e.g. a terminal spinner) — without this guard every such no-op refresh
            // would emit "changed" → repaint the bar + dock (tech-debt #11).
            const sig = this._stateSignature()
            if (sig !== this._lastSig) {
                this._lastSig = sig
                this.emit("changed")
            }
        } catch (e) {
            console.error("[HyprlandState] refresh failed:", e)
        }
    }

    /** The window the FOCUSED workspace would give focus to — Hyprland's own
     *  `lastwindow`, re-validated against the live client list (it can name a window
     *  that has since closed, and it is stale by definition on a workspace that has
     *  never been visited). Empty workspace → null, which is what makes the bar fall
     *  back to the workspace name. No hyprctl: `Workspace.last_client` is already in
     *  the cached array, so this stays inside the "_refresh never shells out" rule. */
    private _workspaceLastClient(): AstalHyprland.Client | null {
        const ws = this.workspaces.find(w => (w as any)?.id === this.focusedWorkspaceId)
        const addr = bareAddr(((ws as any)?.last_client as any)?.address)
        if (!addr) return null
        return this.clients.find(c =>
            bareAddr((c as any).address) === addr
            && c?.workspace?.id === this.focusedWorkspaceId) ?? null
    }

    // Cheap structural fingerprint of the state "changed" consumers react to (window
    // geometry/class/workspace + focus + the workspace list). DELIBERATELY excludes
    // window titles — AppTitle tracks those via its own notify::title — so a
    // fast-updating title doesn't churn "changed".
    private _stateSignature(): string {
        // The RECONCILED focus, not hl.focused_client: a spurious null is not a change.
        let s = `${this.focusedWorkspaceId}|${(this.focusedClient as any)?.address ?? ""}`
        for (const c of this.clients as any[]) {
            if (!c) continue
            s += `;${c.address},${c.class},${c.x},${c.y},${c.width},${c.height},${c.workspace?.id ?? ""}`
        }
        s += "#"
        for (const ws of this.workspaces as any[]) {
            if (!ws) continue
            s += `${ws.id}:${ws.name},`
        }
        return s
    }

    // ── Dispatch API ─────────────────────────────────────────────────────────
    // Single source of truth for all hyprctl dispatch strings.
    // RULE: HyprlandState is the ONLY door to hyprctl — services and widgets
    // never shell out to hyprctl directly; they call (or add) a method here.
    // (Exempt: config text we WRITE for other daemons to run, e.g. the
    // hypridle config in Power.tsx — those execute outside the shell.)
    // RULE: dispatch strings are hl.dsp.* Lua ONLY — the classic syntax
    // (`togglefloating addr`, `movetoworkspace N,addr`…) is a Lua error that
    // .catch swallows, so it fails silently (four methods shipped broken that
    // way until 2026-06-11).

    private _dispatch(call: string) {
        return execAsync(["hyprctl", "dispatch", call])
            .catch(e => console.error("[HyprlandState] dispatch:", call, e))
    }

    // `{ window = 'address:0x..' }` selector — verified on float/pin/move/close.
    private _winSel(address: string): string {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return `window = 'address:${addr}'`
    }

    /** Make Hyprland re-read its config. NOT a dispatch — `reload` is a top-level
     *  hyprctl command, so it deliberately bypasses `_dispatch` (whose contract is
     *  hl.dsp.* Lua) rather than being wrapped into one.
     *
     *  Exists because a config edit had no way to be APPLIED from here: the shell
     *  listens for `configreloaded` and re-syncs on it, but nothing could provoke
     *  it. That left the assistant able to write a keybind into hyprland-user.lua
     *  and unable to either activate or verify it — a read → act → verify loop with
     *  the last step missing.
     *
     *  Safe to call spuriously: a reload re-runs the same config, and the shell's
     *  own `config-reloaded` handler already refreshes the modes cache and
     *  effective-config consumers, which is exactly what should happen. */
    reloadConfig() {
        return execAsync(["hyprctl", "reload"])
            .catch(e => console.error("[HyprlandState] reload:", e))
    }

    focusWorkspace(id: number) {
        return this._dispatch(`hl.dsp.focus({ workspace = ${id} })`)
    }

    /**
     * Switch workspace from one of OUR surfaces. The single entry point for it, so
     * the app grid and the island's workspace overview cannot drift apart — and the
     * reason it still exists even though it now just forwards.
     *
     * It used to have to lend the caller's keyboard grab away first, because Hyprland
     * REFUSES to move window focus while a layer surface holds EXCLUSIVE
     * (`m_exclusiveLSes`, the rule `core/InputYield` exists for): switching first
     * landed you on a workspace with NOTHING focused, and when the surface later
     * dropped the grab, `refocusLastWindow` answered with the window you came from
     * and dragged that workspace back over you. Measured 2026-08-05 closing the app
     * grid from the dock button: `5 → 1 @425ms → 5 @454ms` — a 29 ms round trip that
     * read as the workspace animation setting off and changing its mind.
     *
     * 🔑 A compositor focus grab does not refuse focus moves, which is the whole
     * reason `common/FocusGrab.ts` replaced EXCLUSIVE, so there is nothing left to
     * hand over: the switch focuses the target's own window and the later release has
     * nothing to drag. Keep going through here anyway — if a shell surface ever needs
     * to do something before a switch again, this is where it belongs.
     */
    focusWorkspaceFromShell(id: number) {
        return this.focusWorkspace(id)
    }

    /** Hand the keyboard back to the window the user was working in, after one of our
     *  surfaces let go of a compositor focus grab.
     *
     *  WHY IT IS NEEDED. Dropping the grab makes Hyprland refocus by POINTER
     *  (`CSeatManager::setGrab(nullptr)` → `input:follow_mouse` = 1 → `refocus()`), so
     *  where the mouse happens to rest decides who gets the keyboard. Measured
     *  2026-08-05: dismiss a panel onto a window and that window is focused; dismiss it
     *  with the pointer over the wallpaper — by clicking there OR by pressing Esc while
     *  the pointer merely sits there — and the session is left with NO active window at
     *  all. A plain desktop click with nothing open does not do that, so it is specific
     *  to dropping a grab. Working from the keyboard, that means every dismissal
     *  silently costs you the window you were typing in.
     *
     *  ⚠️ ONLY when the compositor was left with nothing focused. Refocusing over the
     *  top of a window the user just clicked would be worse than the bug.
     *
     *  ⚠️ ONLY on the workspace the user is looking at — `focusedClient` guarantees
     *  this (see it: it never answers with a window from the workspace you just left).
     *  Focusing a window that lives elsewhere DRAGS THE WORKSPACE ALONG, so dismissing
     *  a panel on an empty workspace would teleport the user off it. Nothing to focus
     *  here means we leave it alone — an empty workspace is allowed to be empty.
     *
     *  Timed off the compositor's own announcement rather than a delay, because asking
     *  for the release is not performing it — see `afterGrabRelease`. */
    restoreFocusAfterGrab() {
        this.afterGrabRelease(() => {
            if (this.hl.focused_client) return   // the compositor found someone: leave it
            const addr = (this.focusedClient as any)?.address
            if (addr) this.focusWindow(addr)
        })
    }

    /** Run `cb` once the compositor has ANNOUNCED that a shell surface gave up the
     *  input it was holding. Any caller that has just asked a surface to let go and
     *  must not act until the compositor has actually applied it goes through here:
     *  `restoreFocusAfterGrab` above, and the input yield that lets computer-use
     *  reach a real window (`core/InputYield`).
     *
     *  Asking for a release is not performing it. This was measured on the
     *  double-buffered layer-shell path, where the compositor only applies the change
     *  on the surface's next commit — on the event socket against the shell's log
     *  (2026-07-26), a spawned `hyprctl` beat our own Wayland state by ~4 ms and
     *  reordering the two calls could not help (tried, measured, 12/21 still failed).
     *  A focus-grab release is NOT double-buffered, so that particular race is gone;
     *  what remains is that `refocus()` still happens on the compositor's clock, not
     *  ours, which is what the callers above are waiting for.
     *
     *  The 80 ms fallback covers "no announcement is coming" — with nothing focused
     *  to lose, the release passes in silence. Not a tuning knob: the measured window
     *  is 12-15 ms, this is 5× that, and firing early is merely the old behaviour. */
    afterGrabRelease(cb: () => void) {
        let done = false
        let handler = 0
        let timer = 0
        const go = () => {
            if (done) return
            done = true
            safeDisconnect(this.hl, handler)
            if (timer) { GLib.source_remove(timer); timer = 0 }
            cb()
        }
        handler = this.hl.connect("event", (_h: any, name: string) => {
            if (name === "activewindow") go()
        })
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { timer = 0; go(); return GLib.SOURCE_REMOVE })
    }

    /** Switch workspace by a Hyprland workspace STRING — relative ("e+1"/"e-1",
     *  the cycle-incl-empty form the mouse-wheel binds use), "previous", "name:x",
     *  etc. Quoted, unlike the numeric focusWorkspace. Same unified focus dispatcher. */
    focusWorkspaceArg(arg: string) {
        return this._dispatch(`hl.dsp.focus({ workspace = '${arg}' })`)
    }

    /** Move focus in a direction — `hl.dsp.focus({ direction })`, the same unified
     *  focus dispatcher as focusWorkspace/focusWindow (verified live via the
     *  arrow-key binds in hyprland.lua). Benign: it only moves focus. */
    focusDirection(dir: "left" | "right" | "up" | "down") {
        return this._dispatch(`hl.dsp.focus({ direction = '${dir}' })`)
    }

    focusWindow(address: string) {
        return this._dispatch(`hl.dsp.focus({ ${this._winSel(address)} })`)
    }

    closeWindow(address: string) {
        return this._dispatch(`hl.dsp.window.close({ ${this._winSel(address)} })`)
    }

    sendToWorkspace(address: string, wsId: number) {
        return this._dispatch(`hl.dsp.window.move({ workspace = ${wsId}, ${this._winSel(address)} })`)
    }

    floatWindow(address: string) {
        return this._dispatch(`hl.dsp.window.float({ action = 'toggle', ${this._winSel(address)} })`)
    }

    /** Pseudo-tile toggle. NOTE: pseudo state is NOT readable (`hyprctl clients -j`
     *  has no `pseudo` field, nor does HL.Window) — callers can't show a check. */
    togglePseudo(address: string) {
        return this._dispatch(`hl.dsp.window.pseudo({ ${this._winSel(address)} })`)
    }

    /** Pin = visible on every workspace (floating windows only). */
    togglePin(address: string) {
        return this._dispatch(`hl.dsp.window.pin({ ${this._winSel(address)} })`)
    }

    toggleFullscreen(address: string) {
        return this._dispatch(`hl.dsp.window.fullscreen({ ${this._winSel(address)} })`)
    }

    /** Center on screen (floating windows only). */
    centerWindow(address: string) {
        return this._dispatch(`hl.dsp.window.center({ ${this._winSel(address)} })`)
    }

    async floatAllInWorkspace(wsId: number) {
        // Window state comes from hyprctl, NOT AstalHyprland.Client.floating —
        // that prop goes stale (a tiled window can read floating=true), which
        // made this skip windows and the menu draw wrong checks (2026-06-11).
        const arr = await this.getClientsJson()
        for (const c of arr) {
            if (c.workspace?.id === wsId && !c.floating) await this.floatWindow(c.address)
        }
    }

    // Group vocabulary — verified live 2026-06-11: `group.toggle` accepts the
    // window selector (creates a lone group / dissolves the whole group);
    // `window.move({ out_of_group })` pulls ONE window out and also honors the
    // selector. `into_group` does NOT take a selector (acts on the focused
    // window only) and tab switching is just `focusWindow` on a member address.
    toggleGroup(address?: string) {
        return this._dispatch(address
            ? `hl.dsp.group.toggle({ ${this._winSel(address)} })`
            : `hl.dsp.group.toggle()`)
    }

    moveOutOfGroup(address: string) {
        return this._dispatch(`hl.dsp.window.move({ out_of_group = true, ${this._winSel(address)} })`)
    }

    /** Send a window to a special (scratchpad) workspace. With no address it
     *  moves the FOCUSED window (the classic keybind behaviour); pass an address
     *  to target a specific window (the agent/IPC path needs determinism). */
    sendToSpecial(name = "magic", address?: string) {
        const sel = address ? `, ${this._winSel(address)}` : ""
        return this._dispatch(`hl.dsp.window.move({ workspace = 'special:${name}'${sel} })`)
    }

    /** One-shot raw read of ALL clients from hyprctl. This is the authoritative
     *  window state: AstalHyprland.Client props (floating, fullscreen) go stale,
     *  and pinned/grouped aren't exposed at all. Called on demand (menu open,
     *  bulk ops) — deliberately NOT part of _refresh, which runs on every IPC
     *  event. Returns [] on failure. */
    async getClientsJson(): Promise<any[]> {
        try { return JSON.parse(await execAsync(["hyprctl", "clients", "-j"])) }
        catch (e) { console.error("[HyprlandState] getClientsJson:", e); return [] }
    }

    /** getClientsJson narrowed to one window (null if gone). */
    async getClientJson(address: string): Promise<any | null> {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return (await this.getClientsJson()).find((c: any) => c.address === addr) ?? null
    }

    /** Window position and size as of NOW, keyed by BARE address.
     *
     *  This is the one part of the window state that no amount of listening can
     *  keep current: **Hyprland's IPC has no resize event, and none for a move
     *  within a workspace either** (checked against the whole event list, 0.56 —
     *  `movewindow` is a workspace change, not a geometric one). So `clients`
     *  carries whatever x/y/width/height it happened to read at the last event
     *  that DID re-sync the list — a title change, a window opening, a float
     *  toggle — and after a plain resize it is simply wrong, with nothing to
     *  subscribe to that would say so. `closewindow` compounds it: AstalHyprland
     *  removes the one client and never re-reads, so every survivor of a close in
     *  a tiled workspace keeps the size it had while the closed window was still
     *  taking up room.
     *
     *  A surface that DRAWS window geometry therefore has to ask for it at the
     *  moment it draws — `clients` stays the right source for identity (class,
     *  initialTitle) and workspace, which do arrive by event. Coalesced: the
     *  overview asks once for all its workspaces, and callers landing in the same
     *  tick share one hyprctl. Empty map on failure (callers fall back to the
     *  cached geometry, which is the best that is left). */
    async readGeometry(): Promise<ClientGeometry> {
        if (this._geomInFlight) return this._geomInFlight
        const p = this.getClientsJson().then(list => {
            if (this._geomInFlight === p) this._geomInFlight = null
            const map: ClientGeometry = new Map()
            for (const c of list) {
                const at = c?.at, size = c?.size
                if (!Array.isArray(at) || !Array.isArray(size)) continue
                map.set(bareAddr(c.address), { x: at[0], y: at[1], width: size[0], height: size[1] })
            }
            return map
        })
        this._geomInFlight = p
        return p
    }

    /** One-shot raw read of ALL workspaces from hyprctl (authoritative: carries the
     *  window count, monitor and fullscreen flag the cached AstalHyprland objects
     *  don't reliably expose). On-demand only — not part of _refresh. [] on failure. */
    async getWorkspacesJson(): Promise<any[]> {
        try { return JSON.parse(await execAsync(["hyprctl", "workspaces", "-j"])) }
        catch (e) { console.error("[HyprlandState] getWorkspacesJson:", e); return [] }
    }

    setLayout(layout: "dwindle" | "master") {
        return this.evalLua(`hl.config({ general = { layout = '${layout}' } })`)
    }
}

const hs = new HyprlandStateClass()
export default hs
