// apps-probe.ts — exercises core/app-search.ts and core/AppService's catalogue
// (the AstalApps replacement) against a fixture AND against this machine's real
// .desktop files, in a process of its own.
//
//   ags bundle --gtk 4 scripts/dev/apps-probe.ts /tmp/apps-probe
//   /tmp/apps-probe                 # ours
//   /tmp/apps-probe --astal         # the SAME live checks, answered by AstalApps
//
// What it has to show, in order:
//
//   - the ranker's contract on a fixture: a one-character query filters, an app's
//     own name ranks it first, accents fold, the acronym tier finds "gwf" →
//     GTK Widget Factory, the rescue tier finds a name with a word too many, and
//     a Chrome web app is NOT a result for "fire";
//   - on the live catalogue: hidden entries stay out of the launcher list but
//     stay IN the registry, one-character queries filter, every app's own name
//     ranks it first, and — the check this whole replacement is about — no result
//     is justified only by its `Exec=` ARGUMENTS.
//
// ⚠️ Prove it can FAIL before believing a green run. Two controls:
//
//   /tmp/apps-probe --astal
//       answers the live half with `gi://AstalApps`, the library we removed. It
//       must FAIL "a one-character query filters" (a total miss scores −30 and
//       the single-char branch only drops apps scoring exactly 0, so it returns
//       the whole catalogue) and FAIL "no result rides on Exec= arguments"
//       (`--profile-directory=Default` spells f-i-r-e). If it passes those, this
//       probe is not testing what it claims to test.
//
//   XDG_DATA_HOME=/nonexistent XDG_DATA_DIRS=/nonexistent /tmp/apps-probe
//       takes the .desktop files away: the live half collapses to an empty or
//       near-empty catalogue and its checks report FAIL, while the fixture half
//       (pure functions, no environment) still passes. A run where BOTH halves
//       stay green means the live half is not reading anything.
import "./gtk-init"
import { rankApps, fold, type Searchable } from "../../ui/shell/core/app-search"
import appService, { type AppData } from "../../ui/shell/core/AppService"

