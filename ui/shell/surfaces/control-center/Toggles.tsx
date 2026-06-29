import { Gtk } from "ags/gtk4"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import { CCWidgetSpec, WidgetSize } from "./Types"
import { t } from "../../core/i18n"
import Gio from "gi://Gio"
import Icons from "../../core/Icons"
import * as Net from "../../core/NetworkService"
import { safeDisconnect } from "../../core/signals"

function setIcon(img: Gtk.Image, icon: Gio.FileIcon) {
    img.gicon = icon
}

// Shared capsule layout: icon circle + title/subtitle text stack
type SubscribeFn = (sync: () => void) => () => void

// Single source of truth for the 2×1 (WIDE) capsule inner layout: a 48px icon
// circle + title/subtitle stack. Both the interactive RoundToggle capsules
// (bluetooth, focus — wrapped in a button below) and the plain detail-opening
// tiles (wifi, ethernet, vpn, clipboard, screenshot — which can't be a button,
// or they'd swallow the tile's detail tap) consume this so every 2×1 widget is
// spaced/aligned identically. Returns the box plus refs + an update() that
// re-reads the getters. Keep this the *only* place these dimensions live.
export interface CapsuleInner {
    box: Gtk.Box
    iconBox: Gtk.Box
    icon: Gtk.Image
    label: Gtk.Label
    subLabel: Gtk.Label
    update: () => void
}

export function buildCapsuleInner(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
): CapsuleInner {
    // box fills the island (hexpand) so a non-expanding child isn't centred by the
    // SquircleContainer — that's what pushes a plain (non-button) tile to the right.
    // The expanding textStack then absorbs the trailing slack, pinning the icon hard
    // left. Works identically whether this box is the island's direct child (wifi,
    // ethernet, …) or nested inside a cc-capsule-btn (bluetooth, focus).
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        margin_start: 4,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["nd-icon"] })
    setIcon(icon, getIcon())
    iconBox.append(icon)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const label = new Gtk.Label({ label: getTitle(), css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 14 })
    const subLabel = new Gtk.Label({ css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 14 })

    // Stateful vs stateless tile. A widget with an on/off-style status (wifi,
    // bluetooth, focus…) shows a single-line title + its state subtitle. An action
    // widget with no such state (screenshot, screen recording, clipboard) returns an
    // empty subtitle: we hide the sub line and let the title use both lines, kept
    // vertically centred — so the name reads in full ("Screen Recording") instead of
    // padding it out with a fake status line. Derived from the subtitle so dynamic
    // widgets (focus off → no sub) get the right shape too.
    const applySub = (sub: string) => {
        const hasSub = sub.length > 0
        subLabel.label = sub
        subLabel.visible = hasSub
        label.wrap = !hasSub        // lines only takes effect while wrapping
        label.lines = hasSub ? 1 : 2
    }

    textStack.append(label)
    textStack.append(subLabel)
    box.append(iconBox)
    box.append(textStack)
    applySub(getSubTitle())          // also fixes plain tiles that never call update()

    const update = () => {
        setIcon(icon, getIcon())
        label.label = getTitle()
        applySub(getSubTitle())
    }
    return { box, iconBox, icon, label, subLabel, update }
}

// Non-button tiles (the open-detail capsules: wifi, ethernet, vpn, clipboard,
// screenshot) must return this, not the bare capsule box. BaseIsland's
// SquircleContainer overwrites its direct child's margins with its 12px padding;
// the button-wrapped capsules survive that because the padding lands on the button
// and the inner box keeps its margin_start. Plain tiles need the same extra nesting
// level or their icon sits 4px further left/misaligned. The outer box absorbs the
// padding so the capsule box keeps its margin_start — matching the button tiles 1:1.
export function wrapCapsuleTile(box: Gtk.Box): Gtk.Box {
    const outer = new Gtk.Box({
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })
    outer.append(box)
    return outer
}

function buildCapsuleContent(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
    onClick: () => void,
    getActive?: () => boolean,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })

    const inner = buildCapsuleInner(getIcon, getTitle, getSubTitle)
    btn.set_child(inner.box)

    const update = () => {
        inner.update()
        if (getActive) {
            if (getActive()) btn.add_css_class("active")
            else btn.remove_css_class("active")
        }
    }

    btn.connect("clicked", () => { onClick(); update() })
    if (subscribe) {
        const cleanup = subscribe(update)
        btn.connect("unrealize", cleanup)
    }
    update()
    return btn
}

