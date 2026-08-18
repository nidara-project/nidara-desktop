// tray-probe.ts — exercises core/tray.ts + core/dbusmenu.ts (the AstalTray and
// appmenu-glib-translator replacements) against a fake tray app it starts itself.
//
//   scripts/bundle.sh scripts/dev/tray-probe.ts /tmp/tray-probe
//   dbus-run-session -- /tmp/tray-probe          # from the repo root
//
// `dbus-run-session` is not optional: this probe IS a StatusNotifierWatcher, and
// the running shell already owns that name on the real session bus. On the real
// bus it would silently measure the SHELL instead of itself — so "the watcher
// name is free" is a hard precondition, not a check.
//
// It needs no display, no GTK and no tray app installed. It imports `core/tray`
// and nothing else from the shell.
//
// What it has to show, in order:
//
//   - a tray app that registers appears in the roster with its identity intact
//     (id, title, tooltip markup, icon name), and one that dies leaves;
//   - a pixmap-only item is DECODED, not just stored: SNI ships ARGB32 in network
//     byte order and GdkPixbuf wants RGBA, so the probe reads pixel 0 back out of
//     the composed gicon. A host that skips the rotation shows a blue icon where
//     the app sent red and nothing anywhere errors;
//   - the NewStatus/NewTitle signals move the item, and NeedsAttention swaps in
//     the attention icon (which is the only reason that state exists);
//   - the dbusmenu becomes a GMenuModel with the right rows in the right order:
//     an invisible row is dropped, a separator becomes a section break, a submenu
//     keeps its children, and a DEEPER submenu still arrives — that last one is
//     what proves the layout is fetched with recursionDepth=-1 in ONE call
//     instead of the translator's level-by-level walk;
//   - clicking a row REACHES the app: the fake logs every inbound call, so the
//     check is `Event 9 clicked` in its log, not "activate_action did not throw";
//   - a row relabelled via ItemsPropertiesUpdated (the cheap signal, not
//     LayoutUpdated) rebuilds the model — into the SAME Gio.Menu object, which is
//     what lets the bar keep one `items-changed` connection forever;
//   - ONE app publishing TWO items keeps two icons, and dropping that app takes
//     BOTH away. AstalTray's watcher keyed its registry by bus name alone, so the
//     second registration overwrote the first and one icon stayed in the bar,
//     dead, until the shell restarted.
//
// ⚠️ Prove it can FAIL before believing a green run. THREE controls, and each one
// fails on a DIFFERENT line — that is the point of having three:
//
//   DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent /tmp/tray-probe
//     no bus at all. PRECONDITION 1 fails hard. Deliberately not "0 items, all
//     green", which is what an empty roster looks like.
//
//   /tmp/tray-probe                              (without dbus-run-session)
//     the shell owns the watcher name. PRECONDITION 2 fails hard, on a different
//     line, because a probe that quietly follows someone else's watcher measures
//     nothing about this code.
//
//   dbus-run-session -- /tmp/tray-probe --astal
//     runs the same checks against the LIBRARY being replaced. It is evidence,
//     not just a control: AstalTray goes red on the two-items teardown and on the
//     ItemIsMenu default, and those reds are the bugs this module fixes.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { getDefault } from "../../ui/shell/core/tray"

const ASTAL_CONTROL = ARGV.includes("--astal")

let pass = 0
let fail = 0

function check(ok: boolean, label: string, detail = ""): boolean {
    if (ok) { pass++; print(`  PASS  ${label}${detail ? "  — " + detail : ""}`) }
    else { fail++; print(`  FAIL  ${label}${detail ? "  — " + detail : ""}`) }
    return !!ok
}

