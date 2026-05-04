import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

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

// ── Popover ───────────────────────────────────────────────────────────────────

function buildVpnPopover(anchor: Gtk.Widget): Gtk.Popover {
    const popover = new Gtk.Popover({ autohide: true })

    const listBox = new Gtk.ListBox({
        css_classes: ["boxed-list"],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    const emptyLabel = new Gtk.Label({
        label: t("settings.network.vpn.no-profiles"),
        css_classes: ["settings-row-subtitle"],
        margin_top: 10, margin_bottom: 10,
        margin_start: 14, margin_end: 14,
    })

    const spinner = new Gtk.Spinner({ spinning: true, margin_top: 10, margin_bottom: 10 })

    const stack = new Gtk.Stack()
    stack.add_named(spinner, "loading")
    stack.add_named(emptyLabel, "empty")
    stack.add_named(listBox, "list")
    stack.set_visible_child_name("loading")

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        width_request: 220,
        margin_top: 8, margin_bottom: 8,
    })
    box.append(stack)

    popover.set_child(box)
    popover.set_parent(anchor)
    anchor.connect("unrealize", () => { try { popover.unparent() } catch {} })

    const refresh = (onDone?: () => void) => {
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
                        label: active ? t("settings.network.vpn.btn.desconectar") : t("settings.network.vpn.btn.conectar"),
                    })
                    btn.connect("clicked", async () => {
                        btn.sensitive = false
                        btn.label = t("settings.network.vpn.btn.conectando")
                        try {
                            if (active) await execAsync(["nmcli", "connection", "down", p.name])
                            else        await execAsync(["nmcli", "connection", "up", p.name])
                        } catch (e) {
                            console.error("[VPN widget]", e)
                        }
                        popover.popdown()
                        onDone?.()
                    })

                    const typeTag = new Gtk.Label({
                        label: p.type === "wireguard" ? "WireGuard" : "VPN",
                        css_classes: ["settings-row-subtitle"],
                        valign: Gtk.Align.CENTER,
                    })

                    const right = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
                    right.append(typeTag)
                    right.append(btn)

                    const inner = new Gtk.Box({ spacing: 8, margin_start: 14, margin_end: 14, margin_top: 10, margin_bottom: 10 })
                    const nameLabel = new Gtk.Label({
                        label: p.name,
                        hexpand: true, halign: Gtk.Align.START,
                        ellipsize: 3, max_width_chars: 16,
                        css_classes: ["settings-row-label"],
                    })
                    inner.append(nameLabel)
                    inner.append(right)

                    const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
                    row.set_child(inner)
                    listBox.append(row)
                })
                stack.set_visible_child_name("list")
            }
            onDone?.()
        })
    }

    popover.connect("show", () => refresh())

    return popover
}

// ── CC content ────────────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const btn = new Gtk.Button({
            css_classes: ["cc-atomic-round-btn"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
        })
        const icon = new Gtk.Image({ gicon: Icons.shieldOff, pixel_size: 28, css_classes: ["cs-icon"] })
        btn.set_child(icon)
        const popover = buildVpnPopover(btn)
        popover.connect("closed", () => {
            activeVpnName().then(name => {
                icon.gicon = name ? Icons.shield : Icons.shieldOff
                btn.set_css_classes(name ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"])
            })
        })
        btn.connect("clicked", () => popover.popup())
        activeVpnName().then(name => {
            icon.gicon = name ? Icons.shield : Icons.shieldOff
            if (name) btn.add_css_class("active")
        })
        return btn
    }

    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({
        gicon: Icons.shieldOff,
        pixel_size: 26,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["cs-icon"],
    })
    iconBox.append(icon)

    const titleLabel = new Gtk.Label({
        label: t("widget.vpn.name"),
        css_classes: ["cc-atomic-label-bold"],
        halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14,
    })
    const subLabel = new Gtk.Label({
        label: t("widget.vpn.sub.disconnected"),
        css_classes: ["cc-atomic-label-dim"],
        halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 14,
    })

    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    textBox.append(titleLabel)
    textBox.append(subLabel)

    const inner = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER, margin_start: 4, hexpand: true })
    inner.append(iconBox)
    inner.append(textBox)
    btn.set_child(inner)

    const syncState = (activeName: string | null) => {
        if (activeName) {
            icon.gicon = Icons.shield
            iconBox.add_css_class("vpn-active-bg")
            subLabel.label = activeName
            btn.add_css_class("vpn-btn-active")
        } else {
            icon.gicon = Icons.shieldOff
            iconBox.remove_css_class("vpn-active-bg")
            subLabel.label = t("widget.vpn.sub.disconnected")
            btn.remove_css_class("vpn-btn-active")
        }
    }

    const refresh = () => activeVpnName().then(syncState)

    const popover = buildVpnPopover(btn)
    // After popover closes, refresh state
    popover.connect("closed", refresh)

    btn.connect("clicked", () => popover.popup())

    // Initial state + periodic refresh every 10s
    refresh()
    const timerId = GLib.timeout_add(GLib.PRIORITY_LOW, 10000, () => { refresh(); return GLib.SOURCE_CONTINUE })
    btn.connect("unrealize", () => { try { GLib.source_remove(timerId) } catch {} })

    return btn
}

// ── Bar content ───────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({
        gicon: Icons.shieldOff,
        pixel_size: 16,
        margin_start: 16, margin_end: 16,
        css_classes: ["cs-icon"],
    })

    const popover = buildVpnPopover(image)
    popover.connect("closed", () => {
        activeVpnName().then(name => {
            image.gicon = name ? Icons.shield : Icons.shieldOff
        })
    })

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

// ── Widget registration ───────────────────────────────────────────────────────

const vpnWidget: AtomicWidget = {
    id: "vpn",
    name: t("widget.vpn.name"),
    icon: Icons.shield,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent,
    buildBarContent,
}

export default vpnWidget
