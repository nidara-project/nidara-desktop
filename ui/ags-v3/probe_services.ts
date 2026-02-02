import { Variable } from "ags"
import { exec, execAsync } from "ags/process"

try {
    const battery = pkg.require("gi://AstalBattery")
    console.log("AstalBattery available")
} catch (e) {
    console.log("AstalBattery NOT available")
}

try {
    const network = pkg.require("gi://AstalNetwork")
    console.log("AstalNetwork available")
} catch (e) {
    console.log("AstalNetwork NOT available")
}

try {
    const wp = pkg.require("gi://AstalWp")
    console.log("AstalWp available")
} catch (e) {
    console.log("AstalWp NOT available")
}

try {
    const tray = pkg.require("gi://AstalTray")
    console.log("AstalTray available")
} catch (e) {
    console.log("AstalTray NOT available")
}
