// notifd-probe.ts — exercises core/notifd.ts (the AstalNotifd replacement) as a
// REAL notification server: the probe brings the module up, and then talks to it
// over D-Bus exactly as `notify-send` does, from the outside.
//
//   ags bundle --gtk 4 scripts/dev/notifd-probe.ts /tmp/notifd-probe
//   XDG_CACHE_HOME=$(mktemp -d) dbus-run-session -- /tmp/notifd-probe
//
// ⚠️ Both wrappers are load-bearing, and the probe refuses to run without them:
//
//   - `dbus-run-session` gives it a private bus. On the real session bus the
//     SHELL owns org.freedesktop.Notifications, so the probe would lose that
//     race and test nothing.
//   - `XDG_CACHE_HOME` points the store somewhere disposable. Without it the
//     probe would write its test notifications into the user's own
//     ~/.cache/nidara/notifd/state.json, and they would show up in the NC.
//
// ⚠️ Prove it can FAIL before believing a green run. TWO controls, and they fail
// for DIFFERENT reasons — a probe whose controls die the same way is only
// testing one thing:
//
//     XDG_CACHE_HOME=$(mktemp -d) DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent /tmp/notifd-probe
//         → "the session bus is reachable" fails, and nothing else runs.
//
//     XDG_CACHE_HOME=$(mktemp -d) /tmp/notifd-probe          # no dbus-run-session
//         → the bus is fine and the name is TAKEN (by the running shell).
//           "we own org.freedesktop.Notifications" fails. That is exactly the
//           state a user gets when dunst or mako is left running, and the
//           distinction from the first control is the point: an empty roster
//           looks identical either way.
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import { getDefault, ClosedReason, Urgency } from "../../ui/shell/core/notifd"

const BUS_NAME = "org.freedesktop.Notifications"
const BUS_PATH = "/org/freedesktop/Notifications"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++; else fail++
    print(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise<void>(r => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE })
})

// ── The client half ──────────────────────────────────────────────────────────
//
// Every call is ASYNC on purpose. The probe is the server too, so a `call_sync`
// would block the main loop that has to dispatch the very method being called —
// the first version of this file deadlocked on its own first Notify.

let conn: any = null

function call(method: string, params: any, replyType: string | null): Promise<any> {
    return new Promise((resolve, reject) => {
        conn.call(BUS_NAME, BUS_PATH, BUS_NAME, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, 3000, null,
            (c: any, res: any) => {
                try { resolve(c.call_finish(res).deepUnpack()) } catch (e) { reject(e) }
            })
    })
}

/** `Notify` as a sender writes it. `hints` is a plain object of GLib.Variants —
 *  GJS packs `a{sv}` from a JS object, never from a pre-built variant. */
function notify(opts: {
    app?: string, replaces?: number, icon?: string, summary?: string, body?: string,
    actions?: string[], hints?: Record<string, any>, timeout?: number,
}): Promise<number> {
    return call("Notify", new GLib.Variant("(susssasa{sv}i)", [
        opts.app ?? "probe", opts.replaces ?? 0, opts.icon ?? "",
        opts.summary ?? "summary", opts.body ?? "body",
        opts.actions ?? [], opts.hints ?? {}, opts.timeout ?? -1,
    ]), "(u)").then(r => r[0])
}

// Signals the sender is supposed to receive, recorded as they arrive.
const closed: { id: number, reason: number }[] = []
const invoked: { id: number, action: string }[] = []

function watchSignals(): void {
    conn.signal_subscribe(null, BUS_NAME, "NotificationClosed", BUS_PATH, null,
        Gio.DBusSignalFlags.NONE,
        (_c: any, _s: any, _p: any, _i: any, _n: any, params: any) => {
            const [id, reason] = params.deepUnpack()
            closed.push({ id, reason })
        })
    conn.signal_subscribe(null, BUS_NAME, "ActionInvoked", BUS_PATH, null,
        Gio.DBusSignalFlags.NONE,
        (_c: any, _s: any, _p: any, _i: any, _n: any, params: any) => {
            const [id, action] = params.deepUnpack()
            invoked.push({ id, action })
        })
}

const closedFor = (id: number) => closed.find(c => c.id === id)

/** `(iiibiiay)` — the raw-pixel hint. Solid colour, so the content hash is
 *  deterministic and check 11 can assert de-duplication. */
