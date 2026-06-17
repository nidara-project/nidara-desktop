import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { listGroup, createRow, pageBox, staticLabel } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import { readShellVersion } from "../../../core/Paths"
import hs from "../../../core/HyprlandState"

/**
 * Reads a field from /etc/os-release synchronously.
 */
function readOsRelease(field: string): string {
    try {
        const [ok, bytes] = GLib.file_get_contents("/etc/os-release")
        if (!ok) return "Unknown"
        const content = new TextDecoder().decode(bytes)
        const match = content.match(new RegExp(`^${field}="?([^"\n]+)"?`, "m"))
        return match ? match[1].trim() : "Unknown"
    } catch {
        return "Unknown"
    }
}

/**
 * Reads the first matching line from /proc/cpuinfo.
 */
function readCpuInfo(): string {
    try {
        const [ok, bytes] = GLib.file_get_contents("/proc/cpuinfo")
        if (!ok) return "Unknown"
        const content = new TextDecoder().decode(bytes)
        const match = content.match(/^model name\s*:\s*(.+)$/m)
        return match ? match[1].trim() : "Unknown"
    } catch {
        return "Unknown"
    }
}

/**
 * True when `latest` is a strictly newer dotted version than `current`.
 */
function isNewerVersion(latest: string, current: string): boolean {
    const a = latest.split(".").map(n => parseInt(n, 10) || 0)
    const b = current.split(".").map(n => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
    }
    return false
}

/**
 * Reads total RAM from /proc/meminfo.
 */
function readTotalRam(): string {
    try {
        const [ok, bytes] = GLib.file_get_contents("/proc/meminfo")
        if (!ok) return "Unknown"
        const content = new TextDecoder().decode(bytes)
        const match = content.match(/^MemTotal:\s+(\d+)\s+kB/m)
        if (!match) return "Unknown"
        const kb = parseInt(match[1])
        const gb = (kb / 1024 / 1024).toFixed(1)
        return `${gb} GB`
    } catch {
        return "Unknown"
    }
}

export default function AboutPage() {
    const page = pageBox("about-page")

    // ── Nidara ──────────────────────────────────────────────────────────
    const { box: shellBox, listBox: shellList } = listGroup(t("settings.about.group.nidara"))

    shellList.append(createRow(t("settings.about.version"), "Nidara", staticLabel(readShellVersion())))
    shellList.append(createRow(t("settings.about.shell"), t("settings.about.shell.desc"), staticLabel("Hyprland WM")))

    // Update check — installed version vs the latest GitHub release. The row is
    // appended only when the check resolves: on network failure or while no
    // releases exist (pre-publication, private repo) About just stays quiet.
    execAsync(["curl", "-fsS", "--max-time", "5",
        "https://api.github.com/repos/nidara-project/nidara-desktop/releases/latest",
    ]).then(out => {
        const tag = String(JSON.parse(out)?.tag_name ?? "")
        const latest = tag.replace(/^v/, "")
        if (!latest) return
        if (isNewerVersion(latest, readShellVersion())) {
            shellList.append(createRow(t("settings.about.update"),
                t("settings.about.update.available.desc"), staticLabel(tag)))
        } else {
            shellList.append(createRow(t("settings.about.update"),
                t("settings.about.update.up-to-date"), staticLabel("")))
        }
    }).catch(() => {})

    page.append(shellBox)

    // ── Sistema ────────────────────────────────────────────────────────────────
    const { box: sysBox, listBox: sysList } = listGroup(t("settings.about.group.system"))

    const osName = readOsRelease("PRETTY_NAME")
    const osId   = readOsRelease("ID")

    sysList.append(createRow(t("settings.about.os"), osId, staticLabel(osName)))
    sysList.append(createRow(t("settings.about.cpu"), t("settings.about.cpu.desc"), staticLabel(readCpuInfo())))
    sysList.append(createRow(t("settings.about.ram"), t("settings.about.ram.desc"), staticLabel(readTotalRam())))

    // Kernel — async
    const kernelLabel = staticLabel("…")
    sysList.append(createRow(t("settings.about.kernel"), t("settings.about.kernel.desc"), kernelLabel))
    execAsync(["uname", "-r"]).then(v => { kernelLabel.label = v.trim() }).catch(() => {})

    // Uptime — async
    const uptimeLabel = staticLabel("…")
    sysList.append(createRow(t("settings.about.uptime"), t("settings.about.uptime.desc"), uptimeLabel))
    execAsync(["uptime", "-p"]).then(v => { uptimeLabel.label = v.trim().replace(/^up /, "") }).catch(() => {})

    page.append(sysBox)

    // ── Entorno ────────────────────────────────────────────────────────────────
    const { box: envBox, listBox: envList } = listGroup(t("settings.about.group.environment"))

    const sessionType = GLib.getenv("XDG_SESSION_TYPE") || "wayland"
    const desktopEnv = GLib.getenv("XDG_CURRENT_DESKTOP") || "Hyprland"

    envList.append(createRow(t("settings.about.graphics-protocol"), t("settings.about.graphics-protocol.desc"), staticLabel(sessionType)))
    envList.append(createRow(t("settings.about.desktop"), t("settings.about.desktop.desc"), staticLabel(desktopEnv)))

    // Hyprland version — async
    const hyprLabel = staticLabel("…")
    envList.append(createRow(t("settings.about.hyprland"), t("settings.about.hyprland.desc"), hyprLabel))
    hs.version().then(v => {
        hyprLabel.label = v || t("settings.about.unavailable")
    }).catch(() => { hyprLabel.label = t("settings.about.unavailable") })

    page.append(envBox)

    return page
}
