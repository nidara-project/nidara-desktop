import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import System from "system"
import { execAsync } from "../../lib/process"
import { currentLocale } from "./i18n"

/**
 * The ONE reader of "what is this computer".
 *
 * Both About surfaces used to carry their own copy of these — same files, two
 * regexes, two formats — and the divergence was visible to the user before it
 * was visible to us: the same machine reported **31 GB** in the About window and
 * **31.3 GB** in Settings, because one rounded `MemTotal` and the other printed
 * one decimal. A fact that renders differently in two windows of the same desktop
 * reads as a bug in the desktop, whichever number is "right".
 *
 * So the rule this module exists to enforce: **a surface asks, it never reads.**
 * Formatting lives here too, not at the call site — the duplication that produced
 * 31 vs 31.3 was in the formatting, not in the file access.
 *
 * Unknown is the EMPTY STRING, never a human word: the two surfaces render their
 * own placeholder (both `settings.about.unavailable` today), and a reader that
 * returned "Unknown" would put an untranslated English word on a translated page.
 */

function readText(path: string): string {
    try {
        const [ok, bytes] = GLib.file_get_contents(path)
        return ok ? new TextDecoder().decode(bytes) : ""
    } catch { return "" }
}

/** A field of /etc/os-release, unquoted. `PRETTY_NAME` is the only one a person should see. */
function osRelease(field: string): string {
    const m = readText("/etc/os-release").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))
    return m ? m[1].trim() : ""
}

/**
 * The operating system, as the OS names itself — "Nidara 0.1.0" on the product
 * (`nidara-release` owns that file), "Arch Linux" on somebody's own Arch that ran
 * install.sh. Both are true and the second is a supported outcome, not a
 * fallback: install.sh must never rename anyone's operating system.
 */
export const osName = (): string => osRelease("PRETTY_NAME")

/** The machine's name — the one thing on these surfaces that is not about Nidara. */
export const deviceName = (): string => GLib.get_host_name()

/**
 * The CPU, with the marketing noise stripped ("Intel(R) Core(TM) i7-9700K CPU @
 * 3.60GHz" → "Intel Core i7-9700K"). Settings used to print the raw line and the
 * window the cleaned one; the clean one wins because the row is an identity, not
 * a datasheet — the clock speed is in the model number for anyone who needs it.
 */
export function cpuModel(): string {
    const m = readText("/proc/cpuinfo").match(/^model name\s*:\s*(.+)$/m)
    if (!m) return ""
    return m[1].trim()
        .replace(/\(R\)|\(TM\)/g, "")
        .replace(/\s+CPU\s+/, " ")
        .replace(/\s+@\s+[\d.]+GHz/, "")
        .replace(/\s+/g, " ")
        .trim()
}

/**
 * Installed memory, rounded UP to the whole GiB.
 *
 * `MemTotal` is what the kernel can hand out, not what is in the slots — the
 * firmware and the kernel reserve a slice before userspace ever sees it (this
 * host: 32778376 kB = 31.26 GiB of 32 GiB installed). Printed as-is it makes the
 * desktop claim the person has less RAM than they bought, which is the one thing
 * this row must not do; every consumer OS reports the installed size (macOS "32
 * GB", Windows "32.0 GB (31.3 GB usable)").
 *
 * Ceiling to the whole GiB restores it, because the reserved slice is a few
 * percent — well under the 1 GiB it would take to round to the wrong number — and
 * it stays correct for the odd sizes too (12, 24, 48). A machine with a large
 * carve-out (an iGPU taking a gigabyte) still under-reports; nothing readable
 * from /proc fixes that, and it is no worse than what it replaced.
 */
export function totalRam(): string {
    const m = readText("/proc/meminfo").match(/^MemTotal:\s+(\d+)\s+kB/m)
    if (!m) return ""
    return `${Math.ceil(parseInt(m[1]) / 1024 / 1024)} GB`
}

/** GTK, at runtime. A hardcoded version string cannot go stale loudly. */
export const gtkVersion = (): string =>
    `${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`

/** GJS packs its version as major*10000 + minor*100 + micro (18801 = 1.88.1). */
export const gjsVersion = (): string =>
    `${Math.floor(System.version / 10000)}.${Math.floor(System.version / 100) % 100}.${System.version % 100}`

// ── The three that need a process ──────────────────────────────────────────────
// Each resolves to "" on failure (never rejects), so a call site is a one-liner
// and can't forget the .catch that leaves a row saying "…" forever.