function imageDataVariant(w: number, h: number, tint: number): any {
    const px = new Uint8Array(w * h * 3)
    for (let i = 0; i < px.length; i += 3) { px[i] = tint; px[i + 1] = 64; px[i + 2] = 200 }
    return new GLib.Variant("(iiibiiay)", [w, h, w * 3, false, 8, 3, px])
}

// ── Preconditions ────────────────────────────────────────────────────────────
//
// These fail HARD rather than counting as checks. Both controls above land here,
// and they must land on DIFFERENT lines — "no bus" and "somebody else is the
// notification server" produce the same empty roster otherwise, which is how a
// probe ends up reporting a cheerful green while testing nothing.

function preconditions(): boolean {
    const cache = GLib.get_user_cache_dir()
    if (cache === `${GLib.get_home_dir()}/.cache`) {
        print("REFUSING: XDG_CACHE_HOME is unset, so the probe would write into the")
        print("          user's own ~/.cache/nidara/notifd. Re-run as:")
        print("          XDG_CACHE_HOME=$(mktemp -d) dbus-run-session -- /tmp/notifd-probe")
        return false
    }

    try {
        conn = Gio.bus_get_sync(Gio.BusType.SESSION, null)
    } catch (e) {
        print(`FAIL (precondition)  the session bus is reachable  — ${e}`)
        return false
    }
    print(`  ok    session bus reachable, store at ${cache}/nidara/notifd`)
    return true
}

