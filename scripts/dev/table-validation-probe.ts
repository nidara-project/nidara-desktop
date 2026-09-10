// table-validation-probe.ts — verify #466 row validation contract:
// 1. NidaraTable rows support setValidationState("none" | "warning" | "error").
//    - Marked rows wear .nidara-table-row--warning / .nidara-table-row--error.
//    - Unmarked rows carry neither class.
// 2. NidaraFieldRow supports setError(message) and setValidationState(state).
//    - Error messages are displayed in a .nidara-field-error label under the control.
//    - Marked rows wear .nidara-row--warning / .nidara-row--error.
// 3. AccountStep (ui/installer/steps/account.ts) consumes NidaraFieldRow from kit.
//    - Reports all four field faults simultaneously upon input.
//    - Clears faults and becomes ready when fields are valid.
//
// Usage:
//   ./scripts/bundle.sh scripts/dev/table-validation-probe.ts /tmp/table-validation-probe && /tmp/table-validation-probe

import Gtk from "gi://Gtk?version=4.0"
import system from "system"
import { NidaraTable } from "../../ui/lib/nidara-kit/table"
import { NidaraFieldRow } from "../../ui/lib/nidara-kit/row"
import { AccountStep } from "../../ui/installer/steps/account"
import { manualProblems } from "../../ui/installer/lib/manual-problems"
import type { ManualPartitionMount } from "../../ui/installer/lib/answers"

Gtk.init()

let failures = 0
function assert(cond: boolean, desc: string): void {
    if (!cond) {
        console.error(`   ✗ FAIL: ${desc}`)
        failures++
    } else {
        console.log(`   ✓ ${desc}`)
    }
}

console.log("=== 1. NidaraTable Row Validation State Contract ===")

const table = NidaraTable([
    { title: "Partition" },
    { title: "Size" },
    { title: "Mount point" },
])

const row1 = table.appendRow(["/dev/nvme0n1p1", "512 MiB", "/boot"])
const row2 = table.appendRow(["/dev/nvme0n1p2", "100 GiB", "/"])

assert(
    !row1.has_css_class("nidara-table-row--warning") && !row1.has_css_class("nidara-table-row--error"),
    "Row 1 is unmarked on creation (neither warning nor error class)",
)
assert(
    !row2.has_css_class("nidara-table-row--warning") && !row2.has_css_class("nidara-table-row--error"),
    "Row 2 is unmarked on creation (neither warning nor error class)",
)

// Mark row 1 as warning
row1.setValidationState("warning")
assert(
    row1.has_css_class("nidara-table-row--warning") && !row1.has_css_class("nidara-table-row--error"),
    "Row 1 marked as warning has .nidara-table-row--warning and NOT .nidara-table-row--error",
)
assert(
    !row2.has_css_class("nidara-table-row--warning") && !row2.has_css_class("nidara-table-row--error"),
    "Row 2 remains completely unmarked while Row 1 is warning",
)

// Transition row 1 to error
row1.setValidationState("error")
assert(
    !row1.has_css_class("nidara-table-row--warning") && row1.has_css_class("nidara-table-row--error"),
    "Row 1 transitioned to error has .nidara-table-row--error and NOT .nidara-table-row--warning",
)
assert(
    !row2.has_css_class("nidara-table-row--warning") && !row2.has_css_class("nidara-table-row--error"),
    "Row 2 remains completely unmarked while Row 1 is error",
)

// Clear row 1 to none
row1.setValidationState("none")
assert(
    !row1.has_css_class("nidara-table-row--warning") && !row1.has_css_class("nidara-table-row--error"),
    "Row 1 reset to none has neither warning nor error class",
)

// Mark row 2 as warning and row 1 as error simultaneously
row1.setValidationState("error")
row2.setValidationState("warning")
assert(
    row1.has_css_class("nidara-table-row--error") && !row1.has_css_class("nidara-table-row--warning"),
    "Multiple rows: Row 1 carries error",
)
assert(
    row2.has_css_class("nidara-table-row--warning") && !row2.has_css_class("nidara-table-row--error"),
    "Multiple rows: Row 2 carries warning",
)

table.clear()

console.log("\n=== 2. NidaraFieldRow Isolated Contract ===")

const dummyEntry = new Gtk.Entry()
const field = NidaraFieldRow("Username", "Optional subtitle", dummyEntry)

assert(
    !field.row.has_css_class("nidara-row--warning") && !field.row.has_css_class("nidara-row--error"),
    "NidaraFieldRow is unmarked on creation",
)

field.setError("Username format invalid")
assert(
    field.row.has_css_class("nidara-row--error"),
    "setError with non-empty message adds .nidara-row--error",
)

field.setError("")
assert(
    !field.row.has_css_class("nidara-row--error") && !field.row.has_css_class("nidara-row--warning"),
    "setError('') clears error state and removes .nidara-row--error",
)

field.setValidationState("warning")
assert(
    field.row.has_css_class("nidara-row--warning"),
    "setValidationState('warning') adds .nidara-row--warning",
)

