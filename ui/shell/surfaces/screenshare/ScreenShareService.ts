import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { showNidaraAlert } from "../../../lib/nidara-kit"
import { execAsync } from "../../../lib/process"
import { appService } from "../../core/AppService"
import compositor from "../../core/CompositorState"
import { uiIcon } from "../../core/Icons"
import { t } from "../../core/i18n"
import { captureWindow } from "../../core/WindowCapture"
import { makeWindowThumbnail } from "../../common/WindowThumbnail"

/**
 * NIDARA — choosing what an app may see of the screen
 * ===================================================
 *
 * A call that shares the screen asks the portal's ScreenCast, which on Hyalo is
 * xdg-desktop-portal-wlr (`config/portal/nidara-portals.conf`). xdpw asks a CHOOSER
 * which screen or window to share: ours is `bin/nidara-share-chooser`
 * (`config/portal/xdpw-nidara.conf`), which forwards xdpw's list here and prints the
 * line the user picked. Same split as the consent prompt (`surfaces/consent/`): the
 * portal side has no GTK, the shell draws the question.
 *
 *   app ──portal──▶ xdg-desktop-portal ──impl.ScreenCast──▶ xdpw ──▶ nidara-share-chooser
 *                                                                       │ org.nidara.Shell.ScreenShare
 *                                                                       ▼
 *                                                                 this file: the picker
 *
 * The list is xdpw's (`chooser_type = dmenu`): one line per screen it can share,
 * `Monitor: <name> …`, and per window, `Window: <title> (<identifier>)` — only the
 * kinds the app asked for. A window's identifier is the address the shell already
 * knows it by (Hyalo lists windows under it, hyalo/compositor/src/capture.rs), so its
 * tile gets the same thumbnail the overview shows. The answer is the INDEX of the
 * line picked, or -1, and the chooser prints that line back: xdpw accepts only a
 * line it offered.
 *
 * ── Rules this file keeps (the consent prompt's, tech-debt #89) ───────────────
 * - Not an IPC command: nothing `nidara-ipc` or the agent can reach may answer it.
 *   Its one caller is a chooser started by xdpw, checked by walking the caller's
 *   process ancestry (the chooser has no bus name of its own to compare).
 * - Nothing is shared by default: closing the picker, or a picker that failed to
 *   appear, answers -1, and xdpw ends the request as declined.
 */

const SHARE_PATH = "/org/nidara/Shell/ScreenShare"

const SHARE_IFACE = `
<node>
  <interface name="org.nidara.Shell.ScreenShare">
    <method name="Choose">
      <arg type="as" name="lines" direction="in"/>
      <arg type="i" name="index" direction="out"/>
    </method>
  </interface>
</node>`

/** The tile's picture box, in px: a screen's shape at the size of a dock icon row. */
const THUMB_W = 160
const THUMB_H = 100

type Screen = { kind: "monitor"; index: number; name: string; label: string }
type Shared = { kind: "window"; index: number; address: string; title: string }
type Source = Screen | Shared

/** xdpw's lines, as the sources they name. A line we do not understand is not offered. */
export function parseChooserLines(lines: string[]): Source[] {
    const out: Source[] = []
    lines.forEach((line, index) => {
        const monitor = /^Monitor: (\S+)(?: (.*))?$/.exec(line)
        if (monitor) {
            out.push({ kind: "monitor", index, name: monitor[1], label: monitor[2]?.trim() || monitor[1] })
            return
        }
        // The identifier is the LAST parenthesis: a title may carry its own.
        const window = /^Window: (.*) \(([^()]*)\)$/.exec(line)
        if (window) out.push({ kind: "window", index, title: window[1], address: window[2] })
    })
    return out
}

/** Is `sender` a process xdpw started? Its chooser runs under `sh -c`, so a few levels up. */
function fromScreenCastPortal(sender: string | null): boolean {
    if (!sender) return false
    try {
        const reply = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetConnectionUnixProcessID", new GLib.Variant("(s)", [sender]),
            new GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, 1000, null,
        )
        let pid = (reply.deepUnpack() as [number])[0]
        for (let level = 0; level < 4 && pid > 1; level++) {
            const exe = GLib.file_read_link(`/proc/${pid}/exe`)
            if (GLib.path_get_basename(exe) === "xdg-desktop-portal-wlr") return true
            const [, status] = GLib.file_get_contents(`/proc/${pid}/status`)
            const ppid = /^PPid:\s+(\d+)$/m.exec(new TextDecoder().decode(status))
            pid = ppid ? Number(ppid[1]) : 0
        }
    } catch {
        // A process gone mid-walk, or one we may not read: not the portal's.
    }
    return false
}

