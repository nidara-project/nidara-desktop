import GLib from "gi://GLib"
import Gio from "gi://Gio"
import status, { ISLAND_AGENT } from "./Status"
import { SHELL_ROOT } from "./Paths"
import agentConfig from "./AgentConfig"
import { t } from "./i18n"

// Facade over `bin/nidara-agent` — the built-in Assistant's brain (a BYOK LLM
// tool-use loop, see the daemon's header). This owns the subprocess and the
// conversation state; the UI (surfaces/island/AgentIsland) subscribes and
// renders. Like every core service it NEVER imports a widget — it flows state
// out (getters + subscribe) and drives visibility only through Status.
//
// The daemon is a stdio child speaking JSON-lines (the inverse of nidara-mcp):
//   shell→daemon: {t:"user",text} · {t:"cancel"} · {t:"reset"}
//   daemon→shell: {t:"state",s} · {t:"delta",text} · {t:"tool",name,summary} ·
//                 {t:"toolresult",ok,summary} · {t:"done",usage} · {t:"error",message}
// It's spawned LAZILY on the first send (an idle desktop shouldn't carry an
// extra gjs) and respawned if it dies.

export interface ToolCall {
    name: string
    summary: string
    ok?: boolean
    resultSummary?: string
}
export interface Turn {
    role: "user" | "assistant"
    text: string
    tools: ToolCall[]
    /**
     * Abnormal end of this turn — provider error, daemon death, empty
     * completion. Kept SEPARATE from `text` so it survives a turn that already
     * streamed something (the old code only filled empty turns, so an error
     * after the first token was invisible) and so the UI can tint it.
     *
     * The rule: every turn ends either with text or with this. Silence is a bug.
     */
    error?: string
}

let proc: Gio.Subprocess | null = null
// Typed via InstanceType, not `Gio.DataOutputStream`: the @girs Gio namespace
// exposes these two as values but not as types (unlike Gio.Subprocess), so the
// namespace form fails typecheck. Resolving through the value works everywhere.
let stdin: InstanceType<typeof Gio.DataOutputStream> | null = null

let transcript: Turn[] = []
let busy = false
let agentState: "idle" | "thinking" | "acting" = "idle"
let usage = { input: 0, output: 0, cached: 0 }
let lastError: string | null = null
let cancelling = false      // user pressed cancel → an empty turn is expected, not a fault

let turnStartedAt = 0

const listeners = new Set<() => void>()
const notify = () => listeners.forEach(fn => fn())

// Half of the agent's telemetry (the other half is the daemon's own stderr,
// which lands in the same nidara-ui.log). Together they make a failed turn
// reconstructible after the fact — see the daemon header for the rules. Never
// log the prompt or the reply, only shape.
const log = (msg: string) => console.log(`[AgentService] ${msg}`)

// End a turn that produced no text with a VISIBLE reason. Called for every
// abnormal end; `expand` pops the island open when the failure happened with it
// closed (a background turn dying invisibly was the worst bug of the first live
// run — see tech-debt #39).
function failTurn(message: string, expand = true) {
    lastError = message
    const a = currentAssistant()
    if (a) a.error = message
    if (expand && !status.isAnyOverlayOpen) status.island_mode = ISLAND_AGENT
    notify()
}

// PATH first (installed), then the dev checkout's bin/ via SHELL_ROOT
// (repo/ui/shell → repo/bin) run through gjs, since a dev machine may not have
// re-run install.sh since the binary was added.
function resolveDaemon(): string[] {
    const onPath = GLib.find_program_in_path("nidara-agent")
    if (onPath) return [onPath]
    const dev = `${SHELL_ROOT}/../../bin/nidara-agent`
    if (GLib.file_test(dev, GLib.FileTest.EXISTS)) return ["gjs", "-m", dev]
    return []
}

function readLoop(din: InstanceType<typeof Gio.DataInputStream>) {
    din.read_line_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
        let line: string | null
        try { [line] = src.read_line_finish_utf8(res) } catch { return }
        if (line === null) return   // daemon closed stdout / exited
        if (line.trim()) {
            try { handleEvent(JSON.parse(line)) } catch (e) { console.error("[AgentService] bad event:", e) }
        }
        readLoop(din)
    })
}

function ensureDaemon(): boolean {
    if (proc) return true
    const argv = resolveDaemon()
    if (!argv.length) {
        lastError = "nidara-agent not found — re-run install.sh"
        notify()
        return false
    }
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE)
        log(`spawn: ${argv.join(" ")}`)
        stdin = new Gio.DataOutputStream({ base_stream: proc.get_stdin_pipe()! })
        readLoop(new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe()! }))
        // Detect death → drop refs so the next send respawns (fresh daemon = fresh
        // history; the UI transcript survives, a rare crash just loses model context).
        // stderr is deliberately NOT piped: inherited, it flows to nidara-ui.log.
        const dead = proc
        proc.wait_async(null, () => {
            // WHY it died, not just that it did: a signal (killed with the shell,
            // OOM, segfault) reads completely differently from a clean exit, and
            // without this the daemon's disappearance left no trace at all.
            const how = dead.get_if_signaled()
                ? `signal ${dead.get_term_sig()}`
                : `exit ${dead.get_exit_status()}`
            log(`daemon gone (${how})${busy ? " MID-TURN" : ""}`)
            proc = null
            stdin = null
            if (busy) {
                busy = false
                agentState = "idle"
                failTurn(t("island.agent.error.died"))
            }
        })
        return true
    } catch (e) {
        lastError = String((e as any)?.message ?? e)
        log(`spawn failed: ${lastError}`)
        proc = null
        stdin = null
        notify()
        return false
    }
}