function section(title: string): void {
    print(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`)
}

function die(msg: string): never {
    print(`\nPRECONDITION FAILED: ${msg}`)
    print("PROBE-RESULT PRECONDITION")
    imports.system.exit(2)
}

const loop = new GLib.MainLoop(null, false)

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE })
    })
}

async function until<T>(fn: () => T, ms = 5000, step = 50): Promise<T> {
    const deadline = GLib.get_monotonic_time() + ms * 1000
    let v = fn()
    while (!v && GLib.get_monotonic_time() < deadline) {
        await sleep(step)
        v = fn()
    }
    return v
}

// ── the fake app, as a child process ─────────────────────────────────────────

const REPO = GLib.get_current_dir()

class Fake {
    proc: Gio.Subprocess
    busName = ""

    constructor(args: string[]) {
        this.proc = Gio.Subprocess.new(
            ["gjs", `${REPO}/scripts/dev/fake-sni.js`, ...args],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        )
    }

    /** Its well-known name is derived from its pid, which we know. */
    resolveBusName(): string {
        if (!this.busName) this.busName = `org.kde.StatusNotifierItem-${this.proc.get_identifier()}-1`
        return this.busName
    }

    call(method: string, params: GLib.Variant | null, reply: string | null): Promise<any> {
        return new Promise(resolve => {
            try {
                Gio.DBus.session.call(
                    this.resolveBusName(), "/FakeControl", "org.nidara.FakeSNI", method, params,
                    reply ? new GLib.VariantType(reply) : null,
                    Gio.DBusCallFlags.NONE, 3000, null,
                    (_s, res) => {
                        try { resolve(Gio.DBus.session.call_finish(res)?.deep_unpack?.()) }
                        catch { resolve(null) }
                    },
                )
            } catch { resolve(null) }
        })
    }

    async log(): Promise<string[]> {
        const r = await this.call("GetLog", null, "(as)")
        return (r?.[0] as string[]) ?? []
    }

    async quit(): Promise<void> {
        await this.call("Quit", null, null)
        await sleep(200)
    }

    kill(): void { try { this.proc.force_exit() } catch { } }
}

// ── model readers ────────────────────────────────────────────────────────────

/** Flatten a GMenuModel the way `common/NidaraMenu.ts` does: sections and
 *  submenus inline, labels only. `|` marks a section break so the probe can
 *  assert that a separator survived. */
function flatten(model: any, depth = 0): string[] {
    if (!model || depth > 6) return []
    const out: string[] = []
    const n = model.get_n_items()
    for (let i = 0; i < n; i++) {
        const section = model.get_item_link(i, "section")
        if (section) {
            if (out.length) out.push("|")
            out.push(...flatten(section, depth + 1))
            continue
        }
        const label = model.get_item_attribute_value(i, "label", null)?.unpack?.() ?? ""
        const submenu = model.get_item_link(i, "submenu")
        if (submenu) {
            out.push(`>${label}`)
            out.push(...flatten(submenu, depth + 1))
            continue
        }
        out.push(String(label))
    }
    return out
}

function actionNames(group: any): string[] {
    try { return group ? [...group.list_actions()].sort() : [] } catch { return [] }
}

// ── the service under test ───────────────────────────────────────────────────
// `--astal` swaps in the library, so the same checks run against both.

interface ItemLike {
    item_id: string
    id: string
    title: string
    is_menu: boolean
    icon_name: string
    gicon: any
    tooltip_markup: string
    menu_model: any
    action_group: any
    activate(x: number, y: number): void
    about_to_show(): any
}

interface ServiceLike {
    items: ItemLike[]
    getItem(id: string): ItemLike | null
}

async function makeService(): Promise<ServiceLike> {
    if (!ASTAL_CONTROL) return getDefault() as unknown as ServiceLike

    const AstalTray = (await import("gi://AstalTray")).default as any
    const tray = AstalTray.get_default()
    return {
        get items() { return tray.items as ItemLike[] },
        getItem: (id: string) => (tray.items as any[]).find(i => i.item_id === id) ?? null,
    }
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    print(`tray-probe — ${ASTAL_CONTROL ? "AstalTray (negative control)" : "core/tray.ts"}`)

    // PRECONDITION 1: a session bus we can actually talk to. `Gio.DBus.session`
    // is lazy and will happily hand back an object that fails on first use, so
    // ask the bus daemon something only a live bus can answer.
    let unique = ""
    try {
        const r = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetId", null, new GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 2000, null)
        unique = r.deep_unpack()[0]
    } catch (e) {
        die(`no session bus (${e}). Nothing below could have run.`)
    }
    print(`  session bus ${unique}`)

    // PRECONDITION 2: the watcher name must be FREE. If the shell (or a stray
    // astal-tray, or plasmashell) owns it, this process becomes a mere host and
    // every check below would be measuring somebody else's implementation.
    try {
        const r = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "NameHasOwner", new GLib.Variant("(s)", ["org.kde.StatusNotifierWatcher"]),
            new GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE, 2000, null)
        if (r.deep_unpack()[0]) {
            die("org.kde.StatusNotifierWatcher is already owned on this bus — "
                + "run under `dbus-run-session --` so the probe is the watcher.")
        }
    } catch (e) {
        die(`could not ask the bus who owns the watcher name (${e})`)
    }

    const tray = await makeService()
    await sleep(300)   // let the watcher name land before anyone registers

    // ── roster ───────────────────────────────────────────────────────────────
    section("roster and identity")

    // --deep gives the menu a THIRD level. A host that walks the layout a level at
    // a time (what the translator did) can still be made to look right on two
    // levels; three is where a single recursionDepth=-1 fetch is the only thing
    // that shows the whole tree in one round trip.
    const fake = new Fake(["--deep"])
    const itemId = `${fake.resolveBusName()}/StatusNotifierItem`
    const item = await until(() => tray.getItem(itemId), 6000)
    if (!check(!!item, "a registering tray app appears in the roster", itemId)) {
        fake.kill()
        return finish()
    }

    check(item.id === "fakesni", "SNI Id survives", item.id)
    check(item.title === "Fake Tray App", "Title survives", item.title)
    check(item.icon_name === "dialog-information", "IconName survives", item.icon_name)
    check(
        item.tooltip_markup.startsWith("Fake tooltip &lt;b&gt;title&lt;/b&gt;")
        && item.tooltip_markup.includes("and its body"),
        "ToolTip becomes escaped markup (title + body)",
        JSON.stringify(item.tooltip_markup),
    )
    // The fake does not publish ItemIsMenu at all. Per the SNI spec that means
    // false; AstalTray defaults it to true, which turns a left click into a menu
    // open for every app that omits the property.
    check(item.is_menu === false, "an item without ItemIsMenu defaults to false (spec)", String(item.is_menu))

    // ── signals ──────────────────────────────────────────────────────────────
    section("live property signals")

    await fake.call("SetTitle", new GLib.Variant("(s)", ["Renamed"]), null)
    check(await until(() => item.title === "Renamed", 3000), "NewTitle updates the title", item.title)

    await fake.call("SetStatus", new GLib.Variant("(s)", ["NeedsAttention"]), null)
    check(
        await until(() => item.icon_name === "dialog-warning", 3000),
        "NeedsAttention swaps in AttentionIconName", item.icon_name,
    )
    await fake.call("SetStatus", new GLib.Variant("(s)", ["Active"]), null)
    check(await until(() => item.icon_name === "dialog-information", 3000), "Active swaps back", item.icon_name)

    // ── activate ─────────────────────────────────────────────────────────────
    section("activation reaches the app")

    item.activate(3, 4)
    const activateLogged = await until(async () => (await fake.log()).some(l => l.startsWith("Activate 3,4")), 3000)
    check(!!activateLogged, "Activate(3,4) arrives at the app")

    // ── the menu ─────────────────────────────────────────────────────────────
    section("dbusmenu → GMenuModel")

    const model = item.menu_model
    if (!check(!!model, "the item exposes a menu model")) { fake.kill(); return finish() }

    const modelObj = model
    let itemsChanged = 0
    try { model.connect("items-changed", () => { itemsChanged++ }) } catch { }

    await item.about_to_show()
    await until(() => flatten(model).length > 0, 4000)

    const rows = flatten(model)
    print(`  rows: ${JSON.stringify(rows)}`)

    check(rows.includes("Open Fake App"), "a normal row is present")
    check(!rows.includes("Invisible row"), "a `visible: false` row is dropped")
    check(rows.includes("|"), "a separator becomes a section break")
    check(rows.includes("Mute notifications"), "a checkmark row is present")
    check(rows.includes("Nested row"), "a submenu keeps its children")
    check(rows.includes("Deeper row"), "a THIRD nesting level arrives too")
    check(
        rows.indexOf("Open Fake App") < rows.indexOf("Mute notifications")
        && rows.indexOf("Mute notifications") < rows.indexOf("Quit Fake App"),
        "row order is preserved",
    )

    const acts = actionNames(item.action_group)
    check(acts.length >= 5, "the action group carries one action per row", acts.join(" "))

    // The click has to LAND. Activating the action must produce an Event on the
    // wire — this is the check that a menu wired to nothing would fail.
    const quitAction = acts.find(a => a.endsWith("9"))
    if (check(!!quitAction, "the Quit row has an action", String(quitAction))) {
        try { item.action_group.activate_action(quitAction, null) } catch (e) { print(`  (activate threw: ${e})`) }
        const evented = await until(async () => (await fake.log()).some(l => l === "Event 9 clicked"), 3000)
        check(!!evented, "activating the action sends Event(9, clicked) to the app")
    }

    // AboutToShow is what lets an app refresh its rows before they are drawn.
    check((await fake.log()).some(l => l.startsWith("AboutToShow")), "AboutToShow reached the app")

    // ONE GetLayout, for the WHOLE tree. The translator walked it a level at a
    // time; "Nested row" above already proves depth > 1 arrived, and this proves
    // it took a single round trip to get there.
    const layoutCalls = (await fake.log()).filter(l => l.startsWith("GetLayout"))
    print(`  GetLayout calls: ${JSON.stringify(layoutCalls)}`)
    check(
        !ASTAL_CONTROL ? layoutCalls.some(l => l.includes("depth=-1")) : true,
        "the layout is fetched with recursionDepth=-1",
        layoutCalls[0] ?? "(none)",
    )

    // ── incremental updates ──────────────────────────────────────────────────
    section("menu updates in place")

    const before = itemsChanged
    await fake.call("SetLabel", new GLib.Variant("(is)", [1, "Relabelled"]), null)
    const relabelled = await until(() => flatten(model).includes("Relabelled"), 4000)
    check(!!relabelled, "ItemsPropertiesUpdated rebuilds the model", JSON.stringify(flatten(model)))
    check(item.menu_model === modelObj, "the model OBJECT is stable across rebuilds")
    check(itemsChanged > before, "the rebuild emits items-changed", `${before} → ${itemsChanged}`)

    await fake.quit()
    check(await until(() => !tray.getItem(itemId), 4000), "an app that exits drops its item")

    // ── pixmap-only item ─────────────────────────────────────────────────────
    section("pixmap-only item (ARGB32 network order)")

    const pixFake = new Fake(["--pixmap", "--id", "pixonly"])
    const pixId = `${pixFake.resolveBusName()}/StatusNotifierItem`
    const pixItem = await until(() => tray.getItem(pixId), 6000)
    if (check(!!pixItem, "an item with no IconName still registers")) {
        const pixbuf = pixItem.gicon
        if (check(!!pixbuf?.get_pixels, "its gicon is a decoded pixbuf", String(pixbuf))) {
            check(pixbuf.get_width() === 2 && pixbuf.get_height() === 2,
                "the pixbuf has the sent dimensions", `${pixbuf.get_width()}x${pixbuf.get_height()}`)
            const px = pixbuf.get_pixels()
            // Sent ARGB = ff ff 00 00 (opaque red). As RGBA that is ff 00 00 ff.
            check(
                px[0] === 0xff && px[1] === 0x00 && px[2] === 0x00 && px[3] === 0xff,
                "pixel 0 is opaque RED — the ARGB→RGBA rotation is right",
                `rgba(${px[0]},${px[1]},${px[2]},${px[3]})`,
            )
        }
    }
    await pixFake.quit()

    // ── two items from one connection ────────────────────────────────────────
    section("one app, two items")

    const twoFake = new Fake(["--two", "--id", "twoicons"])
    // Both of its items register by OBJECT PATH, so the watcher must take the bus
    // name from the caller — the ids carry its UNIQUE name, not its well-known one.
    // Find them by path suffix rather than guessing the connection name.
    const twoIds = () => tray.items.map(i => i.item_id).filter(id => id.includes("/StatusNotifierItem"))
    await until(() => twoIds().length >= 2, 6000)
    const found = twoIds()
    print(`  ids: ${JSON.stringify(found)}`)
    const idA = found.find(i => i.endsWith("/StatusNotifierItem")) ?? ""
    const idB = found.find(i => i.endsWith("/StatusNotifierItem2")) ?? ""
    check(!!idA, "the first item registered", idA)
    // AstalTray's watcher keys its registry by bus name alone, so this second
    // registration overwrites the first entry instead of joining it.
    const twoRegistered = check(!!idB, "the SECOND item from the same connection registered", idB)
    check(idA.split("/")[0] === idB.split("/")[0], "both items report the same bus name",
        `${idA.split("/")[0]} / ${idB.split("/")[0]}`)

    twoFake.kill()
    const bothGone = await until(() => !tray.getItem(idA) && !tray.getItem(idB), 6000)
    // Guarded on the registration above: "both gone" is trivially true when the
    // second one never arrived, and a check that cannot fail is worth nothing.
    check(
        twoRegistered && !!bothGone,
        "killing the app removes BOTH of its items",
        twoRegistered
            ? `A:${tray.getItem(idA) ? "stuck" : "gone"} B:${tray.getItem(idB) ? "stuck" : "gone"}`
            : "(vacuous — the second item never registered)",
    )

    finish()
}

function finish(): never {
    print("")
    if (fail === 0) print(`PROBE-RESULT ALL PASS (${pass})`)
    else print(`PROBE-RESULT ${fail} FAILED, ${pass} passed`)
    imports.system.exit(fail === 0 ? 0 : 1)
}

// ⚠️ Start from an idle, not inline: a failed precondition calls exit() through
// `finish`/`die`, and a `loop.quit()` on a loop that is not running yet leaves
// the process hanging. (Same trap notifd-probe documents.)
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    main().catch(e => {
        print(`\nPROBE CRASHED: ${e}\n${e?.stack ?? ""}`)
        imports.system.exit(3)
    })
    return GLib.SOURCE_REMOVE
})

loop.run()