field.setValidationState("none")
assert(
    !field.row.has_css_class("nidara-row--warning"),
    "setValidationState('none') removes .nidara-row--warning",
)

console.log("\n=== 3. AccountStep Integration (4 Errors Reported On Field Rows) ===")

const step = AccountStep()
const stepBox = step.build() as Gtk.Box

// Find the ListBox containing the 5 account fields
function findListBox(widget: Gtk.Widget): Gtk.ListBox | null {
    if (widget instanceof Gtk.ListBox) return widget
    let child = widget.get_first_child()
    while (child) {
        const found = findListBox(child)
        if (found) return found
        child = child.get_next_sibling()
    }
    return null
}

const listBox = findListBox(stepBox)
assert(listBox !== null, "Found ListBox in AccountStep layout")

if (listBox) {
    // Collect the 5 rows: fullName, username, hostname, password, confirm
    const rows: Gtk.ListBoxRow[] = []
    let child = listBox.get_first_child()
    while (child) {
        if (child instanceof Gtk.ListBoxRow) rows.push(child)
        child = child.get_next_sibling()
    }

    assert(rows.length === 5, `ListBox contains 5 field rows (got ${rows.length})`)

    interface FieldInspect {
        row: Gtk.ListBoxRow
        entry: Gtk.Widget
        errorLabel: Gtk.Label
    }

    function inspectRow(row: Gtk.ListBoxRow): FieldInspect {
        const box = row.get_child() as Gtk.Box
        // In NidaraStackedRow: child 0 is textColumn, child 1 is stack
        const stack = box.get_first_child()?.get_next_sibling() as Gtk.Box
        const entry = stack.get_first_child() as Gtk.Widget
        const errorLabel = stack.get_last_child() as Gtk.Label
        return { row, entry, errorLabel }
    }

    const fields = rows.map(inspectRow)
    const [fullNameF, usernameF, hostnameF, passwordF, confirmF] = fields

    // Initial state: form untouched, all error labels invisible and empty
    assert(
        !usernameF.errorLabel.visible &&
        !hostnameF.errorLabel.visible &&
        !passwordF.errorLabel.visible &&
        !confirmF.errorLabel.visible,
        "Initial untouched form: all field error lines are silent (visible: false)",
    )
    assert(!step.ready(), "Initial form is not ready (passwords unpopulated)")

    // Trigger edit with invalid entries across all 4 validated fields:
    // 1. username with uppercase letters (violates useradd rules)
    // 2. hostname with invalid chars
    // 3. password empty
    // 4. confirm password mismatched
    const uEntry = usernameF.entry as Gtk.Entry
    const hEntry = hostnameF.entry as Gtk.Entry
    const pEntry = passwordF.entry as Gtk.PasswordEntry
    const cEntry = confirmF.entry as Gtk.PasswordEntry

    // Setting text and emitting changed triggers onEdited() -> formTouched = true -> validate()
    uEntry.set_text("InvalidUsername")
    uEntry.emit("changed")

    hEntry.set_text("bad_hostname!")
    hEntry.emit("changed")

    pEntry.set_text("pass1")
    pEntry.emit("changed")

    cEntry.set_text("pass2_mismatch")
    cEntry.emit("changed")

    // Verify all 4 errors are reported at once on their respective fields
    assert(
        usernameF.errorLabel.visible && usernameF.errorLabel.label.length > 0,
        `Username error reported: "${usernameF.errorLabel.label}"`,
    )
    assert(
        usernameF.row.has_css_class("nidara-row--error"),
        "Username row wears .nidara-row--error",
    )

    assert(
        hostnameF.errorLabel.visible && hostnameF.errorLabel.label.length > 0,
        `Hostname error reported: "${hostnameF.errorLabel.label}"`,
    )
    assert(
        hostnameF.row.has_css_class("nidara-row--error"),
        "Hostname row wears .nidara-row--error",
    )

    // With mismatched passwords, confirm password reports the mismatch
    assert(
        confirmF.errorLabel.visible && confirmF.errorLabel.label.length > 0,
        `Confirm password error reported: "${confirmF.errorLabel.label}"`,
    )
    assert(
        confirmF.row.has_css_class("nidara-row--error"),
        "Confirm password row wears .nidara-row--error",
    )

    // Now test empty password with touched form -> reports password required
    pEntry.set_text("")
    pEntry.emit("changed")
    cEntry.set_text("")
    cEntry.emit("changed")
    assert(
        passwordF.errorLabel.visible && passwordF.errorLabel.label.length > 0,
        `Password required error reported: "${passwordF.errorLabel.label}"`,
    )
    assert(
        passwordF.row.has_css_class("nidara-row--error"),
        "Password row wears .nidara-row--error",
    )

    assert(!step.ready(), "Step remains not ready while faults are present")

    // Fix all fields with valid inputs
    uEntry.set_text("nidara")
    uEntry.emit("changed")

    hEntry.set_text("nidarapc")
    hEntry.emit("changed")

    pEntry.set_text("validPassword123")
    pEntry.emit("changed")

    cEntry.set_text("validPassword123")
    cEntry.emit("changed")

    assert(
        !usernameF.errorLabel.visible && usernameF.errorLabel.label === "",
        "Username error cleared on valid input",
    )
    assert(
        !usernameF.row.has_css_class("nidara-row--error"),
        "Username row cleared error class",
    )

    assert(
        !hostnameF.errorLabel.visible && hostnameF.errorLabel.label === "",
        "Hostname error cleared on valid input",
    )
    assert(
        !hostnameF.row.has_css_class("nidara-row--error"),
        "Hostname row cleared error class",
    )

    assert(
        !passwordF.errorLabel.visible && passwordF.errorLabel.label === "",
        "Password error cleared on valid input",
    )
    assert(
        !passwordF.row.has_css_class("nidara-row--error"),
        "Password row cleared error class",
    )

    assert(
        !confirmF.errorLabel.visible && confirmF.errorLabel.label === "",
        "Confirm password error cleared on valid input",
    )
    assert(
        !confirmF.row.has_css_class("nidara-row--error"),
        "Confirm row cleared error class",
    )

    assert(step.ready(), "Step reports ready() === true when all fields are valid")
}

