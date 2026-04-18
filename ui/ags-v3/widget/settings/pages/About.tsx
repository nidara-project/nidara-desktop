import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { listGroup, createRow, pageHeader, pageBox, staticLabel } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

function readVersion(): string {
    // System install path
    const systemPath = "/usr/share/crystal-shell/VERSION"
    // Dev mode: walk up from this file's bundle location to find the repo VERSION
    const devPath = `${GLib.get_home_dir()}/.config/crystal-shell/.dev`

    try {
        const [devOk, devBytes] = GLib.file_get_contents(devPath)
        if (devOk) {
            const repoDir = new TextDecoder().decode(devBytes).trim()
            const [ok, bytes] = GLib.file_get_contents(`${repoDir}/VERSION`)
            if (ok) return new TextDecoder().decode(bytes).trim()
        }
    } catch {}

    try {
        const [ok, bytes] = GLib.file_get_contents(systemPath)
        if (ok) return new TextDecoder().decode(bytes).trim()
    } catch {}

    return "0.1.0"
}

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
    page.append(pageHeader(t("settings.about.page.title.acerca-de"), t("settings.about.page.subtitle.informacion-del-sistema-y-version-de-cry")))

    // ── Crystal Shell ──────────────────────────────────────────────────────────
    const { box: shellBox, listBox: shellList } = listGroup(t("settings.about.group.crystal-shell"))

    shellList.append(createRow(t("settings.about.row.label.version"), "Crystal Shell", staticLabel(readVersion())))
    shellList.append(createRow(t("settings.about.row.label.shell"), t("settings.about.row.desc.ags-v3-gjs-gtk4"), staticLabel("Hyprland WM")))

    shellBox.append(shellList)
    page.append(shellBox)

    // ── Sistema ────────────────────────────────────────────────────────────────
    const { box: sysBox, listBox: sysList } = listGroup(t("settings.about.group.sistema"))

    const osName = readOsRelease("PRETTY_NAME")
    const osId   = readOsRelease("ID")

    sysList.append(createRow(t("settings.about.row.label.sistema-operativo"), osId, staticLabel(osName)))
    sysList.append(createRow(t("settings.about.row.label.cpu"), t("settings.about.row.desc.procesador"), staticLabel(readCpuInfo())))
    sysList.append(createRow(t("settings.about.row.label.memoria-ram"), t("settings.about.row.desc.total-instalada"), staticLabel(readTotalRam())))

    // Kernel — async
    const kernelLabel = staticLabel("…")
    sysList.append(createRow(t("settings.about.row.label.kernel"), t("settings.about.row.desc.version-del-kernel-de-linux"), kernelLabel))
    execAsync(["uname", "-r"]).then(v => { kernelLabel.label = v.trim() }).catch(() => {})

    // Uptime — async
    const uptimeLabel = staticLabel("…")
    sysList.append(createRow(t("settings.about.row.label.tiempo-activo"), t("settings.about.row.desc.desde-el-ultimo-arranque"), uptimeLabel))
    execAsync(["uptime", "-p"]).then(v => { uptimeLabel.label = v.trim().replace(/^up /, "") }).catch(() => {})

    sysBox.append(sysList)
    page.append(sysBox)

    // ── Entorno ────────────────────────────────────────────────────────────────
    const { box: envBox, listBox: envList } = listGroup(t("settings.about.group.entorno"))

    const sessionType = GLib.getenv("XDG_SESSION_TYPE") || "wayland"
    const desktopEnv = GLib.getenv("XDG_CURRENT_DESKTOP") || "Hyprland"

    envList.append(createRow(t("settings.about.row.label.protocolo-grafico"), t("settings.about.row.desc.tipo-de-sesion"), staticLabel(sessionType)))
    envList.append(createRow(t("settings.about.row.label.escritorio"), t("settings.about.row.desc.gestor-de-ventanas"), staticLabel(desktopEnv)))

    // Hyprland version — async
    const hyprLabel = staticLabel("…")
    envList.append(createRow(t("settings.about.row.label.hyprland"), t("settings.about.row.desc.version-del-compositor"), hyprLabel))
    execAsync(["hyprctl", "version"]).then(v => {
        const match = v.match(/Hyprland\s+([\w.-]+)/)
        hyprLabel.label = match ? match[1] : v.split("\n")[0].trim()
    }).catch(() => { hyprLabel.label = t("settings.about.label.no-disponible") })

    envBox.append(envList)
    page.append(envBox)

    return page
}
