import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { execAsync, exec } from "../../lib/process"
import { safeDisconnect } from "./signals"
import * as Hypr from "./hypr-ipc"
import type { HyprClient, HyprWorkspace, HyprMonitor } from "./hypr-ipc"

// Re-exported so consumers annotate against the shell's own vocabulary rather
// than reaching into the IPC module (same rule as every other core/ facade).
export type { HyprClient, HyprWorkspace, HyprMonitor } from "./hypr-ipc"

// Tracked IPC event names that require a full state refresh
const TRACKED_EVENTS = [
    "workspace", "workspacev2", "activewindow", "activewindowv2",
    "movewindow", "movewindowv2",
    "openwindow", "closewindow",
    "focusedmon", "fullscreen",
    "changefloatingmode",
    // Hyprland's own names. "monitor-added"/"monitor-removed" used to sit here and
    // matched NOTHING: those were AstalHyprland's GObject signal names, and monitor
    // changes actually arrived through a separate `hl.connect("monitor-added")`.
    // On the wire they are one word.
    "monitoradded", "monitorremoved", "monitoraddedv2",
]

// Minimum ms between refreshes — see _scheduleRefresh (caps the tech-debt #11 storm).
const REFRESH_MIN_INTERVAL_MS = 60

// Window addresses reach us both with and without the "0x" prefix depending on
// where they came from (the IPC layer strips it, Hyprland's own event data and
// `hyprctl -j` do not) — always compare bare, same convention as resolveWindow.
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
            // "title-changed" = the focused window RENAMED itself and nothing else.
            //   Deliberately separate from "changed", which repaints bar + dock: a
            //   terminal spinner or a YouTube tab renames itself constantly.
            Signals: {
                "changed": {},
                "config-reloaded": {},
                "title-changed": { param_types: [GObject.TYPE_STRING] },
            },
        }, this)
    }

    private _refreshPending = false
    private _lastRefreshUs = 0
    private _lastSig = ""
    private _geomInFlight: Promise<ClientGeometry> | null = null

    // ⚠️ BOTH HALVES OUTLIVED THE CAUSES BELOW — read to the end before simplifying.
    // The two failures described here were EXCLUSIVE-era, and no shell surface asks
    // for EXCLUSIVE any more (2026-08-06, `common/FocusGrab.ts`). What keeps the
    // invariant load-bearing today is stated after them, and it is not a workaround.
    //
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
    //
    // 🔑 WHY IT ALL STAYS, now that neither cause exists. The invariant stopped being
    // a display patch and became the INPUT to the root fix:
    //  · The remembered window is what `restoreFocusAfterGrab` hands the keyboard back
    //    TO. Dropping a focus grab makes Hyprland refocus by POINTER, so a dismissal
    //    with the cursor over the wallpaper still leaves the session with nothing
    //    focused (measured 2026-08-05) — a different cause, same null, and without a
    //    memory of who was focused there is nobody to restore.
    //  · Validating the LIVE answer is that repair's correctness guard, not a
    //    workaround for a lying compositor: focusing a window that lives on another
    //    workspace DRAGS THAT WORKSPACE over the user. `restoreFocusAfterGrab` relies
    //    on this accessor never handing it one (see its own ⚠️).
    private _lastFocusedAddr = ""
    private _focusFallback: HyprClient | null = null

    // Cached raw arrays — one refresh per signal batch, shared by all consumers
    clients:    HyprClient[]    = []
    workspaces: HyprWorkspace[] = []
    monitors:   HyprMonitor[]   = []

    // Mode lists come with `monitors` now and need no cache of their own — the
    // map and its `hyprctl monitors -j` refresh existed only because
    // AstalHyprland.Monitor.available_modes was always null. Kept as a method
    // (getAvailableModes) so Display settings did not have to change.

    // Pre-computed derived state — rebuilt on every refresh
    clientsByWorkspace = new Map<number, HyprClient[]>()
    occupiedWorkspaces = new Set<number>()
    specialWorkspaces:  HyprWorkspace[] = []
    submap = ""

    // Synced synchronously from the IPC event data so it's always up-to-date
    // even before the refresh that event triggers has run.
    focusedWorkspaceId = 0

    // The compositor's raw answer to "who is focused", refreshed with the rest of
    // the state. `focusedClient` reconciles it; nothing else should read it.
    private _activeAddr: string | null = null

    // One socket, many listeners. AstalHyprland let callers connect their own
    // handler to its "event" signal; a raw socket has one reader, so the reader
    // fans out to these instead. Used by one-shot waiters (afterGrabRelease).
    private _eventHooks = new Set<(name: string, data: string) => void>()

    /** Derived from the cached arrays — Hyprland marks the focused monitor itself,
     *  and the focused workspace is the one `focusedWorkspaceId` names. */
    get focusedWorkspace(): HyprWorkspace | null {
        return this.workspaces.find(w => w.id === this.focusedWorkspaceId) ?? null
    }
    get focusedMonitor(): HyprMonitor | null {
        return this.monitors.find(m => m.focused) ?? null
    }

    /** The focused window — held steady across Hyprland's spurious "no active
     *  window", and never a window from the workspace you just left. Falls back to
     *  `_focusFallback` (see it) whenever the compositor's own answer fails the
     *  invariant, so consumers only ever see null when there is genuinely nothing
     *  focused on the focused workspace. */
    get focusedClient(): HyprClient | null {
        const raw = this._activeClient()
        return this._focusIsHere(raw) ? raw : this._focusFallback
    }

    /** The cached client the compositor says is active, or null. */
    private _activeClient(): HyprClient | null {
        if (!this._activeAddr) return null
        return this.clients.find(c => bareAddr(c.address) === this._activeAddr) ?? null
    }

    /** Is the compositor's answer about the workspace the user is looking AT?
     *  Special (scratchpad) workspaces overlay the active one and are announced on
     *  `activespecial`, never on `workspace`, so `focusedWorkspaceId` keeps naming
     *  the normal workspace underneath — a window on a special one (negative id)
     *  therefore counts as here, or focusing the scratchpad would blank the title. */
    private _focusIsHere(c: HyprClient | null): boolean {
        const id = (c as any)?.workspace?.id
        return typeof id === "number" && (id === this.focusedWorkspaceId || id < 0)
    }

    /** True ONLY for real fullscreen (Hyprland FSMODE 2), not "maximized" (FSMODE 1)
     *  or none. `fullscreen` is Hyprland's FSMODE INT, not a boolean — a plain
     *  `!!client.fullscreen` is truthy for MAXIMIZED too, which is why maximize used
     *  to hide the bar/dock. Chrome-hiding (bar opacity, dock auto-hide) keys off
     *  THIS; maximize deliberately keeps all chrome visible and clickable
     *  (fill-the-workspace, like the Windows/GNOME maximize convention). */
    isRealFullscreen(client: HyprClient | null | undefined): boolean {
        return !!client && client.fullscreen === Hypr.FSMODE_FULLSCREEN
    }

    constructor() {
        super()

        const refresh = () => this._scheduleRefresh()
        // Only TRACKED_EVENTS trigger a refresh. Hyprland is chatty — `windowtitle`
        // fires per keystroke in a terminal and per frame on a YouTube tab — and a
        // refresh means "changed", i.e. a bar + dock repaint (tech-debt #11).
        // Everything structural is covered: focus (activewindow), workspace
        // (workspace), open/close (openwindow/closewindow), move (movewindow),
        // monitor (focusedmon, monitoradded/removed).
        Hypr.subscribeEvents((name: string, data: string) => {
            // Hooks first and unconditionally: a waiter is listening for an event
            // that may not be in TRACKED_EVENTS, and must not depend on the
            // refresh path deciding the event is interesting.
            for (const hook of [...this._eventHooks]) {
                try { hook(name, data) } catch (e) { console.error("[HyprlandState] hook threw:", e) }
            }
            if (name === "monitoradded" || name === "monitorremoved" || name === "monitoraddedv2") {
                refresh()   // re-reads monitors, and the mode lists come with them
                return
            }
            // A title change is NOT structural — the signature ignores titles on
            // purpose — but the bar's title capsule still has to follow it. Patch
            // the cached client and emit the narrow signal instead of refreshing.
            if (name === "windowtitle" || name === "windowtitlev2") {
                this._onWindowTitle(name, data)
                return
            }
            if (name === "submap") {
                this.submap = data || ""
                this._scheduleRefresh()
                return
            }
            // Hyprland re-read its config (`hyprctl reload`, or a hyprland-user.lua
            // edit). Re-read state (a monitor's modes can change with it) and let
            // effective-config consumers re-sync via "config-reloaded".
            if (name === "configreloaded") {
                refresh()
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
    }

    /** Subscribe to raw compositor events; returns an unsubscribe. Prefer the
     *  "changed" signal — this exists for waiting on ONE announcement. */
    onEvent(cb: (name: string, data: string) => void): () => void {
        this._eventHooks.add(cb)
        return () => this._eventHooks.delete(cb)
    }

    /** `windowtitle` carries just an address, `windowtitlev2` "ADDRESS,TITLE".
     *  Patch the cached client so `focusedClient.title` is current, then emit
     *  "title-changed" — deliberately NOT "changed": a spinner in a terminal
     *  would otherwise repaint the whole bar and dock several times a second. */
    private _onWindowTitle(name: string, data: string) {
        let addr = "", title: string | null = null
        if (name === "windowtitlev2") {
            const comma = data.indexOf(",")
            if (comma < 0) return
            addr = bareAddr(data.slice(0, comma))
            title = data.slice(comma + 1)
        } else {
            addr = bareAddr(data)
        }
        if (!addr) return
        const c = this.clients.find(x => bareAddr(x.address) === addr)
        if (!c) return
        // v1 gives no title, so ask the compositor for the one window that changed.
        if (title === null) {
            const fresh = Hypr.getClients().find(x => bareAddr(x.address) === addr)
            title = fresh?.title ?? c.title
        }
        if (title === c.title) return
        c.title = title
        this.emit("title-changed", addr)
    }

    /** Mode list for a monitor, straight off the cached `monitors` array —
     *  `j/monitors` carries `availableModes` (42 entries for this box's DP-1), which
     *  is why the separate hyprctl read and its cache map could go. Returns [] if
     *  the monitor is unknown. */
    getAvailableModes(name: string): string[] {
        return this.monitors.find(m => m.name === name)?.availableModes ?? []
    }

    /** Read an effective Hyprland option's int value via `hyprctl getoption` (works
     *  with the Lua parser, unlike `keyword`). On-demand read — the first of the
     *  "effective config in HyprlandState" idea (gaps etc. could follow the same way).
     *
     *  ⚠️ INT-TYPED OPTIONS ONLY. A bool option's `getoption -j` carries no `int`
     *  field at all — `animations:enabled` answers `{"option":…,"bool":false,"set":true}`
     *  — so this returns 0 for every boolean, whatever its value, and says nothing
     *  about it. Use `getOptionBool` for those. (Found 2026-08-16, by a reduce-motion
     *  restore that read `true` as 0 and pinned Hyprland's animations off.) */
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

    /** Read an effective BOOL option (`hyprctl getoption -j` reports those under
     *  `bool`, with no `int` alongside — see the warning on getOptionInt).
     *  `fallback` is returned when the read fails or the option is not a bool, so a
     *  caller never mistakes "could not tell" for `false`. */
    getOptionBool(name: string, fallback = false): boolean {
        try {
            const opt = JSON.parse(exec(["hyprctl", "getoption", name, "-j"]))
            return typeof opt.bool === "boolean" ? opt.bool : fallback
        }
        catch (e) { console.error("[HyprlandState] getOptionBool", name, e); return fallback }
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

    /**
     * Ask the compositor to re-decide which surface the pointer is over, WITHOUT
     * moving it: a warp to the position it is already at.
     *
     * 🔑 There is a state Wayland cannot get itself out of. Destroy the surface that
     * holds pointer focus — which is exactly what closing a `Gtk.DropDown`'s popover
     * does — and Hyprland does not hand the focus to whatever is underneath: it only
     * re-runs that pass on pointer motion, and the pointer has not moved. So NOBODY
     * holds pointer focus, and since only the client that holds it may name a cursor
     * shape, nothing on the desktop can repaint the pointer until the user moves the
     * mouse. That is the compositor's bug; this is the one lever it leaves us.
     *
     * `Actions::moveCursor` (`src/config/shared/actions/ConfigActions.cpp:1181`) is
     * `warpTo(pos, true)` followed by `simulateMouseMovement()`, so warping to the
     * CURRENT position is a pure focus re-evaluation. Measured on the wire: the
     * pointer stays at the same coordinates and the client receives
     * `wl_pointer.leave(dead popover)` → `wl_pointer.enter(parent window)`.
     *
     * ⚠️ This is NOT synthetic input. No libinput event is generated, so
     * focus-follows-mouse does not fire and the keyboard focus is untouched.
     */
    async reevaluatePointerFocus() {
        try {
            const out = await execAsync(["hyprctl", "cursorpos"])
            const [x, y] = out.split(",").map((v) => parseInt(v.trim(), 10))
            if (!Number.isFinite(x) || !Number.isFinite(y)) return
            await this._dispatch(`hl.dsp.cursor.move({ x = ${x}, y = ${y} })`)
        } catch (e) {
            console.error("[HyprlandState] reevaluatePointerFocus:", e)
        }
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

    // Coalesces multiple events that fire in the same GLib iteration into one
    // refresh, AND throttles to a minimum interval.
    //
    // The SELF-SUSTAINING storm this was written for is gone with AstalHyprland
    // (tech-debt #11): reading its getters made it re-emit "event", so
    // event → refresh → read → re-emit → event → … ran _refresh, and therefore the
    // bar + dock repaint, at monitor-refresh rate. Reading a socket provokes
    // nothing, so that loop cannot form any more. The throttle stays because
    // Hyprland itself bursts — dragging a window across a workspace boundary emits
    // movewindow + activewindow + workspace within a frame — and one refresh for
    // the burst is what we want. It is a floor, not a workaround.
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
            this.clients    = Hypr.getClients()
            this.workspaces = Hypr.getWorkspaces()
            this.monitors   = Hypr.getMonitors()
            this._activeAddr = Hypr.getActiveClientAddress()

            // Keep focusedWorkspaceId in sync with the compositor's own view
            // (handles named workspaces and the initial state before any IPC fires).
            // The focused MONITOR names it — a workspace is active per monitor.
            const fwId = this.monitors.find(m => m.focused)?.activeWorkspace?.id
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
            const raw = this._activeClient()
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

            // Only notify when the STRUCTURAL state actually changed: several tracked
            // events describe the same settled state (movewindow then activewindow),
            // and without this guard each no-op refresh would emit "changed" →
            // repaint the bar + dock (tech-debt #11).
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
     *  back to the workspace name. No extra IPC: `lastwindow` came with the
     *  workspace list, so this stays inside the "_refresh reads once" rule. */
    private _workspaceLastClient(): HyprClient | null {
        const ws = this.workspaces.find(w => w?.id === this.focusedWorkspaceId)
        const addr = bareAddr(ws?.lastwindow)
        if (!addr) return null
        return this.clients.find(c =>
            bareAddr((c as any).address) === addr
            && c?.workspace?.id === this.focusedWorkspaceId) ?? null
    }

    // Cheap structural fingerprint of the state "changed" consumers react to (window
    // geometry/class/workspace + focus + the workspace list). DELIBERATELY excludes
    // window titles — AppTitle follows those via the narrow "title-changed" — so a
    // fast-updating title doesn't churn "changed".
    private _stateSignature(): string {
        // The RECONCILED focus, not hl.focused_client: a spurious null is not a change.
        let s = `${this.focusedWorkspaceId}|${(this.focusedClient as any)?.address ?? ""}`
        for (const c of this.clients as any[]) {
            if (!c) continue
            // `fullscreen` is in here because it is structural and NOT always visible
            // in the geometry: a window already filling its monitor (maximized, or
            // tiled alone) toggles FSMODE without moving a pixel, and the bar and dock
            // both hide their chrome on that. They used to catch it with a per-client
            // notify::fullscreen handler that had to be rewired on every focus change
            // and leaked on dock rebuilds; one more int in the fingerprint replaces both.
            s += `;${c.address},${c.class},${c.x},${c.y},${c.width},${c.height},${c.fullscreen},${c.workspace?.id ?? ""}`
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
     *  WHY IT IS NEEDED. Dropping the grab makes Hyprland refocus by itself, and
     *  `CSeatManager::setGrab(nullptr)` branches on `input:follow_mouse`: `1` →
     *  `refocus()`, so where the mouse happens to rest decides who gets the keyboard;
     *  `0 || 2 || 3` → `refocusLastWindow` on the monitor under the cursor. The repo
     *  ships `2` since 2026-08-15 (the branch that usually answers correctly), but the
     *  value is a user override away and this stays for it. Measured
     *  2026-08-05 (under `1`): dismiss a panel onto a window and that window is focused; dismiss it
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
            // A LIVE read, not `focusedClient`: that one is reconciled and answers
            // with the remembered window precisely when the compositor has gone
            // quiet — which is the case we are here to fix.
            if (Hypr.getActiveClientAddress()) return   // the compositor found someone: leave it
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
        let unhook: (() => void) | null = null
        let timer = 0
        const go = () => {
            if (done) return
            done = true
            unhook?.()
            if (timer) { GLib.source_remove(timer); timer = 0 }
            cb()
        }
        unhook = this.onEvent((name: string) => { if (name === "activewindow") go() })
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
        // A FRESH read, not the cached `clients` array — see getClientsJson.
        // Under AstalHyprland this was mandatory (its Client.floating went stale
        // and a tiled window could read floating=true, so this skipped windows and
        // the menu drew wrong checks, 2026-06-11); it stays because the cache is a
        // snapshot taken at the last event and a bulk op must not act on one.
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

    /** One-shot raw read of ALL clients from hyprctl, RIGHT NOW. Still the
     *  authoritative window state even though `clients` is now built from the same
     *  JSON: that array is a snapshot from the last event, and it is mapped down to
     *  the fields the UI draws (no `grouped`, `tags`, `swallowing`, `fullscreenClient`).
     *  The window menu must always read its checkmarks from HERE. Called on demand
     *  (menu open, bulk ops) — deliberately NOT part of _refresh, which runs on
     *  every IPC event. Returns [] on failure. */
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
