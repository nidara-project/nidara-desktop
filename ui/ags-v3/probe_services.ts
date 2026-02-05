import { exec, execAsync } from "ags/process"

/**
 * Service Availability Probe 🛡️🔍
 * Bypasses broken pkg.require and uses safe dynamic imports or GObject checks.
 */

async function probeService(name: string) {
    try {
        // @ts-ignore
        const service = await import(`gi://${name}`)
        console.log(`[PROBE] ${name} available`)
        return true
    } catch (e) {
        console.log(`[PROBE] ${name} NOT available`)
        return false
    }
}

// Execution
const services = ["AstalBattery", "AstalNetwork", "AstalWp", "AstalTray"]
services.forEach(s => probeService(s))
