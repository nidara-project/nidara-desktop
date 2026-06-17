import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"

import { t } from "../core/i18n"
import Icons from "../core/Icons"

// ── nmcli helpers ─────────────────────────────────────────────────────────────

interface VpnProfile { name: string; type: string; active: boolean }

async function listVpnProfiles(): Promise<VpnProfile[]> {
    try {
        const out = await execAsync(["nmcli", "-t", "-f", "NAME,TYPE,ACTIVE", "connection", "show"])
        return out.trim().split("\n")
            .map(line => {
                const parts = line.split(":")
                return { name: parts[0] ?? "", type: parts[1] ?? "", active: parts[2] === "yes" }
            })
            .filter(p => p.type === "vpn" || p.type === "wireguard")
    } catch {
        return []
    }
}

async function activeVpnName(): Promise<string | null> {
    const profiles = await listVpnProfiles()
    return profiles.find(p => p.active)?.name ?? null
}

// ── VPN controls (shared by bar expansion + CC popover) ──────────────────────

function buildVpnContent(onClose: () => void): Gtk.Widget {
    const listBox = new Gtk.ListBox({ css_classes: ["boxed-list"], selection_mode: Gtk.SelectionMode.NONE })
    const emptyLabel = new Gtk.Label({
        label: t("settings.network.vpn.no-profiles"),
        css_classes: ["nidara-row-subtitle"],
        margin_top: 10, margin_bottom: 10, margin_start: 14, margin_end: 14,
    })
    const spinner = new Gtk.Spinner({ spinning: true, margin_top: 10, margin_bottom: 10 })
    const stack = new Gtk.Stack()
    stack.add_named(spinner, "loading")
    stack.add_named(emptyLabel, "empty")
    stack.add_named(listBox, "list")
    stack.set_visible_child_name("loading")

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: PANEL_W.md, margin_top: 8, margin_bottom: 8 })
    box.append(stack)

    const refresh = () => {
        stack.set_visible_child_name("loading")
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        listVpnProfiles().then(profiles => {
            if (profiles.length === 0) {
                stack.set_visible_child_name("empty")
            } else {
                profiles.forEach(p => {
                    let active = p.active
                    const btn = new Gtk.Button({
                        valign: Gtk.Align.CENTER,
                        css_classes: active ? ["destructive-action"] : ["suggested-action"],
                        label: active ? t("settings.network.vpn.btn.disconnect") : t("settings.network.vpn.btn.connect"),
                    })
                    btn.connect("clicked", async () => {
                        btn.sensitive = false
                        btn.label = t("settings.network.vpn.btn.connecting")
                        try {
                            if (active) await execAsync(["nmcli", "connection", "down", p.name])
                            else        await execAsync(["nmcli", "connection", "up", p.name])
                        } catch (e) { console.error("[VPN widget]", e) }
                        onClose()
                    })
                    const typeTag = new Gtk.Label({ label: p.type === "wireguard" ? "WireGuard" : "VPN", css_classes: ["nidara-row-subtitle"], valign: Gtk.Align.CENTER })
                    const right = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
                    right.append(typeTag); right.append(btn)
                    const inner = new Gtk.Box({ spacing: 8, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10 })
                    const nameLabel = new Gtk.Label({ label: p.name, hexpand: true, halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 16, css_classes: ["nidara-row-title"] })
                    inner.append(nameLabel); inner.append(right)
                    const row = new Gtk.ListBoxRow({ css_classes: ["nidara-row"] })
                    row.set_child(inner); listBox.append(row)
                })
                stack.set_visible_child_name("list")
            }
        })
    }

    refresh()
    return box
}

// ── CC content ────────────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        const icon = new Gtk.Image({ gicon: Icons.shieldOff, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["nd-icon"] })
        box.append(icon)
        activeVpnName().then(name => { icon.gicon = name ? Icons.shield : Icons.shieldOff })
        return box
    }

    const inner = buildCapsuleInner(() => Icons.shieldOff, () => t("widget.vpn.name"), () => t("widget.vpn.sub.disconnected"))

    const syncState = (activeName: string | null) => {
        if (activeName) {
            inner.icon.gicon = Icons.shield
            inner.iconBox.add_css_class("vpn-active-bg")
            inner.subLabel.label = activeName
        } else {
            inner.icon.gicon = Icons.shieldOff
            inner.iconBox.remove_css_class("vpn-active-bg")
            inner.subLabel.label = t("widget.vpn.sub.disconnected")
        }
    }

    const refresh = () => activeVpnName().then(syncState)

    refresh()
    const timerId = GLib.timeout_add(GLib.PRIORITY_LOW, 10000, () => { refresh(); return GLib.SOURCE_CONTINUE })
    inner.box.connect("unrealize", () => { try { GLib.source_remove(timerId) } catch {} })

    return wrapCapsuleTile(inner.box)
}

// ── Bar icon ──────────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({ gicon: Icons.shieldOff, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
    activeVpnName().then(name => { image.gicon = name ? Icons.shield : Icons.shieldOff })
    return image
}

// ── Bar expansion panel content ───────────────────────────────────────────────

function buildBarExpanded(onClose: () => void): Gtk.Widget {
    return buildVpnContent(onClose)
}

// ── Widget registration ───────────────────────────────────────────────────────

const vpnWidget: AtomicWidget = {
    id: "vpn",
    name: t("widget.vpn.name"),
    icon: Icons.shield,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail: buildBarExpanded,
    ccDetailRows: 3,
}

export default vpnWidget
