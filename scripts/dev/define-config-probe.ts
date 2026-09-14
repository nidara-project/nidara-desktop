// define-config-probe.ts — exercises core/configFile.ts's settings store
// (defineSettings, GSettings) and two modules built on it (barState, NotifConfig).
//
// Run with (never gjs directly — the launcher is what keeps it off YOUR settings):
//   scripts/dev/define-config-probe.sh

import "./gtk-init"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { defineSettings, settingsSchemaProblems } from "../../ui/shell/core/configFile"
import { barConfig, barSettings, updateBarSettings, onBarSettingsChanged } from "../../ui/shell/surfaces/bar/barState"
import { notifConfig } from "../../ui/shell/core/NotifConfig"
import { registerConfigEntries } from "../../ui/shell/config-entries"
import widgetConfig from "../../ui/shell/core/WidgetConfig"
import ccLayout from "../../ui/shell/surfaces/control-center/CCLayoutManager"
import { pinnedState, savePinned, onPinnedChanged } from "../../ui/shell/surfaces/dock/state"
import regionConfig from "../../ui/shell/core/RegionConfig"
import { getConfigValue, setConfigValue, getConfigEntry } from "../../ui/shell/core/ConfigRegistry"

let totalChecks = 0
let passedChecks = 0

function assert(condition: boolean, message: string) {
    totalChecks++
    if (condition) {
        passedChecks++
        print(`  PASS  ${message}`)
    } else {
        printerr(`  FAIL  ${message}`)
        throw new Error(`Assertion failed: ${message}`)
    }
}

/** `gsettings get` in ANOTHER process: what the desktop sees, not our cache. */
function gsettingsGet(schema: string, key: string): string {
    Gio.Settings.sync()
    const [, out] = GLib.spawn_command_line_sync(`gsettings get ${schema} ${key}`)
    return new TextDecoder().decode(out).trim()
}

/** Change a key from ANOTHER process, then spin the loop until `until()` holds or
 *  the timeout passes — the store only hears it through the main loop. */
function gsettingsSetExternally(args: string, until: () => boolean, timeoutMs = 3000) {
    Gio.Settings.sync()
    GLib.spawn_command_line_async(`gsettings ${args}`)
    const loop = GLib.MainLoop.new(null, false)
    const started = Date.now()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        if (until() || Date.now() - started > timeoutMs) {
            loop.quit()
            return GLib.SOURCE_REMOVE
        }
        return GLib.SOURCE_CONTINUE
    })
    loop.run()
}