/** A screen as it is now, small, through grim — taken BEFORE the picker is up, or it
 *  would show itself. Null on any failure: the tile keeps its icon. */
async function screenPicture(name: string): Promise<Gdk.Texture | null> {
    const monitor = compositor.monitors.find(m => m.name === name)
    if (!monitor) return null
    const logicalWidth = monitor.width / Math.max(monitor.scale, 0.01)
    const scale = Math.min(1, (THUMB_W * 2) / Math.max(logicalWidth, 1))
    const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), `nidara-share-${name}.png`])
    try {
        console.log(`[screenshare] taking a picture of ${name}`)
        await execAsync(["grim", "-o", name, "-s", scale.toFixed(3), "-t", "png", "-l", "0", path])
        const texture = Gdk.Texture.new_from_filename(path)
        GLib.unlink(path)
        return texture
    } catch (e) {
        console.warn(`[screenshare] no picture of ${name}: ${e}`)
        return null
    }
}

/** A capture inside the tile's box, at its own proportions (`AspectFrame`): a window
 *  is any shape, and the thumbnail paints whatever bounds it is given. */
function fitted(texture: Promise<Gdk.Texture | null> | Gdk.Texture | null, fallback: Gtk.Widget): Gtk.Widget {
    const thumb = makeWindowThumbnail()
    thumb.setRadius(6)
    const frame = new Gtk.AspectFrame({ ratio: THUMB_W / THUMB_H, obey_child: false, child: thumb })
    const stack = new Gtk.Stack({ hhomogeneous: true, vhomogeneous: true })
    stack.add_named(fallback, "fallback")
    stack.add_named(frame, "picture")
    const show = (tex: Gdk.Texture | null) => {
        if (!tex) return
        frame.ratio = tex.get_width() / Math.max(tex.get_height(), 1)
        thumb.setTexture(tex)
        stack.visible_child_name = "picture"
    }
    if (texture instanceof Promise) void texture.then(show)
    else show(texture)
    return stack
}

function tile(group: Gtk.ToggleButton | null, picture: Gtk.Widget, caption: string, icon: any | null): Gtk.ToggleButton {   // a GIcon — the GI typings do not export Gio.Icon
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
    const frame = new Gtk.Box({ css_classes: ["share-tile-picture"], width_request: THUMB_W, height_request: THUMB_H })
    picture.hexpand = true
    picture.vexpand = true
    frame.append(picture)
    box.append(frame)
    const row = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
    if (icon) {
        const image = Gtk.Image.new_from_gicon(icon)
        image.pixel_size = 16
        image.add_css_class("share-tile-icon")
        row.append(image)
    }
    row.append(new Gtk.Label({
        label: caption,
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 18,
        css_classes: ["share-tile-caption"],
    }))
    box.append(row)
    const button = new Gtk.ToggleButton({ child: box, css_classes: ["share-tile"] })
    if (group) button.set_group(group)
    button.set_tooltip_text(caption)
    return button
}

function section(heading: string, tiles: Gtk.Widget[]): Gtk.Widget {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
    box.append(new Gtk.Label({ label: heading, xalign: 0, css_classes: ["share-section-heading"] }))
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        max_children_per_line: 3,
        min_children_per_line: 1,
        column_spacing: 8,
        row_spacing: 8,
    })
    for (const tl of tiles) flow.append(tl)
    box.append(flow)
    return box
}