const USE_ASTAL = ARGV.includes("--astal")

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++; else fail++
    print(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`)
}

const names = (apps: { name: string }[], n = 4) =>
    apps.slice(0, n).map(a => a.name).join(" | ") || "(none)"

// ── Half 1: the ranker's contract, on a fixture ─────────────────────────────
// Machine-independent on purpose: these are the rules, stated once, where no
// installed app can quietly satisfy or break them. The Chrome web app carries the
// real Exec line from this machine, arguments included.
const CHROME_PWA_EXEC = "google-chrome"
const FIXTURE: Searchable[] = [
    { name: "Google Chrome", id: "google-chrome", exec: "google-chrome", keywords: ["browser", "web"] },
    { name: "Reddit", id: "chrome-abcdefghijklmnop-Default", exec: CHROME_PWA_EXEC, keywords: [] },
    { name: "YouTube", id: "chrome-qrstuvwxyzabcdef-Default", exec: CHROME_PWA_EXEC, keywords: [] },
    { name: "Files", id: "org.gnome.Nautilus", exec: "nautilus", keywords: ["folder", "manager"] },
    { name: "Widget Factory", id: "gtk3-widget-factory", exec: "gtk3-widget-factory", keywords: [] },
    { name: "Configuración", id: "org.nidara.Settings", exec: "nidara-settings", keywords: [] },
    { name: "Firefox", id: "firefox", exec: "firefox", keywords: ["browser", "www"] },
    { name: "XTerm", id: "xterm", exec: "xterm", keywords: [] },
    { name: "Terminal", id: "org.gnome.Terminal", exec: "gnome-terminal", keywords: ["shell"] },
    { name: "Mission Center", id: "io.missioncenter.MissionCenter", exec: "missioncenter", keywords: ["firewall", "monitor"] },
    { name: "Micro", id: "micro", exec: "micro", keywords: ["terminal", "editor"] },
]
const rank = (q: string) => rankApps(q, FIXTURE)
const has = (q: string, name: string) => rank(q).some(a => a.name === name)

const fixtureHalf = () => {
    print("── the ranker, on a fixture ──────────────────────────────────────────")

    // The headline. Every one of these web apps runs the same command line, whose
    // ARGUMENTS spell f-i-r-e; matching the executable basename is what stops them.
    const fire = rank("fire")
    check("\"fire\" finds Firefox first", fire[0]?.name === "Firefox", names(fire))
    check("\"fire\" does NOT return the Chrome web apps",
        !has("fire", "Reddit") && !has("fire", "YouTube"), names(fire))

    // A single character used to keep the whole catalogue.
    const f = rank("f")
    check("a one-character query filters", f.length > 0 && f.length < FIXTURE.length,
        `${f.length}/${FIXTURE.length}: ${names(f, 6)}`)
    check("\"f\" reaches a word start mid-name (Widget Factory)", has("f", "Widget Factory"))
    check("\"f\" does not reach a letter buried mid-word (Reddit, YouTube)",
        !has("f", "Reddit") && !has("f", "YouTube"))

    // Every app has to be findable by the thing written under its icon.
    const selfFirst = FIXTURE.filter(a => rank(a.name)[0]?.name !== a.name)
    check("every app's own name ranks it first", selfFirst.length === 0,
        selfFirst.map(a => a.name).join(", "))

    // Tiers: a prefix must outrank a substring, whatever the fuzzy score says.
    const term = rank("term")
    check("prefix outranks substring (Terminal before XTerm)",
        term[0]?.name === "Terminal" && term.some(a => a.name === "XTerm"), names(term))

    check("the id is searchable (\"nautilus\" → Files)", rank("nautilus")[0]?.name === "Files")
    // Every Chrome web app's id literally begins "chrome-": a name must outrank
    // an id that merely starts the same way, or the browser loses to its own PWAs.
    check("a name beats an id that only starts the same way (\"chrom\")",
        rank("chrom")[0]?.name === "Google Chrome", names(rank("chrom")))
    check("keywords are searchable (\"browser\") but rank below names",
        rank("browser").length >= 2 && rank("browser").every(a => a.keywords.includes("browser")),
        names(rank("browser")))
    // Micro declares keyword "terminal"; XTerm has it in its NAME.
    check("a partial keyword does not outrank a name (\"term\")",
        rank("term").map(a => a.name).join(",") === "Terminal,XTerm,Micro",
        names(rank("term"), 6))
    check("accents fold (\"configuracion\" → Configuración)",
        rank("configuracion")[0]?.name === "Configuración")
    check("the acronym tier finds \"gwf\" → Widget Factory",
        rank("gwf")[0]?.name === "Widget Factory", names(rank("gwf")))
    check("the rescue tier survives a word too many (\"GTK Widget Factory\")",
        has("GTK Widget Factory", "Widget Factory"), names(rank("GTK Widget Factory")))
    check("nonsense returns nothing", rank("xyzzy").length === 0, names(rank("xyzzy")))
    check("whitespace-only returns nothing", rank("   ").length === 0)

    // A GTK sort function is keyed on this order; it must not shuffle.
    const a = rank("f").map(x => x.name).join(",")
    const b = rank("f").map(x => x.name).join(",")
    check("the order is total and repeatable", a === b && a.length > 1, a)

    check("fold() is 1:1 (index-safe for word starts)",
        fold("Configuración").length === "Configuración".length &&
        fold("Configuración").join("") === "configuracion")
}

// ── Half 2: the live catalogue ──────────────────────────────────────────────
// Both implementations answer the same three questions about the same machine.
interface LiveApp { name: string, id: string, exec: string, keywords: string[] }

const ours = () => {
    const toLive = (a: AppData): LiveApp => ({ name: a.name, id: a.id, exec: a.exec, keywords: a.keywords })
    return {
        label: "core/AppService + core/app-search",
        list: () => appService.listApps().map(toLive),
        registry: () => appService.getAllApps().length,
        query: (q: string) => appService.queryApps(q).map(toLive),
    }
}

const astal = () => {
    // Still installed on any machine that ran install.sh before this change; the
    // point of loading it here is to watch it fail the checks below.
    const AstalApps = (imports as any).gi.AstalApps
    const svc = new AstalApps.Apps()
    const toLive = (a: any): LiveApp => ({
        name: a.name || "",
        id: (a.entry || "").replace(/\.desktop$/, ""),
        // The basename, NOT a.executable — the check is whether a result can be
        // justified without the argument list, so the argument list may not be in it.
        exec: (a.executable || "").split(" ")[0].split("/").pop() || "",
        keywords: a.keywords || [],
    })
    return {
        label: "AstalApps (the library this replaces)",
        list: () => svc.get_list().map(toLive),
        registry: () => svc.get_list().length,
        query: (q: string) => svc.fuzzy_query(q).map(toLive),
    }
}

/** Is `q` reachable in this app at all, ignoring `Exec=` arguments? */
const justified = (q: string, a: LiveApp): boolean => {
    const needle = fold(q).join("")
    const inOrder = (hay: string) => {
        const h = fold(hay).join("")
        let i = 0
        for (const c of h) if (c === needle[i]) i++
        return i === needle.length
    }
    return inOrder(a.name) || inOrder(a.id) || inOrder(a.exec) || a.keywords.some(inOrder)
}

const liveHalf = () => {
    const impl = USE_ASTAL ? astal() : ours()
    print(`── the live catalogue, answered by ${impl.label} ──`)

    const list = impl.list()
    print(`  (${list.length} launchable of ${impl.registry()} registered)`)
    check("the catalogue is not empty", list.length > 5, `${list.length} apps`)
    if (!list.length) return

    if (!USE_ASTAL) {
        // Ours is the only side that keeps hidden entries at all: they are how a
        // window gets its name and icon even when nothing may list them.
        const all = appService.getAllApps()
        const hidden = all.filter(a => !a.visible)
        check("hidden entries stay OUT of the launcher list",
            !appService.listApps().some(a => !a.visible), `${hidden.length} hidden`)
        check("hidden entries stay IN the registry (identity, not launching)",
            hidden.length > 0 && all.length > list.length,
            hidden.length ? `e.g. ${hidden[0].name}` : "none on this machine")
        check("Prism can still reach a hidden app by name",
            hidden.length === 0 || appService.search(hidden[0].name).some(a => a.id === hidden[0].id),
            hidden.length ? hidden[0].name : "n/a")
    }

    for (const c of ["f", "z", "a"]) {
        const r = impl.query(c)
        check(`a one-character query filters ("${c}")`, r.length < list.length,
            `${r.length}/${list.length}`)
    }

    // THE check. A result nobody can justify from its name, id, executable
    // basename or keywords got in through its command line's arguments.
    for (const q of ["fire", "file", "term", "chrome", "code"]) {
        const r = impl.query(q)
        const bogus = r.filter(a => !justified(q, a))
        check(`no result rides on Exec= arguments ("${q}")`, bogus.length === 0,
            bogus.length ? `${bogus.length} of ${r.length}: ${names(bogus, 5)}` : `${r.length} result(s)`)
    }

    // Sweep the whole machine: typing exactly what is written under an icon has to
    // put that icon first. Duplicate display names (a hidden twin of Chrome) are
    // the one allowed miss, so compare by name.
    const missed = list.filter(a => impl.query(a.name)[0]?.name !== a.name)
    check("every installed app's own name ranks it first",
        missed.length === 0, `${missed.length} missed: ${names(missed, 5)}`)
}

print(`apps-probe — ${USE_ASTAL ? "NEGATIVE CONTROL (AstalApps)" : "core/app-search"}`)
if (!USE_ASTAL) fixtureHalf()
liveHalf()
print(`PROBE-RESULT ${fail === 0 ? "ALL PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