async function run() {
    if (GLib.getenv("NIDARA_DEFINE_CONFIG_PROBE") !== "1" || GLib.getenv("GSETTINGS_BACKEND") !== "keyfile") {
        printerr("define-config-probe: run it through scripts/dev/define-config-probe.sh — it writes settings")
        imports.system.exit(2)
    }

    print("=== 1. defineSettings (GSettings) ===")

    interface SettingsShape {
        num: number
        str: string
        flag: boolean
        someMap: Record<string, string>
        computedDir: string
    }
    const SETTINGS_DEFAULTS: SettingsShape = { num: 10, str: "initial", flag: false, someMap: {}, computedDir: "/computed" }
    const gs = defineSettings<SettingsShape>("probe-store", SETTINGS_DEFAULTS, { num: v => v >= 0 }, { computed: ["computedDir"] })
    const gsAll = gs.all

    assert(!settingsSchemaProblems().some(p => p.startsWith("org.nidara.probe-store")),
        `a schema that agrees with the code reports no problem (${settingsSchemaProblems().join("; ")})`)
    assert(gs.get("num") === 10 && gs.get("str") === "initial" && gs.get("flag") === false, "initial values are the defaults")
    assert(gs.get("computedDir") === "/computed", "a computed field the user never set reads the CODE default, not the schema placeholder")

    let gNum = 0, gStr = 0, gAll: string[] = []
    const unsubGNum = gs.subscribe("num", () => gNum++)
    const unsubGStr = gs.subscribe("str", () => gStr++)
    const unsubGAll = gs.subscribeAll(k => gAll.push(String(k)))

    gs.set("str", "changed-1")
    assert(gStr === 1 && gNum === 0, "set notifies its own key once and no other")
    assert(gAll.length === 1, "subscribeAll saw exactly one change — our own write's echo was swallowed")
    assert(gsettingsGet("org.nidara.probe-store", "str") === "'changed-1'", "the value reached GSettings (read from another process)")

    gs.set("num", 42)
    gs.set("num", 42)
    assert(gNum === 1, "an identical value does not notify")
    gs.set("num", 41.6)
    assert(gNum === 1 && gs.get("num") === 42, "a fractional value for an integer key is rounded BEFORE the equality check")

    gs.update({ num: 200, str: "batch" })
    assert(gNum === 2 && gStr === 2, "update notifies each changed key once")
    assert(gsettingsGet("org.nidara.probe-store", "num") === "200", "update persisted num")
    assert(gsettingsGet("org.nidara.probe-store", "str") === "'batch'", "update persisted str")
    gs.set("flag", true)
    assert(gsettingsGet("org.nidara.probe-store", "flag") === "true",
        "a set AFTER update() still persists (GSettings' delay() is permanent — this lost every later write once)")

    gs.set("someMap", { "2": "floating" })
    const storedMap = gsettingsGet("org.nidara.probe-store", "some-map")
    assert(storedMap === "{'2': 'floating'}", `a map is stored as a{ss} (got ${storedMap})`)
    assert(JSON.stringify(gs.get("someMap")) === '{"2":"floating"}', "a map reads back as an object")

    print("\n--- changes made by ANOTHER process ---")
    const before = gNum
    gsettingsSetExternally("set org.nidara.probe-store num 7", () => gs.get("num") === 7)
    assert(gs.get("num") === 7, "an external `gsettings set` reaches the store")
    assert(gNum === before + 1, "…and notifies its subscribers exactly once")
    assert(gs.all === gsAll && gsAll.num === 7, "…updating the SAME `all` object in place (the dock's read sites rely on its identity)")

    gsettingsSetExternally("set org.nidara.probe-store num -5", () => gs.get("num") === 10)
    assert(gs.get("num") === 10, "an external value the validator refuses falls back to the default")

    gsettingsSetExternally("set org.nidara.probe-store computed-dir \"'/chosen'\"", () => gs.get("computedDir") === "/chosen")
    assert(gs.get("computedDir") === "/chosen", "a computed field the user sets reads the user's value")
    gsettingsSetExternally("reset org.nidara.probe-store computed-dir", () => gs.get("computedDir") === "/computed")
    assert(gs.get("computedDir") === "/computed", "…and resetting it goes back to the computed default")

    print("\n--- two stores on one schema (the Settings app beside the shell) ---")
    const other = defineSettings<SettingsShape>("probe-store", SETTINGS_DEFAULTS, {}, { computed: ["computedDir"] })
    let otherStr = 0
    const unsubOther = other.subscribe("str", () => otherStr++)
    gsettingsSetExternally("get org.nidara.probe-store str", () => false, 1)   // settle
    const mine = gStr
    gs.set("str", "from-the-first")
    gsettingsSetExternally("get org.nidara.probe-store str", () => other.get("str") === "from-the-first")
    assert(other.get("str") === "from-the-first" && otherStr === 1, "a write through one store reaches the other, once")
    assert(gStr === mine + 1, "…and the writer notified its own subscribers once, not twice")

    unsubGNum(); unsubGStr(); unsubGAll(); unsubOther()

    print("\n--- failure policy ---")
    defineSettings<{ num: number; str: string }>("probe-drift", { num: 10, str: "x" })
    const drift = settingsSchemaProblems().filter(p => p.startsWith("org.nidara.probe-drift"))
    assert(drift.some(p => p.includes("num") && p.includes("default")), "[control] a schema default that disagrees with the code IS reported")
    assert(drift.some(p => p.includes("str") && p.includes("type")), "[control] a schema type that cannot hold the code's value IS reported")

    const missing = defineSettings<{ a: number }>("probe-not-installed", { a: 1 })
    missing.set("a", 2)
    assert(missing.get("a") === 2, "a store whose schema is not installed still works in memory (the desktop starts)")
    assert(settingsSchemaProblems().some(p => p.includes("probe-not-installed")), "…and the missing schema is reported")

    print("\n=== 2. Migrated module: surfaces/bar/barState.ts ===")

    const originalTitle = barConfig.get("showAppTitle")
    let barChangeCount = 0
    let barKeyChangeCount = 0

    const unsubBarAll = onBarSettingsChanged((s) => {
        barChangeCount++
    })

    const unsubBarTitle = barConfig.subscribe("showAppTitle", (val) => {
        barKeyChangeCount++
    })

    assert(barChangeCount === 0, "onBarSettingsChanged did not fire on subscribe")
    assert(barKeyChangeCount === 0, "barConfig.subscribe did not fire on subscribe")

    // Mutate showAppTitle
    const nextTitle = !originalTitle
    updateBarSettings({ showAppTitle: nextTitle })

    assert(barConfig.get("showAppTitle") === nextTitle, "barConfig.get reflects new showAppTitle")
    assert(barSettings.showAppTitle === nextTitle, "barSettings.showAppTitle reflects new showAppTitle")
    assert(barKeyChangeCount === 1, "barConfig.subscribe('showAppTitle') fired once")
    assert(barChangeCount === 1, "onBarSettingsChanged fired once")

    // Equality guard: update with same value
    updateBarSettings({ showAppTitle: nextTitle })
    assert(barKeyChangeCount === 1, "barConfig.subscribe did not fire on identical value")
    assert(barChangeCount === 1, "onBarSettingsChanged did not fire on identical value")

    // Restore original
    updateBarSettings({ showAppTitle: originalTitle })
    assert(barConfig.get("showAppTitle") === originalTitle, "restored original showAppTitle")
    assert(barKeyChangeCount === 2, "barConfig.subscribe fired on restore")

    unsubBarAll()
    unsubBarTitle()

    print("\n=== 3. Migrated module: core/NotifConfig.ts ===")

    const originalDnd = notifConfig.doNotDisturb
    const originalTimeout = notifConfig.popupTimeout

    let dndChangeCount = 0
    let timeoutChangeCount = 0
    let notifAllCount = 0

    const unsubDnd = notifConfig.subscribe("doNotDisturb", () => {
        dndChangeCount++
    })

    const unsubTimeout = notifConfig.subscribe("popupTimeout", () => {
        timeoutChangeCount++
    })

    const unsubNotifAll = notifConfig.onChange((k) => {
        notifAllCount++
    })

    assert(dndChangeCount === 0, "subscribe('doNotDisturb') did not fire on subscribe")
    assert(timeoutChangeCount === 0, "subscribe('popupTimeout') did not fire on subscribe")
    assert(notifAllCount === 0, "onChange did not fire on subscribe")

    // Mutate popupTimeout: dnd listener MUST NOT FIRE
    const nextTimeout = originalTimeout === 6 ? 8 : 6
    notifConfig.setPopupTimeout(nextTimeout)

    assert(timeoutChangeCount === 1, "timeout listener fired once")
    assert(dndChangeCount === 0, "dnd listener did NOT fire when popupTimeout changed")
    assert(notifAllCount === 1, "onChange fired once for popupTimeout")
    assert(notifConfig.popupTimeout === nextTimeout, "popupTimeout updated")
    assert(notifConfig.popupTimeoutMs === nextTimeout * 1000, "popupTimeoutMs updated")

    // Equality guard on setPopupTimeout
    notifConfig.setPopupTimeout(nextTimeout)
    assert(timeoutChangeCount === 1, "timeout listener did NOT fire on identical setPopupTimeout")
    assert(notifAllCount === 1, "onChange did NOT fire on identical setPopupTimeout")

    // Mutate doNotDisturb: timeout listener MUST NOT FIRE
    const nextDnd = !originalDnd
    notifConfig.setDoNotDisturb(nextDnd)

    assert(dndChangeCount === 1, "dnd listener fired once")
    assert(timeoutChangeCount === 1, "timeout listener did NOT fire when doNotDisturb changed")
    assert(notifAllCount === 2, "onChange fired once for doNotDisturb")
    assert(notifConfig.doNotDisturb === nextDnd, "doNotDisturb updated")

    // Equality guard on setDoNotDisturb
    notifConfig.setDoNotDisturb(nextDnd)
    assert(dndChangeCount === 1, "dnd listener did NOT fire on identical setDoNotDisturb")
    assert(notifAllCount === 2, "onChange did NOT fire on identical setDoNotDisturb")

    // Restore original values
    notifConfig.setPopupTimeout(originalTimeout)
    notifConfig.setDoNotDisturb(originalDnd)
    assert(notifConfig.popupTimeout === originalTimeout, "restored original popupTimeout")
    assert(notifConfig.doNotDisturb === originalDnd, "restored original doNotDisturb")

    unsubDnd()
    unsubTimeout()
    unsubNotifAll()

    assert(!settingsSchemaProblems().some(p => /org\.nidara\.(bar|notifications)\b/.test(p)),
        "the shipped schema agrees with barState and NotifConfig")

    print("\n=== 4. ConfigRegistry end-to-end integration ===")
    registerConfigEntries()

    const barEntry = getConfigEntry("bar.appTitle")
    assert(barEntry !== undefined, "bar.appTitle is registered in ConfigRegistry")
    assert(typeof barEntry!.subscribe === "function", "bar.appTitle has a subscribe function")

    let barExtCount = 0
    let lastExtTitle = false
    const unsubBarExt = barEntry!.subscribe!((val) => {
        barExtCount++
        lastExtTitle = Boolean(val)
    })
    // subscribe() helper applies initial value
    assert(barExtCount === 1, "bar.appTitle subscribe helper applied initial value")
    assert(lastExtTitle === barConfig.get("showAppTitle"), "applied initial value matches barConfig.get")

    // Change bar.appTitle via setConfigValue
    const currBar = barConfig.get("showAppTitle")
    const changedBar = !currBar
    await setConfigValue("bar.appTitle", changedBar.toString())
    assert(barExtCount === 2, "bar.appTitle subscriber received update from setConfigValue")
    assert(lastExtTitle === changedBar, "subscriber received new value")
    assert(barConfig.get("showAppTitle") === changedBar, "barConfig reflects new value")
    assert(barSettings.showAppTitle === changedBar, "barSettings reflects new value")

    assert(gsettingsGet("org.nidara.bar", "show-app-title") === String(changedBar), "org.nidara.bar show-app-title was persisted")

    // Restore
    await setConfigValue("bar.appTitle", currBar.toString())
    assert(barConfig.get("showAppTitle") === currBar, "bar.appTitle restored")
    unsubBarExt()

    // Test notifications.popupTimeout
    const notifTimeoutEntry = getConfigEntry("notifications.popupTimeout")
    assert(notifTimeoutEntry !== undefined, "notifications.popupTimeout is registered")
    let timeoutExtCount = 0
    let lastExtTimeout = 0
    const unsubTimeoutExt = notifTimeoutEntry!.subscribe!((val) => {
        timeoutExtCount++
        lastExtTimeout = Number(val)
    })
    assert(timeoutExtCount === 1, "popupTimeout subscribe applied initial value")

    const currTimeout = notifConfig.popupTimeout
    const targetTimeout = currTimeout === 6 ? 9 : 6
    await setConfigValue("notifications.popupTimeout", targetTimeout.toString())
    assert(timeoutExtCount === 2, "popupTimeout subscriber received update")
    assert(lastExtTimeout === targetTimeout, "subscriber received new timeout")
    assert(notifConfig.popupTimeout === targetTimeout, "notifConfig.popupTimeout is targetTimeout")

    assert(gsettingsGet("org.nidara.notifications", "popup-timeout") === String(targetTimeout), "org.nidara.notifications popup-timeout was persisted")

    // Restore
    await setConfigValue("notifications.popupTimeout", currTimeout.toString())
    assert(notifConfig.popupTimeout === currTimeout, "popupTimeout restored")
    unsubTimeoutExt()

    // Test notifications.doNotDisturb
    const dndEntry = getConfigEntry("notifications.doNotDisturb")
    assert(dndEntry !== undefined, "notifications.doNotDisturb is registered")
    let dndExtCount = 0
    let lastExtDnd = false
    const unsubDndExt = dndEntry!.subscribe!((val) => {
        dndExtCount++
        lastExtDnd = Boolean(val)
    })
    assert(dndExtCount === 1, "doNotDisturb subscribe applied initial value")

    const currDnd = notifConfig.doNotDisturb
    const targetDnd = !currDnd
    await setConfigValue("notifications.doNotDisturb", targetDnd.toString())
    assert(dndExtCount === 2, "doNotDisturb subscriber received update")
    assert(lastExtDnd === targetDnd, "subscriber received new dnd")
    assert(notifConfig.doNotDisturb === targetDnd, "notifConfig.doNotDisturb is targetDnd")

    assert(gsettingsGet("org.nidara.notifications", "do-not-disturb") === String(targetDnd), "org.nidara.notifications do-not-disturb was persisted")

    // Restore
    await setConfigValue("notifications.doNotDisturb", currDnd.toString())
    assert(notifConfig.doNotDisturb === currDnd, "doNotDisturb restored")
    unsubDndExt()

    print("\n=== 5. The structured stores: widgets, CC layout, pins, region ===")
    assert(!settingsSchemaProblems().some(p => /org\.nidara\.(widgets|control-center|dock|region)\b/.test(p)),
        `the shipped schema agrees with WidgetConfig, CCLayoutManager, the pin store and RegionConfig (${settingsSchemaProblems().join("; ")})`)

    // Widget placement: a map of tuples, merged over the registry's defaults.
    const firstWidget = widgetConfig.allIds()[0]
    const wasBar = widgetConfig.get(firstWidget).bar
    widgetConfig.setBar(firstWidget, !wasBar)
    const placement = gsettingsGet("org.nidara.widgets", "placement")
    assert(placement.includes(`'${firstWidget}': (${!wasBar}, `), `setBar persists as a (bar, cc) tuple (${placement.slice(0, 80)}…)`)
    let widgetChanges = 0
    widgetConfig.connect("changed", () => widgetChanges++)
    gsettingsSetExternally(`set org.nidara.widgets placement "{'${firstWidget}': (${wasBar}, true)}"`, () => widgetConfig.get(firstWidget).bar === wasBar)
    assert(widgetConfig.get(firstWidget).bar === wasBar && widgetConfig.get(firstWidget).cc === true, "an external placement change reaches WidgetConfig")
    assert(widgetChanges === 1, `…and emits "changed" once (${widgetChanges})`)

    // Pins: order kept, a caller's in-place push still writes, one notification.
    let pinChanges = 0
    const unsubPins = onPinnedChanged(() => pinChanges++)
    pinnedState.list.push("probe-app")
    savePinned()
    assert(gsettingsGet("org.nidara.dock", "pinned").endsWith("'probe-app']"), "a pin pushed in place and saved reaches GSettings, at the end")
    assert(pinChanges === 1, `…and notifies once (${pinChanges})`)
    gsettingsSetExternally(`set org.nidara.dock pinned "['b-app', 'a-app']"`, () => pinnedState.list.join() === "b-app,a-app")
    assert(pinnedState.list.join() === "b-app,a-app", "an external pin change replaces the list, in its order")
    assert(pinChanges === 2, `…and notifies once more (${pinChanges})`)
    unsubPins()

    // CC layout: positions as (x, y), reloaded on an external change.
    const tile = ccLayout.layout[0]?.id
    assert(!!tile, "the CC layout has a default tile to move")
    ccLayout.remove(tile)
    assert(!gsettingsGet("org.nidara.control-center", "positions").includes(`'${tile}'`), "removing a tile persists positions without it")
    let layoutChanges = 0
    ccLayout.connect("changed", () => layoutChanges++)
    gsettingsSetExternally(`set org.nidara.control-center positions "{'${tile}': (0, 0)}"`, () => ccLayout.layout.some(e => e.id === tile))
    assert(ccLayout.layout.length === 1 && ccLayout.layout[0].id === tile, "an external positions change reloads the layout")
    assert(layoutChanges === 1, `…and emits "changed" once (${layoutChanges})`)

    // Region: the clock format is stored; the mirror follows; timezone is the system's.
    let regionChanges = 0
    regionConfig.connect("changed", () => regionChanges++)
    regionConfig.setTimeFormat("12h")
    assert(gsettingsGet("org.nidara.region", "time-format") === "'12h'", "setTimeFormat persists")
    assert(regionChanges === 1, `…and emits "changed" once (${regionChanges})`)
    const mirrorDir = GLib.getenv("NIDARA_GREETER_MIRROR_DIR")!
    const [, mirrorBytes] = GLib.file_get_contents(`${mirrorDir}/region.json`)
    assert(JSON.parse(new TextDecoder().decode(mirrorBytes)).timeFormat === "12h", "the greeter mirror follows, in the probe's own mirror dir")
    gsettingsSetExternally("set org.nidara.region show-seconds true", () => regionConfig.showSeconds)
    assert(regionConfig.showSeconds && regionChanges === 2, "an external clock change reaches RegionConfig and emits once")
    assert(!gsettingsGet("org.nidara.region", "timezone").startsWith("'"), "the timezone is not a stored key")

    print(`\n========================================`)
    print(`ALL CHECKS PASSED: ${passedChecks}/${totalChecks}`)
    print(`========================================`)
}

run().catch((e) => {
    printerr(`ERROR: ${e}`)
    imports.system.exit(1)
})