const quiet = (cmd: string[]): Promise<string> =>
    execAsync(cmd).then(v => v.trim()).catch(() => "")

/**
 * The GPU, as a name rather than a PCI database entry.
 *
 * `lspci` answers "Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX
 * 5600 OEM/5600 XT / 5700/5700 XT]" — 89 characters of which the first 38 are
 * the vendor said twice and a silicon codename nobody bought. It is printed in a
 * 380px card, so the raw string is not a long value, it is a value that decides
 * the width of the window.
 *
 * The marketing name is what lspci puts in the LAST bracket, `[AMD/ATI]` being a
 * vendor tag and not a model; the vendor is normalised to the word people use.
 * "AMD Radeon RX 5600 OEM/5600 XT / 5700/5700 XT" — the tail stays multi-SKU
 * because one PCI id really does cover those cards, and a name that is honestly
 * ambiguous beats a shorter one that is wrong for half the owners.
 */
function gpuName(raw: string): string {
    if (!raw) return ""
    // ⚠️ Every one of these needs its word boundaries and Intel needs to be asked
    // BEFORE AMD: an unanchored /ati/ matches inside "Corpor**ati**on", so every
    // Intel card in the world ("Intel Corporation Alder Lake-P GT2 …") came back
    // branded AMD. Caught by running the function over six real lspci strings —
    // this host has an AMD card, so the machine that wrote it could never have
    // seen it.
    const vendor = /\bnvidia\b/i.test(raw) ? "NVIDIA"
        : /\bintel\b/i.test(raw) ? "Intel"
        : /advanced micro devices|\bamd\b|\bati\b/i.test(raw) ? "AMD"
        : ""
    const models = [...raw.matchAll(/\[([^\]]+)\]/g)]
        .map(m => m[1].trim())
        .filter(b => !/^(amd\/ati|ati|amd)$/i.test(b))
    // No brackets at all (virtio in a VM, an odd vendor): drop the corporate suffix.
    const model = models.length ? models[models.length - 1]
        : raw.replace(/^.*?(Corporation|Inc\.|Technologies|Ltd\.?)\s*/i, "").trim() || raw
    return vendor && !model.toLowerCase().startsWith(vendor.toLowerCase()) ? `${vendor} ${model}` : model
}

/** The GPU model, first display adapter only. */
export const graphics = (): Promise<string> => quiet(["bash", "-c",
    "lspci 2>/dev/null | grep -i 'vga\\|3d\\|display' | head -1 | sed 's/.*: //' | sed 's/(.*)//' | xargs",
]).then(gpuName)

export const kernel = (): Promise<string> => quiet(["uname", "-r"])

/**
 * Time since boot, in the language the shell is running in.
 *
 * It used to be `uptime -p`, whose prose follows the PROCESS's locale, not the
 * desktop's — so a Spanish Settings page printed "3 days, 8 hours, 3 minutes"
 * (seen on screen, 2026-08-25). It is also the one row here that no `t()` key
 * could have fixed cheaply: "day/hour/minute" needs plural forms, and Russian and
 * Polish have three each.
 *
 * It is also the only fact here that stopped needing a subprocess: /proc/uptime
 * is a file, so this reader is synchronous while `uptime -p` was not.
 *
 * `Intl` in GJS is ICU, so it already knows all of them — verified in gjs across
 * the twelve locales, including "3 дня"/"1 день" and "3 dni"/"1 dzień". No new
 * translation keys, and no reader of /proc/uptime beyond this one.
 *
 * At most two units, largest first: "3 días y 8 horas", "8 horas y 3 minutos",
 * "22 minutos". Under a minute reads as zero minutes rather than seconds, which
 * is the honest answer for a row nobody watches tick.
 */
export function uptime(): string {
    const raw = readText("/proc/uptime")
    const secs = parseFloat(raw.split(/\s+/)[0] || "")
    if (!isFinite(secs) || secs < 0) return ""
    const loc = currentLocale()
    const unit = (n: number, u: string) =>
        new Intl.NumberFormat(loc, { style: "unit", unit: u, unitDisplay: "long" }).format(n)

    const days = Math.floor(secs / 86400)
    const hours = Math.floor((secs % 86400) / 3600)
    const mins = Math.floor((secs % 3600) / 60)
    const parts = days > 0 ? [unit(days, "day"), unit(hours, "hour")]
        : hours > 0 ? [unit(hours, "hour"), unit(mins, "minute")]
        : [unit(mins, "minute")]
    return new Intl.ListFormat(loc, { style: "long", type: "conjunction" }).format(parts)
}

