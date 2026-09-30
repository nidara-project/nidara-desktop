// The IP and DNS form of one network profile — the cable's, or a saved Wi-Fi network's.
//
// Ethernet and Wi-Fi get the same TCP/IP and DNS settings (owner, 2026-09-28:
// complete, our own form, not nm-connection-editor). The shape:
//   · in an automatic mode the fields show what the network handed out, read-only;
//   · switching to Manual turns the same fields into entries, filled with those values,
//     so a fixed address starts from the one that works;
//   · nothing is written until Apply. Revert puts the saved profile back in the form.
// NetworkService owns every read and write; this file only draws and validates.

import Gtk from "gi://Gtk?version=4.0"
import { listGroup, createRow, dropdownRow, actionRow, staticLabel } from "../SettingsHelpers"
import { NidaraButton, NidaraFieldRow, bindWhileRealized } from "../../../../lib/nidara-kit"
import { t } from "../../../core/i18n"
import * as Net from "../../../core/NetworkService"

type MethodChoice = { value: string; label: string }

const V4_METHODS = (): MethodChoice[] => [
    { value: "auto", label: t("settings.network.ip.method.auto") },
    { value: "manual", label: t("settings.network.ip.method.manual") },
    { value: "link-local", label: t("settings.network.ip.method.link-local") },
    { value: "shared", label: t("settings.network.ip.method.shared") },
    { value: "disabled", label: t("settings.network.ip.method.disabled") },
]

const V6_METHODS = (): MethodChoice[] => [
    { value: "auto", label: t("settings.network.ip.method.auto6") },
    { value: "dhcp", label: t("settings.network.ip.method.dhcp6") },
    { value: "manual", label: t("settings.network.ip.method.manual") },
    { value: "link-local", label: t("settings.network.ip.method.link-local") },
    { value: "shared", label: t("settings.network.ip.method.shared") },
    { value: "disabled", label: t("settings.network.ip.method.disabled") },
    // NM's "leave it to something else"; not offered, but shown for what it is if set.
    { value: "ignore", label: t("settings.network.ip.method.ignore") },
]

/** A labelled value that becomes an entry in Manual. One row, one width, either way —
 *  and its fault printed INSIDE it, under the line, as every form of the kit does
 *  (NidaraFieldRow): a message at the foot of the page was out of sight of the field. */
function ipField(label: string, subtitle: string, widthChars: number) {
    const value = staticLabel("---")
    const entry = new Gtk.Entry({ width_chars: widthChars, valign: Gtk.Align.CENTER, visible: false })
    entry.update_property([Gtk.AccessibleProperty.LABEL], [label])
    const box = new Gtk.Box({ valign: Gtk.Align.CENTER })
    box.append(value)
    box.append(entry)
    const error = new Gtk.Label({ css_classes: ["nidara-field-error"], halign: Gtk.Align.FILL, hexpand: true, xalign: 0, wrap: true, visible: false })
    const row = createRow(label, subtitle, box, undefined, undefined, error)
    return {
        row, entry,
        setEditable(on: boolean) { value.visible = !on; entry.visible = on },
        show(text: string) { value.label = text || "---" },
        setError(message: string) {
            error.label = message
            error.visible = message !== ""
            if (message) row.add_css_class("nidara-row--error"); else row.remove_css_class("nidara-row--error")
        },
    }
}

/** A method dropdown whose value is NM's word, shown as ours. */
function methodRow(label: string, choices: MethodChoice[], init: string, onPick: (value: string) => void) {
    let apply: ((v: string) => void) | null = null
    const labelOf = (v: string) => choices.find(c => c.value === v)?.label ?? v
    // "ignore" is only listed when the profile already has it.
    const offered = choices.filter(c => c.value !== "ignore" || c.value === init)
    const row = dropdownRow(label, t("settings.network.ip.method.desc"), labelOf(init), offered.map(c => c.label),
        (picked) => onPick(choices.find(c => c.label === picked)?.value ?? picked),
        (a) => { apply = a; return () => { apply = null } })
    return { row, set: (v: string) => apply?.(labelOf(v)) }
}

const copy = (f: Net.IpForm): Net.IpForm => JSON.parse(JSON.stringify(f))

const SEARCH_DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i

/**
 * The form, as the groups of a Settings page plus its Apply bar. `target` names the
 * profile; the caller shows this only when there is one to edit (or, for the cable,
 * one that applying will create).
 */
