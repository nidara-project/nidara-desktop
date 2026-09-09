// table-empty-state-probe.ts — verify #467 empty table contract:
// 1. appendMessage sets a placeholder rather than appending a row.
//    (listBox.get_row_at_index(0) is null; in GTK4 get_first_child() points to the placeholder widget).
// 2. headerBox carries .nidara-table-header--dim while placeholder is showing.
// 3. clear() resets headerBox to full contrast and removes placeholder.
// 4. appendRow(...) restores full contrast and leaves listBox populated.
//
// Usage:
//   ./scripts/bundle.sh scripts/dev/table-empty-state-probe.ts /tmp/table-empty-probe && /tmp/table-empty-probe

import Gtk from "gi://Gtk?version=4.0"
import system from "system"
import { NidaraTable } from "../../ui/lib/nidara-kit/table"

Gtk.init()

const table = NidaraTable([
    { title: "Partition" },
    { title: "Size" },
    { title: "Mount point" },
])

const headerBox = table.box.get_first_child() as Gtk.Box
if (!headerBox || !headerBox.has_css_class("nidara-table-header")) {
    console.error("FAIL: table.box first child is not headerBox with nidara-table-header")
    system.exit(1)
}

// 1. Initial state: empty table, not yet messaged
console.log("1. Initial state:")
console.log("   listBox.get_row_at_index(0):", table.listBox.get_row_at_index(0))
console.log("   listBox.get_first_child():", table.listBox.get_first_child())
console.log("   header dimmed:", headerBox.has_css_class("nidara-table-header--dim"))
if (table.listBox.get_row_at_index(0) !== null || headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: initial state unexpected")
    system.exit(1)
}

// 2. State after appendMessage: placeholder set, zero child rows, header dimmed
console.log("\n2. After appendMessage('No partitions'):")
const placeholderRow = table.appendMessage("No partitions")
console.log("   listBox.get_row_at_index(0):", table.listBox.get_row_at_index(0), "(null: zero rows in the list)")
console.log("   listBox.get_first_child() === placeholder:", table.listBox.get_first_child() === placeholderRow, "(GTK4 attaches placeholder as child)")
console.log("   header dimmed:", headerBox.has_css_class("nidara-table-header--dim"), "(true expected)")
if (table.listBox.get_row_at_index(0) !== null) {
    console.error("FAIL: appendMessage appended an indexable row instead of setting placeholder")
    system.exit(1)
}
if (!headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: headerBox was not dimmed after appendMessage")
    system.exit(1)
}

// 3. State after clear(): headings stay at full contrast, list empty
console.log("\n3. After clear():")
table.clear()
console.log("   listBox.get_row_at_index(0):", table.listBox.get_row_at_index(0), "(null expected)")
console.log("   listBox.get_first_child():", table.listBox.get_first_child(), "(null expected)")
console.log("   header dimmed:", headerBox.has_css_class("nidara-table-header--dim"), "(false expected: full contrast)")
if (table.listBox.get_first_child() !== null || headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: clear() did not reset header contrast or rows")
    system.exit(1)
}

// 4. State after appendRow(): row added, headings at full contrast
console.log("\n4. After appendRow(['/dev/nvme0n1p1', '512 MiB', '/boot']):")
table.appendRow(["/dev/nvme0n1p1", "512 MiB", "/boot"])
console.log("   listBox.get_row_at_index(0):", table.listBox.get_row_at_index(0) ? "Gtk.ListBoxRow" : "null", "(row expected)")
console.log("   listBox.get_first_child():", table.listBox.get_first_child() ? "Gtk.ListBoxRow" : "null", "(row expected)")
console.log("   header dimmed:", headerBox.has_css_class("nidara-table-header--dim"), "(false expected: full contrast)")
if (table.listBox.get_row_at_index(0) === null) {
    console.error("FAIL: appendRow did not add row")
    system.exit(1)
}
if (headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: headerBox remained dimmed after appendRow")
    system.exit(1)
}

// 5. Direct transition: appendMessage -> appendRow directly without clear()
console.log("\n5. Direct transition: appendMessage -> appendRow:")
table.clear()
table.appendMessage("Nothing here")
if (!headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: headerBox not dimmed after second appendMessage")
    system.exit(1)
}
table.appendRow(["/dev/sda1", "100 GiB", "/"])
if (table.listBox.get_row_at_index(0) === null || headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: appendRow did not dismiss message or undim header")
    system.exit(1)
}
console.log("   listBox.get_row_at_index(0):", table.listBox.get_row_at_index(0) ? "Gtk.ListBoxRow" : "null")
console.log("   header dimmed:", headerBox.has_css_class("nidara-table-header--dim"))

// 6. Calling appendMessage while table already has rows: ignored, headings stay at full contrast
console.log("\n6. Calling appendMessage on non-empty table:")
table.appendMessage("Ignored message")
if (headerBox.has_css_class("nidara-table-header--dim")) {
    console.error("FAIL: appendMessage dimmed headers despite table having rows")
    system.exit(1)
}
console.log("   header dimmed:", headerBox.has_css_class("nidara-table-header--dim"), "(false expected: ignored because rows exist)")

console.log("\nALL CHECKS PASSED: NidaraTable empty state & placeholder contract verified.")