/** Asks the user which of `lines` to share; `reply` gets the index picked, or -1. */
async function choose(lines: string[], reply: (index: number) => void): Promise<void> {
    const sources = parseChooserLines(lines)
    if (sources.length === 0) {
        reply(-1)
        return
    }
    const screens = sources.filter((s): s is Screen => s.kind === "monitor")
    const windows = sources.filter((s): s is Shared => s.kind === "window")
    const pictures = new Map<number, Gdk.Texture | null>()
    await Promise.all(screens.map(async s => pictures.set(s.index, await screenPicture(s.name))))

    const buttons = new Map<number, Gtk.ToggleButton>()
    let group: Gtk.ToggleButton | null = null
    const add = (s: Source, picture: Gtk.Widget, caption: string, icon: any | null) => {
        const button = tile(group, picture, caption, icon)
        group ??= button
        buttons.set(s.index, button)
        return button
    }

    const screenTiles = screens.map(s => {
        const icon = Gtk.Image.new_from_gicon(uiIcon("nd-video-display"))
        icon.pixel_size = 48
        // The model names the screen as its maker does ("XV272U"); xdpw's line carries the
        // connector and the whole description, which does not fit a caption.
        const monitor = compositor.monitors.find(m => m.name === s.name)
        return add(s, fitted(pictures.get(s.index) ?? null, icon), monitor?.model || s.name, null)
    })
    const windowTiles = windows.map(s => {        const client = compositor.clients.find(c => c.address === s.address)
        const key = client ? appService.resolveHyprlandClass(client.class) : null
        const app = key ? appService.getResolvedApp(key) : null
        const gicon = app?.get_icon?.() ?? null
        const fallback = gicon ? Gtk.Image.new_from_gicon(gicon) : Gtk.Image.new_from_gicon(uiIcon("nd-video-display"))
        fallback.pixel_size = 48
        const picture = fitted(captureWindow(s.address, THUMB_W * 2, THUMB_H * 2), fallback)
        return add(s, picture, s.title || app?.name || "", gicon)
    })

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        margin_top: 16,
        margin_start: 24,
        margin_end: 24,
    })
    if (screenTiles.length > 0) content.append(section(t("share.screens"), screenTiles))
    if (windowTiles.length > 0) {
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            max_content_height: 360,
            child: section(t("share.windows"), windowTiles),
        })
        content.append(scroller)
    }
    const first = buttons.get(sources[0].index)
    first?.set_active(true)

    console.log(`[screenshare] ${screens.length} screen(s), ${windows.length} window(s); pictures taken, showing the picker`)
    showNidaraAlert({
        heading: t("share.title"),
        body: t("share.body"),
        appId: "nidara-share",
        icon: uiIcon("nd-screenshot"),
        width: 3 * THUMB_W + 2 * 8 + 2 * 24 + 32,
        cssClasses: ["nidara-share-picker"],
        content,
        responses: [
            { id: "cancel", label: t("share.cancel") },
            { id: "share", label: t("share.share"), suggested: true },
        ],
        onResponse: id => {
            const picked = [...buttons].find(([, b]) => b.active)?.[0] ?? -1
            reply(id === "share" ? picked : -1)
        },
    })
    // The selected tile holds the focus, so the window list opens at its top: left to GTK,
    // the focus went to the last tile and scrolled the list down to it (owner-seen).
    first?.grab_focus()
}

/** Register `org.nidara.Shell.ScreenShare` on the shell's session connection. Fail-soft. */
export function exportScreenShareService(): void {
    const impl = {
        ChooseAsync([lines]: [string[]], invocation: any) {
            if (!fromScreenCastPortal(invocation.get_sender())) {
                invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied",
                    "only a chooser started by the screen-cast portal may ask what to share")
                return
            }
            const reply = (index: number) => invocation.return_value(new GLib.Variant("(i)", [index]))
            choose(lines, reply).catch(e => {
                console.error("[screenshare] could not show the picker:", e)
                // Nothing shared: a picker that failed to appear asked nobody.
                reply(-1)
            })
        },
    }
    try {
        const exported = Gio.DBusExportedObject.wrapJSObject(SHARE_IFACE, impl)
        exported.export(Gio.DBus.session, SHARE_PATH)
        // Held for the life of the process: an unreferenced exported object is
        // collected and stops answering with no error.
        ;(exportScreenShareService as any)._exported = exported
    } catch (e) {
        console.error("[screenshare] could not export org.nidara.Shell.ScreenShare:", e)
    }
}
