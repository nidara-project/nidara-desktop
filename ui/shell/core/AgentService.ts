import GLib from "gi://GLib"
import Gio from "gi://Gio"
import status, { ISLAND_AGENT } from "./Status"
import { SHELL_ROOT } from "./Paths"
import agentConfig from "./AgentConfig"

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
}

let proc: Gio.Subprocess | null = null
let stdin: Gio.DataOutputStream | null = null

let transcript: Turn[] = []
let busy = false
let agentState: "idle" | "thinking" | "acting" = "idle"
let usage = { input: 0, output: 0 }
let lastError: string | null = null

const listeners = new Set<() => void>()
const notify = () => listeners.forEach(fn => fn())

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

function readLoop(din: Gio.DataInputStream) {
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
        stdin = new Gio.DataOutputStream({ base_stream: proc.get_stdin_pipe()! })
        readLoop(new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe()! }))
        // Detect death → drop refs so the next send respawns (fresh daemon = fresh
        // history; the UI transcript survives, a rare crash just loses model context).
        proc.wait_async(null, () => {
            proc = null
            stdin = null
            if (busy) { busy = false; agentState = "idle"; notify() }
        })
        return true
    } catch (e) {
        lastError = String((e as any)?.message ?? e)
        proc = null
        stdin = null
        notify()
        return false
    }
}

function writeLine(obj: unknown) {
    if (!stdin) return
    try {
        stdin.put_string(JSON.stringify(obj) + "\n", null)
        stdin.flush(null)
    } catch (e) {
        console.error("[AgentService] write failed:", e)
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
            notify()
            break
        case "error": {
            lastError = ev.message ?? "error"
            const a = currentAssistant()
            if (a && !a.text) a.text = ev.message ?? "Something went wrong."
            notify()
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
    configured(): boolean { return agentConfig.brainBackend !== "" },

    send(text: string) {
        const msg = text.trim()
        if (!msg || busy) return
        if (!ensureDaemon()) return
        transcript.push({ role: "user", text: msg, tools: [] })
        transcript.push({ role: "assistant", text: "", tools: [] })
        lastError = null
        busy = true
        agentState = "thinking"
        writeLine({ t: "user", text: msg })
        notify()
    },

    cancel() {
        if (!busy) return
        writeLine({ t: "cancel" })
    },

    reset() {
        transcript = []
        usage = { input: 0, output: 0 }
        lastError = null
        writeLine({ t: "reset" })
        notify()
    },

    subscribe(fn: () => void): () => void {
        listeners.add(fn)
        return () => listeners.delete(fn)
    },
}

export default agentService