/** @returns false if the daemon could not be written to (caller must surface it). */
function writeLine(obj: unknown): boolean {
    if (!stdin) return false
    try {
        stdin.put_string(JSON.stringify(obj) + "\n", null)
        stdin.flush(null)
        return true
    } catch (e) {
        log(`write failed: ${e}`)
        return false
    }
}

// Append to the assistant Turn opened by send() — one assistant Turn per user
// turn, accumulating its streamed text and tool chips.
function currentAssistant(): Turn | null {
    const last = transcript[transcript.length - 1]
    return last?.role === "assistant" ? last : null
}

function handleEvent(ev: any) {
    switch (ev?.t) {
        case "state":
            agentState = ev.s
            if (ev.s === "idle") {
                busy = false
                // Last line of defence against a silent turn: the daemon promises
                // text OR an error before going idle, but if it ever goes idle with
                // neither (a protocol gap, a future backend), say so rather than
                // leaving an empty bubble. Cancelled turns are the user's own doing
                // and stay quiet.
                const a = currentAssistant()
                if (a && !a.text && !a.error && !a.tools.length && !cancelling)
                    a.error = t("island.agent.error.empty")
                cancelling = false
                log(`turn end: ${Math.round((Date.now() - turnStartedAt))}ms text=${a?.text.length ?? 0}c tools=${a?.tools.length ?? 0}${a?.error ? " ERROR" : ""}`)
                // Expand-on-finish: work may have run with the island closed
                // (background). If the desktop is otherwise idle, pop the answer
                // open. Never steal from another open overlay (CC/Prism/…) or
                // re-open while already showing (island already counts as open).
                if (!status.isAnyOverlayOpen) status.island_mode = ISLAND_AGENT
            } else {
                busy = true
            }
            notify()
            break
        case "delta": {
            const a = currentAssistant()
            if (a) a.text += ev.text ?? ""
            notify()
            break
        }
        case "tool": {
            const a = currentAssistant()
            if (a) a.tools.push({ name: ev.name, summary: ev.summary })
            log(`tool: ${ev.summary ?? ev.name}`)
            notify()
            break
        }
        case "toolresult": {
            const a = currentAssistant()
            const tool = a?.tools[a.tools.length - 1]
            if (tool) { tool.ok = ev.ok; tool.resultSummary = ev.summary }
            notify()
            break
        }
        case "done":
            usage.input += ev.usage?.input ?? 0
            usage.output += ev.usage?.output ?? 0
            // Prompt tokens the provider served from cache — a SUBSET of input,
            // not an extra. Surfaced separately because it is the difference
            // between "this conversation is getting expensive" and "most of it
            // is being re-read cheaply".
            usage.cached += ev.usage?.cached ?? 0
            notify()
            break
        case "error": {
            // Always its own line in the bubble: an error that arrives AFTER some
            // text used to vanish (only empty turns were filled), which reads as
            // "it answered fine" when it did not.
            const message = ev.message ?? "Something went wrong."
            log(`error: ${message}`)
            // While busy, the state:idle that follows does the expanding; if the
            // error arrives after it (the daemon's outer catch), expand here.
            failTurn(message, !busy)
            break
        }
    }
}

export const agentService = {
    get transcript(): Turn[] { return transcript },
    get busy(): boolean { return busy },
    get state() { return agentState },
    get usage() { return usage },
    get lastError(): string | null { return lastError },

    /** Whether a provider is configured (Settings → AI) — drives the empty state. */
    configured(): boolean { return agentConfig.brainProvider !== "" },

    send(text: string) {
        const msg = text.trim()
        if (!msg || busy) return
        // Both turns go in BEFORE the daemon is touched: a failure to spawn (or to
        // write) then has a bubble to paint itself into. The old order returned
        // early on spawn failure, leaving the user staring at nothing.
        transcript.push({ role: "user", text: msg, tools: [] })
        transcript.push({ role: "assistant", text: "", tools: [] })
        lastError = null
        cancelling = false
        turnStartedAt = Date.now()
        log(`turn start: ${msg.length} chars, transcript=${transcript.length}`)
        if (!ensureDaemon()) { failTurn(lastError ?? t("island.agent.error.died"), false); return }
        busy = true
        agentState = "thinking"
        if (!writeLine({ t: "user", text: msg })) {
            busy = false
            agentState = "idle"
            failTurn(t("island.agent.error.died"), false)
            return
        }
        notify()
    },

    cancel() {
        if (!busy) return
        log("cancel requested")
        cancelling = true
        writeLine({ t: "cancel" })
    },

    reset() {
        log(`reset: ${transcript.length} turns dropped`)
        transcript = []
        usage = { input: 0, output: 0, cached: 0 }
        lastError = null
        cancelling = false
        writeLine({ t: "reset" })
        notify()
    },

    subscribe(fn: () => void): () => void {
        listeners.add(fn)
        return () => listeners.delete(fn)
    },
}

export default agentService
