// define-config-probe.ts — exercises core/configFile.ts (defineConfig) and the
// migrated modules (barState, NotifConfig).
//
// Run with:
//   scripts/bundle.sh --js scripts/dev/define-config-probe.ts /tmp/define-config-probe.js
//   gjs -m /tmp/define-config-probe.js

import "./gtk-init"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { defineConfig } from "../../ui/shell/core/configFile"
import { readFile, writeFile } from "../../ui/lib/file"
import { barConfig, barSettings, updateBarSettings, onBarSettingsChanged } from "../../ui/shell/surfaces/bar/barState"
import { notifConfig } from "../../ui/shell/core/NotifConfig"
import { registerConfigEntries } from "../../ui/shell/config-entries"
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

function getFileMtime(path: string): string {
    const file = Gio.File.new_for_path(path)
    const info = file.query_info("time::modified,time::modified-usec", Gio.FileQueryInfoFlags.NONE, null)
    const sec = info.get_attribute_uint64("time::modified")
    const usec = info.get_attribute_uint32("time::modified-usec")
    return `${sec}.${usec}`
}

function sleep(ms: number) {
    const loop = GLib.MainLoop.new(null, false)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit()
        return GLib.SOURCE_REMOVE
    })
    loop.run()
}

async function run() {
    print("=== 1. Isolated defineConfig tests ===")

    const testFileName = "__probe_define_config_test__.json"
    const testFilePath = `${GLib.get_user_config_dir()}/nidara/${testFileName}`

    // Clean up any stale file
    try {
        const f = Gio.File.new_for_path(testFilePath)
        if (f.query_exists(null)) f.delete(null)
    } catch {}

    interface TestSchema {
        num: number
        str: string
        flag: boolean
    }

    const DEFAULTS: TestSchema = {
        num: 10,
        str: "initial",
        flag: false,
    }

    const store = defineConfig(testFileName, DEFAULTS)

    // Check initial values
    assert(store.get("num") === 10, "initial get(num) matches default")
    assert(store.get("str") === "initial", "initial get(str) matches default")
    assert(store.get("flag") === false, "initial get(flag) matches default")
    assert(store.all.num === 10, "store.all.num matches default")

    let countNum = 0
    let lastNumVal = 0
    let countStr = 0
    let lastStrVal = ""
    let allEvents: string[] = []

    const unsubNum = store.subscribe("num", (v) => {
        countNum++
        lastNumVal = v
    })

    const unsubStr = store.subscribe("str", (v) => {
        countStr++
        lastStrVal = v
    })

    const unsubAll = store.subscribeAll((k) => {
        allEvents.push(String(k))
    })

    // Assert subscribing did NOT invoke callbacks immediately
    assert(countNum === 0, "subscribing to 'num' did not run callback immediately")
    assert(countStr === 0, "subscribing to 'str' did not run callback immediately")
    assert(allEvents.length === 0, "subscribeAll did not run callback immediately")

    // 1. Change 'str' -> 'num' callback must NOT run!
    print("\n--- Key isolation test: mutate 'str', assert 'num' listener is silent ---")
    store.set("str", "changed-1")
    assert(countNum === 0, "callback for 'num' did NOT run when 'str' changed")
    assert(countStr === 1, "callback for 'str' ran exactly once")
    assert(lastStrVal === "changed-1", "callback for 'str' received new value")
    assert(store.get("str") === "changed-1", "get('str') returns updated value")
    assert(store.all.str === "changed-1", "store.all.str reflects updated value")
    assert(allEvents.length === 1 && allEvents[0] === "str", "subscribeAll saw 'str'")

    // 2. Change 'num' -> 'num' callback must run once
    print("\n--- Mutate 'num', assert 'num' listener runs once ---")
    store.set("num", 42)
    assert(countNum === 1, "callback for 'num' ran exactly once")
    assert(lastNumVal === 42, "callback for 'num' received new value")
    assert(countStr === 1, "callback for 'str' did NOT run when 'num' changed")
    assert(store.get("num") === 42, "get('num') returns updated value")
    assert(store.all.num === 42, "store.all.num reflects updated value")
    assert(allEvents.length === 2 && allEvents[1] === "num", "subscribeAll saw 'num'")

    // 3. Equality guard: setting the identical value must NOT notify and NOT touch file
    print("\n--- Equality guard test: set same value, assert no notification and no mtime touch ---")
    sleep(50)
    const mtimeBefore = getFileMtime(testFilePath)

    store.set("num", 42)
    assert(countNum === 1, "callback for 'num' did NOT run on identical value write")
    assert(countStr === 1, "callback for 'str' did NOT run on identical value write")
    assert(allEvents.length === 2, "subscribeAll did NOT run on identical value write")

    const mtimeAfterSame = getFileMtime(testFilePath)
    assert(mtimeBefore === mtimeAfterSame, `file mtime was NOT modified (${mtimeBefore} === ${mtimeAfterSame})`)

    // 4. Positive control: setting a different value DOES notify and DOES update mtime
    print("\n--- Positive control: set different value, assert notification and mtime updated ---")
    sleep(50)
    store.set("num", 99)
    assert(countNum === 2, "callback for 'num' ran on different value")
    assert(lastNumVal === 99, "callback for 'num' received 99")

    const mtimeAfterDiff = getFileMtime(testFilePath)
    assert(mtimeBefore !== mtimeAfterDiff, `file mtime DID change on write (${mtimeBefore} -> ${mtimeAfterDiff})`)

    // 5. Update() with multiple keys in a single write
    print("\n--- update() batching test ---")
    sleep(50)
    const mtimeBeforeUpdate = getFileMtime(testFilePath)
    allEvents = []

    store.update({ num: 200, str: "batch-update" })
    assert(countNum === 3, "callback for 'num' ran once for batch update")
    assert(countStr === 2, "callback for 'str' ran once for batch update")
    assert(lastNumVal === 200, "num value is 200")
    assert(lastStrVal === "batch-update", "str value is 'batch-update'")
    assert(allEvents.includes("num") && allEvents.includes("str"), "subscribeAll notified for both keys")

    const mtimeAfterUpdate = getFileMtime(testFilePath)
    assert(mtimeBeforeUpdate !== mtimeAfterUpdate, "file was written for batch update")

    // Equality guard on update(): all identical values
    sleep(50)
    store.update({ num: 200, str: "batch-update" })
    assert(countNum === 3, "callback for 'num' did NOT run on identical update()")
    assert(countStr === 2, "callback for 'str' did NOT run on identical update()")
    const mtimeAfterSameUpdate = getFileMtime(testFilePath)
    assert(mtimeAfterUpdate === mtimeAfterSameUpdate, "file was NOT touched on identical update()")

    // 6. Disposers
    print("\n--- Disposer test ---")
    unsubNum()
    store.set("num", 300)
    assert(countNum === 3, "callback for 'num' did NOT run after disposer called")
    assert(store.get("num") === 300, "num updated in store")
    unsubNum()
    assert(true, "disposer is idempotent and safe to call multiple times")

    unsubStr()
    unsubAll()

    // 7. loadKnown integration: retired keys drop from disk
    print("\n--- loadKnown integration: retired keys on disk drop on write ---")
    const fileWithRetired = {
        num: 777,
        str: "persisted",
        flag: true,
        retiredDeadKey: "should_disappear",
    }
    writeFile(testFilePath, JSON.stringify(fileWithRetired, null, 2))

    const freshStore = defineConfig(testFileName, DEFAULTS)
    assert(freshStore.get("num") === 777, "freshStore loaded num: 777")
    assert((freshStore.all as any).retiredDeadKey === undefined, "retiredDeadKey is not in freshStore.all")

    // Mutate and persist
    freshStore.set("flag", false)
    const contentOnDisk = readFile(testFilePath)
    const parsedOnDisk = JSON.parse(contentOnDisk)
    assert(parsedOnDisk.retiredDeadKey === undefined, "retiredDeadKey was dropped from disk on write")
    assert(parsedOnDisk.flag === false, "updated flag: false on disk")

    // Cleanup test file
    try {
        Gio.File.new_for_path(testFilePath).delete(null)
    } catch {}

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

    // Verify disk persistence
    const barDiskJson = JSON.parse(readFile(`${GLib.get_user_config_dir()}/nidara/bar-settings.json`))
    assert(barDiskJson.showAppTitle === changedBar, "bar-settings.json on disk was updated")

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

    const notifDiskJson = JSON.parse(readFile(`${GLib.get_user_config_dir()}/nidara/notif-config.json`))
    assert(notifDiskJson.popupTimeout === targetTimeout, "notif-config.json on disk has targetTimeout")

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

    const notifDiskJson2 = JSON.parse(readFile(`${GLib.get_user_config_dir()}/nidara/notif-config.json`))
    assert(notifDiskJson2.doNotDisturb === targetDnd, "notif-config.json on disk has targetDnd")

    // Restore
    await setConfigValue("notifications.doNotDisturb", currDnd.toString())
    assert(notifConfig.doNotDisturb === currDnd, "doNotDisturb restored")
    unsubDndExt()

    print(`\n========================================`)
    print(`ALL CHECKS PASSED: ${passedChecks}/${totalChecks}`)
    print(`========================================`)
}

run().catch((e) => {
    printerr(`ERROR: ${e}`)
    imports.system.exit(1)
})