// Single (1×1) round button
function buildRoundContent(
    getIcon: () => Gio.FileIcon,
    getActive: () => boolean,
    onClick: () => void,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const syncClasses = () => {
        btn.set_css_classes(getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"])
        setIcon(icon, getIcon())
    }
    const btn = new Gtk.Button({
        css_classes: getActive() ? ["cc-atomic-round-btn", "active"] : ["cc-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ pixel_size: 28, css_classes: ["nd-icon"] })
    setIcon(icon, getIcon())
    btn.set_child(icon)
    btn.connect("clicked", () => { onClick(); syncClasses() })
    if (subscribe) {
        const cleanup = subscribe(syncClasses)
        btn.connect("unrealize", cleanup)
    }
    return btn
}

export function EthernetWidget(): CCWidgetSpec {
    const network = AstalNetwork.get_default()
    const wired   = network?.wired

    const getIcon   = () => Icons.ethernet
    const getActive = () => Net.wiredConnected(wired)
    const getSub = () => {
        if (!wired) return t("cc.ethernet.sub.no-cable")
        if (!Net.wiredConnected(wired)) return t("cc.ethernet.sub.disconnected")
        return (wired as any).device?.interface || t("cc.ethernet.sub.connected")
    }
    const subscribe: SubscribeFn = (sync) => {
        if (!wired) return () => {}
        const ids = [
            (wired as any).connect("notify::internet",    sync),
            (wired as any).connect("notify::ip4-address", sync),
        ]
        return () => ids.forEach(id => safeDisconnect(wired, id))
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, () => {}, subscribe)
        return buildCapsuleContent(getIcon, () => t("cc.ethernet.name"), getSub, () => {}, getActive, subscribe)
    }

    return { id: "ethernet", name: t("cc.ethernet.name"), defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE], buildContent }
}

export function WifiWidget(): CCWidgetSpec {
    const wifi   = AstalNetwork.get_default()?.wifi
    const toggle = () => Net.toggleWifi()

    const getIcon   = () => Net.wifiEnabled(wifi) ? Icons.wifi : Icons.wifiOff
    const getActive = () => !!(Net.wifiEnabled(wifi) && (wifi as any)?.ssid)
    const getSub    = () => {
        if (!wifi) return t("cc.wifi.sub.off")
        return (wifi as any).ssid || (Net.wifiEnabled(wifi) ? t("cc.wifi.sub.connected") : t("cc.wifi.sub.off"))
    }
    const subscribe: SubscribeFn = (sync) => {
        if (!wifi) return () => {}
        const id = (wifi as any).connect("notify", sync)
        return () => safeDisconnect(wifi, id)
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, toggle, subscribe)
        return buildCapsuleContent(getIcon, () => t("cc.wifi.name"), getSub, toggle, getActive, subscribe)
    }

    return { id: "wifi", name: t("cc.wifi.name"), defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE], buildContent }
}

export function FocusWidget(): CCWidgetSpec {
    const notifd  = AstalNotifd.get_default()
    const toggle  = () => { if (notifd) notifd.dont_disturb = !notifd.dont_disturb }
    const getIcon = () => notifd?.dont_disturb ? Icons.bellOff : Icons.bell
    const getActive = () => !!notifd?.dont_disturb
    const subscribe: SubscribeFn = (sync) => {
        if (!notifd) return () => {}
        const id = (notifd as any).connect("notify", sync)
        return () => safeDisconnect(notifd, id)
    }

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, toggle, subscribe)
        return buildCapsuleContent(
            getIcon,
            () => notifd?.dont_disturb ? t("cc.focus.title.on") : t("cc.focus.title.off"),
            () => notifd?.dont_disturb ? t("cc.focus.sub.on") : "",
            toggle, getActive, subscribe,
        )
    }

    return { id: "focus", name: t("cc.focus.name"), defaultSize: WidgetSize.WIDE, supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE], buildContent }
}

export function RoundToggle(
    id: string,
    name: string,
    iconName: Gio.FileIcon | (() => Gio.FileIcon),
    active: boolean | (() => boolean),
    onClick: () => void,
    wideSubtitle?: () => string,
    subscribe?: SubscribeFn,
): CCWidgetSpec {
    const getActive = typeof active === "function" ? active : () => active
    const getIcon   = typeof iconName === "function" ? iconName : () => iconName
    const getSub    = wideSubtitle ?? (() => "")

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return buildRoundContent(getIcon, getActive, onClick, subscribe)
        return buildCapsuleContent(getIcon, () => name, getSub, onClick, getActive, subscribe)
    }

    return {
        id, name,
        defaultSize: WidgetSize.SINGLE,
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
        buildContent,
    }
}