console.log("\n=== 4. Manual Partitioning Row Validation Contract (#509) ===")

const mockMounts: ManualPartitionMount[] = [
    {
        name: "sda1", path: "/dev/sda1", device: "/dev/sda", start: 1048576, size: 512 * 1024 * 1024,
        logicalSectorSize: 512, fsType: "vfat", label: null, mountpoint: "/boot", filesystem: "vfat", format: false,
    },
    {
        name: "sda2", path: "/dev/sda2", device: "/dev/sda", start: 537919488, size: 50 * 1024 * 1024 * 1024,
        logicalSectorSize: 512, fsType: null, label: null, mountpoint: "/", filesystem: "btrfs", format: true,
    },
    {
        name: "sda3", path: "/dev/sda3", device: "/dev/sda", start: 54228819968, size: 50 * 1024 * 1024 * 1024,
        logicalSectorSize: 512, fsType: null, label: null, mountpoint: "/", filesystem: "btrfs", format: true,
    },
]

const manualTable = NidaraTable([
    { title: "Partition" },
    { title: "Size" },
    { title: "Mount point" },
])

const rBoot = manualTable.appendRow(["/dev/sda1", "512 MiB", "/boot"])
const rRoot1 = manualTable.appendRow(["/dev/sda2", "50 GiB", "/"])
const rRoot2 = manualTable.appendRow(["/dev/sda3", "50 GiB", "/"])

const rowMap = new Map<string, typeof rBoot>([
    ["/dev/sda1", rBoot],
    ["/dev/sda2", rRoot1],
    ["/dev/sda3", rRoot2],
])

function applyManualProblems(mounts: ManualPartitionMount[]) {
    const problems = manualProblems(mounts, true)
    const errorEntries = new Set<ManualPartitionMount>()
    for (const prob of problems) {
        if (prob.entry) errorEntries.add(prob.entry)
    }
    for (const m of mounts) {
        const r = rowMap.get(m.path)
        if (r) r.setValidationState(errorEntries.has(m) ? "error" : "none")
    }
    const unassigned = problems.filter(p => !p.entry).map(p => p.message)
    return { problems, unassigned }
}

// Check duplicate root mounts
const res1 = applyManualProblems(mockMounts)
assert(
    rRoot1.has_css_class("nidara-table-row--error"),
    "First partition on / wears .nidara-table-row--error",
)
assert(
    rRoot2.has_css_class("nidara-table-row--error"),
    "Second partition on / wears .nidara-table-row--error",
)
assert(
    !rBoot.has_css_class("nidara-table-row--error"),
    "/boot partition is valid and unmarked",
)
assert(
    res1.unassigned.length === 0,
    "Duplicate mount fault belongs to rows, so unassigned block above table is empty",
)

// Fix duplicate by moving sda3 to /home
mockMounts[2].mountpoint = "/home"
const res2 = applyManualProblems(mockMounts)
assert(
    !rRoot1.has_css_class("nidara-table-row--error"),
    "First partition clears error when duplicate is removed",
)
assert(
    !rRoot2.has_css_class("nidara-table-row--error"),
    "Second partition clears error when moved to /home",
)
assert(
    res2.problems.length === 0 && res2.unassigned.length === 0,
    "Layout is now fully valid with no problems",
)

// Layout with no root at all
mockMounts[1].mountpoint = ""
const res3 = applyManualProblems(mockMounts.filter(m => m.mountpoint !== ""))
assert(
    !rRoot1.has_css_class("nidara-table-row--error") && !rRoot2.has_css_class("nidara-table-row--error"),
    "No rows are marked error when root is simply missing",
)
assert(
    res3.unassigned.length > 0,
    "Missing root appears in unassigned block above table (sentence: diskErrNoRoot)",
)

if (failures === 0) {
    console.log("\nALL CHECKS PASSED: NidaraTable & NidaraFieldRow validation contract verified.")
    system.exit(0)
} else {
    console.error(`\nFAILED: ${failures} check(s) failed.`)
    system.exit(1)
}