export function buildIpSettings(target: Net.IpTarget): Gtk.Widget {
    const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24 })

    let saved = Net.ipForm(target)
    let form: Net.IpForm = copy(saved)
    let busy = false

    // ── IPv4 ──
    const g4 = listGroup(t("settings.network.ip.group.ipv4"))
    const m4 = methodRow(t("settings.network.ip.method4"), V4_METHODS(), form.v4.method, v => { form.v4.method = v; prefillManual(); sync() })
    const a4 = ipField(t("settings.network.ip.address"), t("settings.network.ip.address.desc"), 16)
    const k4 = ipField(t("settings.network.ip.mask"), t("settings.network.ip.mask.desc"), 16)
    const r4 = ipField(t("settings.network.ip.router"), t("settings.network.ip.router.desc"), 16)
    const renewBtn = NidaraButton({ label: t("settings.network.ip.renew.btn"), variant: "secondary", pill: true, valign: Gtk.Align.CENTER })
    const renewRow = createRow(t("settings.network.ip.renew"), t("settings.network.ip.renew.desc"), renewBtn)
    ;[m4.row, a4.row, k4.row, r4.row, renewRow].forEach(r => g4.listBox.append(r))
    root.append(g4.box)

    // ── IPv6 ──
    const g6 = listGroup(t("settings.network.ip.group.ipv6"))
    const m6 = methodRow(t("settings.network.ip.method6"), V6_METHODS(), form.v6.method, v => { form.v6.method = v; prefillManual(); sync() })
    const a6 = ipField(t("settings.network.ip.address"), t("settings.network.ip.address.desc"), 26)
    const p6 = ipField(t("settings.network.ip.prefix"), t("settings.network.ip.prefix.desc"), 5)
    const r6 = ipField(t("settings.network.ip.router"), t("settings.network.ip.router.desc"), 26)
    ;[m6.row, a6.row, p6.row, r6.row].forEach(r => g6.listBox.append(r))
    root.append(g6.box)

    // ── DNS ──
    const gd = listGroup(t("settings.network.ip.group.dns"))
    const dnsEntry = new Gtk.Entry({ hexpand: true })
    dnsEntry.update_property([Gtk.AccessibleProperty.LABEL], [t("settings.network.ip.dns")])
    const searchEntry = new Gtk.Entry({ hexpand: true })
    searchEntry.update_property([Gtk.AccessibleProperty.LABEL], [t("settings.network.ip.search")])
    const dnsField = NidaraFieldRow(t("settings.network.ip.dns"), t("settings.network.ip.dns.desc"), dnsEntry)
    const searchField = NidaraFieldRow(t("settings.network.ip.search"), t("settings.network.ip.search.desc"), searchEntry)
    gd.listBox.append(dnsField.row)
    gd.listBox.append(searchField.row)
    root.append(gd.box)

    // ── Apply ──
    const message = new Gtk.Label({ css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.FILL, hexpand: true, xalign: 0, wrap: true })
    const revertBtn = NidaraButton({ label: t("settings.network.ip.revert"), variant: "secondary", pill: true })
    const applyBtn = NidaraButton({ label: t("settings.network.ip.apply"), variant: "primary", pill: true })
    const bar = new Gtk.Box({ spacing: 12 })
    bar.append(message)
    bar.append(actionRow(revertBtn, applyBtn))
    root.append(bar)

    // What an entry holds IS the form: every keystroke goes straight into it.
    const bind = (e: Gtk.Entry, set: (v: string) => void) => e.connect("changed", () => { if (!loading) { set(e.get_text()); sync() } })
    let loading = false
    bind(a4.entry, v => { form.v4.address = v })
    bind(k4.entry, v => { form.v4.prefix = v })
    bind(r4.entry, v => { form.v4.gateway = v })
    bind(a6.entry, v => { form.v6.address = v })
    bind(p6.entry, v => { form.v6.prefix = v })
    bind(r6.entry, v => { form.v6.gateway = v })
    bind(dnsEntry, v => { form.dns = v })
    bind(searchEntry, v => { form.search = v })

    /** Going to Manual starts from what the network gave, if the fields are empty. */
    function prefillManual() {
        const live = Net.ipLive(target)
        if (form.v4.method === "manual" && !form.v4.address && live.v4)
            form.v4 = { method: "manual", address: live.v4.address, prefix: live.v4.mask, gateway: live.v4.gateway }
        if (form.v6.method === "manual" && !form.v6.address && live.v6)
            form.v6 = { method: "manual", address: live.v6.address, prefix: live.v6.prefix, gateway: live.v6.gateway }
        fillEntries()
    }

    function fillEntries() {
        loading = true
        a4.entry.set_text(form.v4.address); k4.entry.set_text(form.v4.prefix); r4.entry.set_text(form.v4.gateway)
        a6.entry.set_text(form.v6.address); p6.entry.set_text(form.v6.prefix); r6.entry.set_text(form.v6.gateway)
        dnsEntry.set_text(form.dns); searchEntry.set_text(form.search)
        loading = false
    }

    /** Every fault at once, each in its own row. True when the form can be applied. */
    function validate(): boolean {
        let ok = true
        const check = (setError: (m: string) => void, bad: boolean, msg: string) => { setError(bad ? msg : ""); if (bad) ok = false }
        const m4on = form.v4.method === "manual"
        check(a4.setError, m4on && !Net.isIPv4(form.v4.address.trim()), t("settings.network.ip.error.address"))
        check(k4.setError, m4on && Net.prefixOfMask(form.v4.prefix) === null, t("settings.network.ip.error.mask"))
        check(r4.setError, m4on && !!form.v4.gateway.trim() && !Net.isIPv4(form.v4.gateway.trim()), t("settings.network.ip.error.router"))
        const m6on = form.v6.method === "manual"
        const plen = Number(form.v6.prefix)
        check(a6.setError, m6on && !Net.isIPv6(form.v6.address.trim()), t("settings.network.ip.error.address"))
        check(p6.setError, m6on && !(Number.isInteger(plen) && plen >= 1 && plen <= 128), t("settings.network.ip.error.prefix"))
        check(r6.setError, m6on && !!form.v6.gateway.trim() && !Net.isIPv6(form.v6.gateway.trim()), t("settings.network.ip.error.router"))
        check(dnsField.setError, Net.splitList(form.dns).some(d => !Net.isIPv4(d) && !Net.isIPv6(d)), t("settings.network.ip.error.dns"))
        check(searchField.setError, Net.splitList(form.search).some(d => !SEARCH_DOMAIN.test(d)), t("settings.network.ip.error.search"))
        return ok
    }

    // Fields a non-manual method does not use are not a change: switching to Manual and
    // back must not leave Apply lit.
    const essence = (f: Net.IpForm) => JSON.stringify({
        v4: f.v4.method === "manual" ? f.v4 : { method: f.v4.method },
        v6: f.v6.method === "manual" ? f.v6 : { method: f.v6.method },
        dns: Net.splitList(f.dns), search: Net.splitList(f.search),
    })
    const dirty = () => essence(form) !== essence(saved)

    /** Draw the form from `form` and what the device is using now. */
    function sync() {
        const live = Net.ipLive(target)
        const man4 = form.v4.method === "manual", off4 = form.v4.method === "disabled"
        ;[a4, k4, r4].forEach(f => { f.setEditable(man4); f.row.visible = !off4 })
        a4.show(live.v4?.address ?? ""); k4.show(live.v4?.mask ?? ""); r4.show(live.v4?.gateway ?? "")
        renewRow.visible = form.v4.method === "auto" && saved.v4.method === "auto" && !!target.liveDevice()

        const man6 = form.v6.method === "manual", off6 = form.v6.method === "disabled" || form.v6.method === "ignore"
        ;[a6, p6, r6].forEach(f => { f.setEditable(man6); f.row.visible = !off6 })
        a6.show(live.v6?.address ?? ""); p6.show(live.v6?.prefix ?? ""); r6.show(live.v6?.gateway ?? "")

        // Empty means "the network's": say which those are.
        dnsEntry.placeholder_text = live.dns.join(", ") || t("settings.network.ip.dns.auto")
        searchEntry.placeholder_text = live.search.join(", ")

        const valid = validate()
        const changed = dirty()
        applyBtn.sensitive = !busy && changed && valid
        revertBtn.sensitive = !busy && changed
    }

    function load() {
        saved = Net.ipForm(target)
        form = copy(saved)
        m4.set(form.v4.method); m6.set(form.v6.method)
        fillEntries()
        sync()
    }

    revertBtn.connect("clicked", load)
    applyBtn.connect("clicked", () => {
        busy = true
        message.label = t("settings.network.ip.applying")
        sync()
        Net.applyIp(target, form)
            .then(() => { busy = false; message.label = ""; load() })
            .catch(e => {
                console.error("[Network] applying IP settings failed:", e)
                busy = false
                sync()
                message.label = t("settings.network.ip.error.save")
            })
    })
    renewBtn.connect("clicked", () => {
        renewBtn.sensitive = false
        Net.renewDhcp(target)
            .catch(e => console.error("[Network] DHCP renew failed:", e))
            .finally(() => { renewBtn.sensitive = true })
    })

    // A change made elsewhere (nmcli, a DHCP answer) redraws the live values; it only
    // replaces what the user is typing when there is nothing typed yet.
    bindWhileRealized(root, () => {
        const off = target.watch(() => { if (busy) return; if (dirty()) sync(); else load() })
        load()
        return off
    })

    fillEntries()
    sync()
    return root
}