function weOwnTheName(): boolean {
    try {
        const owner = conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetNameOwner",
            new GLib.Variant("(s)", [BUS_NAME]), new GLib.VariantType("(s)"),
            Gio.DBusCallFlags.NONE, 2000, null).deepUnpack()[0]
        if (owner !== conn.get_unique_name()) {
            print(`FAIL (precondition)  we own ${BUS_NAME}  — held by ${owner}, not us (${conn.get_unique_name()})`)
            print("                     another notification daemon is running on this bus")
            return false
        }
    } catch (e) {
        print(`FAIL (precondition)  we own ${BUS_NAME}  — nobody does: ${e}`)
        return false
    }
    print(`  ok    ${BUS_NAME} is ours`)
    return true
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    print("notifd-probe — core/notifd.ts against a live D-Bus\n")

    if (!preconditions()) return finish(true)

    const daemon = getDefault()
    const notified: { id: number, replaced: boolean }[] = []
    const resolved: { id: number, reason: number }[] = []
    daemon.onNotified((id, replaced) => notified.push({ id, replaced }))
    daemon.onResolved((id, reason) => resolved.push({ id, reason }))

    // The name is claimed through the main loop, so give it a turn to land.
    await sleep(300)
    if (!weOwnTheName()) return finish(true)
    watchSignals()

    print("\n── the D-Bus contract ──")

    const info = await call("GetServerInformation", null, "(ssss)")
    check("GetServerInformation names Nidara", info[0] === "nidara" && info[3] === "1.2",
        JSON.stringify(info))

    const caps: string[] = (await call("GetCapabilities", null, "(as)"))[0]
    check("capabilities include what the card actually does",
        ["actions", "body", "body-markup", "body-images", "icon-static", "persistence"]
            .every(c => caps.includes(c)), caps.join(","))
    // The three AstalNotifd claimed and Nidara does not honour. `sound` is the
    // one that matters: a client that believes it suppresses its OWN sound, and
    // the notification simply arrives silent with nothing logged anywhere.
    check("capabilities do NOT promise sound / action-icons / body-hyperlinks",
        !caps.includes("sound") && !caps.includes("action-icons") && !caps.includes("body-hyperlinks"))

    print("\n── receiving ──")

    const id1 = await notify({
        app: "Probe App", icon: "dialog-information", summary: "hello", body: "world",
        actions: ["ok", "Accept", "no", "Decline"],
        hints: {
            urgency: new GLib.Variant("y", Urgency.CRITICAL),
            "desktop-entry": new GLib.Variant("s", "org.probe.App"),
            category: new GLib.Variant("s", "im.received"),
        },
        timeout: 0,
    })
    check("Notify hands back an id, counting from 1", id1 === 1, `id=${id1}`)

    const n1 = daemon.getNotification(id1)
    check("the notification is in the list", !!n1 && daemon.notifications.length === 1)
    check("fields round-trip",
        n1?.app_name === "Probe App" && n1?.app_icon === "dialog-information"
        && n1?.summary === "hello" && n1?.body === "world" && n1?.expire_timeout === 0)
    check("actions parse into id/label pairs",
        JSON.stringify(n1?.get_actions()) === JSON.stringify([
            { id: "ok", label: "Accept" }, { id: "no", label: "Decline" }]),
        JSON.stringify(n1?.get_actions()))
    // `urgency` is a BYTE on the wire; senders exist that write it as int64, and
    // both have to arrive as the same JS number.
    check("byte hints unpack to numbers", n1?.urgency === Urgency.CRITICAL, `urgency=${n1?.urgency}`)
    check("string hints read through their accessors",
        n1?.desktop_entry === "org.probe.App" && n1?.category === "im.received")
    check("`time` is a unix SECONDS stamp",
        !!n1 && Math.abs(n1.time - Math.floor(Date.now() / 1000)) <= 2, `time=${n1?.time}`)
    check("onNotified fired once, not as a replacement",
        notified.length === 1 && notified[0].id === id1 && notified[0].replaced === false)

    const id1b = await notify({ app: "Probe App", replaces: id1, summary: "hello again" })
    check("replaces_id reuses the id instead of adding a row",
        id1b === id1 && daemon.notifications.length === 1
        && daemon.getNotification(id1)?.summary === "hello again")
    check("onNotified reports the replacement AS a replacement",
        notified.length === 2 && notified[1].replaced === true)

    // 🔑 The spec says a non-zero replaces_id comes back unchanged, and
    // AstalNotifd only honoured it while the notification was still live. An app
    // driving a progress notification keeps sending the SAME id, so once the user
    // dismisses it every further update used to become a NEW row.
    daemon.getNotification(id1)?.dismiss()
    await sleep(50)
    const idRevived = await notify({ app: "Probe App", replaces: id1, summary: "back again" })
    check("replaces_id is honoured even after that notification was dismissed",
        idRevived === id1 && daemon.getNotification(id1)?.summary === "back again",
        `asked for ${id1}, got ${idRevived}`)
    const idAfter = await notify({ app: "Probe App", summary: "fresh" })
    check("…and the id sequence moves past an adopted id instead of colliding",
        idAfter > id1, `next=${idAfter}`)

    print("\n── images ──")

    const idImg = await notify({ app: "Pixels", hints: { "image-data": imageDataVariant(64, 64, 10) } })
    const nImg = daemon.getNotification(idImg)
    const imgPath = nImg?.image ?? ""
    check("image-data is decoded to a file and re-hinted as image-path",
        imgPath.startsWith(GLib.get_user_cache_dir()) && GLib.file_test(imgPath, GLib.FileTest.EXISTS),
        imgPath)
    const [fmt, w, h] = GdkPixbuf.Pixbuf.get_file_info(imgPath)
    check("the decoded file is a 64×64 PNG", fmt?.get_name?.() === "png" && w === 64 && h === 64,
        `${fmt?.get_name?.()} ${w}×${h}`)

    const idImg2 = await notify({ app: "Pixels", hints: { "image-data": imageDataVariant(64, 64, 10) } })
    check("the same pixels land on the same cached file (content hash, not a counter)",
        daemon.getNotification(idImg2)?.image === imgPath)

    // The 1.1 spelling. Chrome sends BOTH on every notification; AstalNotifd read
    // only the modern one, so a sender using the old name lost its hero silently.
    const idLegacy = await notify({ app: "Old", hints: { image_path: new GLib.Variant("s", "/tmp/legacy.png") } })
    check("the legacy `image_path` spelling is still read",
        daemon.getNotification(idLegacy)?.image === "/tmp/legacy.png")

    print("\n── resolution ──")

    await call("CloseNotification", new GLib.Variant("(u)", [idLegacy]), null)
    await sleep(50)
    check("CloseNotification removes it and tells the sender (reason CLOSED)",
        !daemon.getNotification(idLegacy) && closedFor(idLegacy)?.reason === ClosedReason.CLOSED,
        JSON.stringify(closedFor(idLegacy)))

    daemon.getNotification(idImg)?.dismiss()
    await sleep(50)
    check("dismiss() resolves as DISMISSED_BY_USER",
        !daemon.getNotification(idImg) && closedFor(idImg)?.reason === ClosedReason.DISMISSED)

    const beforeStray = closed.length
    daemon.getNotification(idImg)?.dismiss()   // already gone
    const stray = daemon.notifications.length
    await sleep(50)
    check("dismissing an already-resolved notification is a silent no-op",
        closed.length === beforeStray && daemon.notifications.length === stray)

    const idFast = await notify({ app: "Timer", timeout: 200 })
    check("a positive expire_timeout is still live immediately", !!daemon.getNotification(idFast))
    await sleep(400)
    check("…and the server expires it on its own (reason EXPIRED)",
        !daemon.getNotification(idFast) && closedFor(idFast)?.reason === ClosedReason.EXPIRED,
        JSON.stringify(closedFor(idFast)))

    // 0 means "never", and the banner layer applies notifConfig.popupTimeout to
    // the BANNER — the card itself stays until the user clears it.
    const idNever = await notify({ app: "Sticky", timeout: 0 })
    await sleep(400)
    check("expire_timeout 0 is never expired by the server", !!daemon.getNotification(idNever))

    print("\n── actions ──")

    const idAct = await notify({ app: "Buttons", actions: ["ok", "Accept"] })
    daemon.getNotification(idAct)?.invoke("ok")
    await sleep(50)
    check("invoke() reaches the sender as ActionInvoked",
        invoked.some(i => i.id === idAct && i.action === "ok"), JSON.stringify(invoked))
    check("…and resolves the notification, since it is not resident",
        !daemon.getNotification(idAct) && closedFor(idAct)?.reason === ClosedReason.CLOSED)

    const idRes = await notify({
        app: "Resident", actions: ["more", "More"],
        hints: { resident: new GLib.Variant("b", true) },
    })
    daemon.getNotification(idRes)?.invoke("more")
    await sleep(50)
    check("a `resident` notification survives its own action",
        invoked.some(i => i.id === idRes) && !!daemon.getNotification(idRes))

    print("\n── persistence ──")

    const idTransient = await notify({ app: "Ghost", hints: { transient: new GLib.Variant("b", true) } })
    check("the transient hint is readable", daemon.getNotification(idTransient)?.transient === true)
    // The store is debounced (a burst of ten writes the file once), so wait for it.
    await sleep(250)

    const storePath = `${GLib.get_user_cache_dir()}/nidara/notifd/state.json`
    check("the store exists", GLib.file_test(storePath, GLib.FileTest.EXISTS), storePath)
    let stored: any = null
    try {
        const [ok, bytes] = GLib.file_get_contents(storePath)
        if (ok) stored = JSON.parse(new TextDecoder().decode(bytes))
    } catch (e) { /* reported by the checks below */ }
    const storedIds: number[] = (stored?.notifications ?? []).map((n: any) => n.id)
    check("live notifications are in it", storedIds.includes(idNever) && storedIds.includes(idRes),
        JSON.stringify(storedIds))
    check("resolved ones are not", !storedIds.includes(idAct) && !storedIds.includes(idFast))
    // freedesktop: transient means "excluded from persistence". It is the one
    // hint that changes what the store contains.
    check("a transient notification is excluded from the store", !storedIds.includes(idTransient))
    const storedRes = (stored?.notifications ?? []).find((n: any) => n.id === idRes)
    check("stored rows keep their actions and hints",
        JSON.stringify(storedRes?.actions) === JSON.stringify([{ id: "more", label: "More" }])
        && storedRes?.hints?.resident === true, JSON.stringify(storedRes))

    finish()
}

function finish(hard = false): void {
    if (hard) fail++
    print(`\n${pass} passed, ${fail} failed`)
    loop.quit()
}

const loop = GLib.MainLoop.new(null, false)
// Started from an idle, not straight away: `main()` runs synchronously until its
// first `await`, and the precondition checks come BEFORE that. A failing
// precondition therefore called `loop.quit()` on a loop that had not started yet,
// and the run() below hung forever — the two controls looked like a probe that
// never finishes instead of a probe that refuses to.
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    main().catch(e => {
        print(`\nprobe threw: ${e}\n${e?.stack ?? ""}`)
        finish(true)
    })
    return GLib.SOURCE_REMOVE
})
loop.run()

// Exit status AFTER the loop, never from inside the promise chain: `finish()` is
// reached from the async body, and an `imports.system.exit` throwing in there is
// caught by main()'s own .catch — which calls finish() again. Same placement as
// wp-probe.ts. A probe that always exits 0 cannot gate anything.
imports.system.exit(fail === 0 ? 0 : 1)
