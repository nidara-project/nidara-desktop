import { execAsync } from "../../../../lib/process"
import { listGroup, createRow, pageBox, staticLabel, onPageShown } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import { readShellVersion } from "../../../core/Paths"
import hs from "../../../core/HyprlandState"
import * as sys from "../../../core/SystemInfo"

/**
 * Settings → About is the DETAIL half of the pair (owner's call, 2026-08-25,
 * closing debt #94). The About window is the glanceable card — the machine, the
 * OS, the desktop's version, and a button that lands here; this page is a strict
 * SUPERSET of it plus the one thing a settings page can hold and a card cannot:
 * something to act on (the update check).
 *
 * Nothing here reads a file or an environment variable itself. Every fact comes
 * from `core/SystemInfo`, which is what stopped the two surfaces from disagreeing
 * about the same machine (RAM was 31 GB in one window and 31.3 GB in the other).
 */

/**
 * True when `latest` is a strictly newer dotted version than `current`.
 */
function isNewerVersion(latest: string, current: string): boolean {
    if (!latest || latest === "unknown" || !current || current === "unknown") return false
    const a = latest.split(".").map(n => parseInt(n, 10) || 0)
    const b = current.split(".").map(n => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
    }
    return false
}

/** Every value on this page goes through the same "" → placeholder contract. */
const shown = (v: string) => staticLabel(v || t("settings.about.unavailable"))

/** A row whose value arrives later; `SystemInfo` never rejects, so there is no catch. */
function asyncRow(label: string, subtitle: string, src: Promise<string>) {
    const lbl = staticLabel("…")
    src.then(v => { lbl.label = v || t("settings.about.unavailable") })
    return createRow(label, subtitle, lbl)
}

export default function AboutPage() {
    const page = pageBox("about-page")

    // ── Nidara ──────────────────────────────────────────────────────────
    // The desktop, and what you can DO about it. It used to also carry a "Shell"
    // row whose value read "Hyprland WM" while its own subtitle described ours —
    // one of the three places this page named the compositor. The compositor has
    // exactly one row now, in Environment, where the other component versions are.
    const { box: shellBox, listBox: shellList } = listGroup(t("settings.about.group.nidara"))

    // The row's subtitle names a COMPONENT, so it is the component's full name:
    // this number is the desktop environment's, not the operating system's (the
    // System group below carries that one). nidara-iso/PRODUCT.md draws the line.
    shellList.append(createRow(t("settings.about.version"), "Nidara Desktop", staticLabel(readShellVersion())))

    // Update check — installed version vs the latest GitHub release. The row is
    // appended only when the check resolves: on network failure or while no
    // releases exist (pre-publication, private repo) About just stays quiet.
    //
    // Retried on every visit UNTIL it answers, then never again. Staying quiet was
    // the right call for one attempt and the wrong one for a session: Settings is
    // often opened right after login, the curl loses to a network that isn't up
    // yet, and this page — built once, cached for the life of the shell — would
    // have kept silent about an available update for the rest of the day. The
    // one-shot flag is what keeps a re-run from stacking a second row.
    let answered = false
    onPageShown(() => {
        if (answered) return
        execAsync(["curl", "-fsS", "--max-time", "5",
            "https://api.github.com/repos/nidara-project/nidara-desktop/releases/latest",
        ]).then(out => {
            const tag = String(JSON.parse(out)?.tag_name ?? "")
            const latest = tag.replace(/^v/, "")
            if (!latest || answered) return
            answered = true
            if (isNewerVersion(latest, readShellVersion())) {
                shellList.append(createRow(t("settings.about.update"),
                    t("settings.about.update.available.desc"), staticLabel(tag)))
            } else {
                shellList.append(createRow(t("settings.about.update"),
                    t("settings.about.update.up-to-date"), staticLabel("")))
            }
        }).catch(() => {})
    })

    page.append(shellBox)

    // ── System ─────────────────────────────────────────────────────────────────
    // The machine and the system on it — the About window's block, in the same
    // order, plus the two it does not show (kernel, uptime). The OS row's subtitle
    // used to be os-release's raw `ID` ("endeavouros"), a machine value printed at
    // a person; the value is the OS's own PRETTY_NAME and the subtitle now says
    // what the value IS.
    const { box: sysBox, listBox: sysList } = listGroup(t("settings.about.group.system"))

    sysList.append(createRow(t("settings.about.device"), t("settings.about.device.desc"), shown(sys.deviceName())))
    sysList.append(createRow(t("settings.about.os"), t("settings.about.os.desc"), shown(sys.osName())))
    sysList.append(createRow(t("settings.about.cpu"), t("settings.about.cpu.desc"), shown(sys.cpuModel())))
    sysList.append(createRow(t("settings.about.ram"), t("settings.about.ram.desc"), shown(sys.totalRam())))
    sysList.append(asyncRow(t("settings.about.graphics"), t("settings.about.graphics.desc"), sys.graphics()))
    sysList.append(asyncRow(t("settings.about.kernel"), t("settings.about.kernel.desc"), sys.kernel()))

    // Uptime — the one value on this page that is wrong the moment after it is
    // read. Everything else here is fixed for the session (kernel, CPU, RAM, OS);
    // this one is a clock, so it gets re-read whenever the page is shown.
    const uptimeLabel = staticLabel("…")
    sysList.append(createRow(t("settings.about.uptime"), t("settings.about.uptime.desc"), uptimeLabel))
    onPageShown(() => {
        uptimeLabel.label = sys.uptime() || t("settings.about.unavailable")
    })

    page.append(sysBox)

    // ── Environment ────────────────────────────────────────────────────────────
    // What the desktop runs ON: the compositor, the toolkit, the runtime. These are
    // the rows the About window dropped when it became the summary — diagnostics,
    // not identity — so this is where they live.
    //
    // Two rows that were here are gone, and for the same reason: a row whose value
    // is fixed is filler wearing a fact's clothes. `XDG_CURRENT_DESKTOP` printed
    // "Hyprland" a third time; the windowing system could only ever read "Wayland",
    // because Hyprland is a Wayland compositor and the shell needs
    // gtk4-layer-shell to draw at all (owner's call, 2026-08-25 — GNOME's
    // "Windowing System" row earns its place precisely because GNOME also runs on
    // X11, and we do not).
    const { box: envBox, listBox: envList } = listGroup(t("settings.about.group.environment"))

    envList.append(asyncRow(t("settings.about.hyprland"), t("settings.about.hyprland.desc"),
        hs.version().then(v => v || "").catch(() => "")))
    envList.append(createRow("GTK", t("settings.about.gtk.desc"), staticLabel(sys.gtkVersion())))
    envList.append(createRow("GJS", t("settings.about.gjs.desc"), staticLabel(sys.gjsVersion())))

    page.append(envBox)

    return page
}
