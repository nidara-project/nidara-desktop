import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { showNidaraAlert, type AlertChoice, type AlertHandle } from "../../../lib/nidara-kit"
import { appService } from "../../core/AppService"
import { t } from "../../core/i18n"

/**
 * NIDARA — the desktop asking the user, on an app's behalf
 * ========================================================
 *
 * `bin/nidara-portal` is Nidara's XDG portal backend, and it is a plain GJS script
 * with no GTK: it serves Settings and Wallpaper, which need no window. A CONSENT
 * dialog does need one — and it has to look like this desktop, speak its twelve
 * languages, and (later) read the same decisions Settings → Apps shows per app. The
 * shell already has all three, so the portal backend forwards each prompt here and
 * this file draws it. It is the same split GNOME uses: xdg-desktop-portal-gnome
 * hands Access prompts to gnome-shell.
 *
 *   app ──portal──▶ xdg-desktop-portal ──impl.Access──▶ nidara-portal
 *                                                          │ org.nidara.Shell.Consent
 *                                                          ▼
 *                                                   this file: the dialog
 *
 * ── Rules this file keeps (tech-debt #89 is where they come from) ─────────────
 * - It is NOT an IPC command. `IPC_COMMANDS` are listed by `nidara-ipc listActions`
 *   and driven by the agent and the MCP server; nothing that can answer a consent
 *   prompt may be reachable from there. This is its own interface, and it serves
 *   exactly one caller: the process that owns the portal backend's bus name. Any
 *   other sender gets AccessDenied.
 * - It never grants by default. Closing the dialog, the app cancelling the request,
 *   or the shell going away all answer "denied".
 * - Remembering the answer is NOT done here: for the interfaces that persist a
 *   decision (camera, location…), xdg-desktop-portal itself reads the
 *   PermissionStore before calling the backend and writes the answer after. Settings
 *   → Apps will read and edit that same store — one place for the decision.
 */

const CONSENT_PATH = "/org/nidara/Shell/Consent"
const PORTAL_BACKEND_NAME = "org.freedesktop.impl.portal.desktop.nidara"

const CONSENT_IFACE = `
<node>
  <interface name="org.nidara.Shell.Consent">
    <method name="AccessDialog">
      <arg type="s" name="handle" direction="in"/>
      <arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="subtitle" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/>
      <arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="Close">
      <arg type="s" name="handle" direction="in"/>
    </method>
  </interface>
</node>`

/** Portal response codes: 0 granted / success, 1 cancelled by the user, 2 other. */
const RESPONSE_GRANTED = 0
const RESPONSE_DENIED = 1

/** Open prompts by request handle, so `Close` can dismiss the right one. */
const open = new Map<string, AlertHandle>()

function unpack<T>(v: unknown, dflt: T): T {
    const b = v as { deepUnpack?: () => unknown } | undefined
    const out = b && typeof b.deepUnpack === "function" ? b.deepUnpack() : v
    return (out ?? dflt) as T
}

/**
 * Is this call from the portal backend? Compared by UNIQUE name, looked up at call
 * time: the backend is D-Bus-activated and restarts, so a name captured at startup
 * would go stale.
 */
function fromPortalBackend(sender: string | null): boolean {
    if (!sender) return false
    try {
        const reply = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "GetNameOwner", new GLib.Variant("(s)", [PORTAL_BACKEND_NAME]),
            new GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 1000, null,
        )
        return (reply.deepUnpack() as [string])[0] === sender
    } catch {
        return false
    }
}

/**
 * The spec's `choices` are `a(ssa(ss)s)`: (id, label, options, initial). An EMPTY
 * options list is a boolean check box — the only kind Access prompts use in
 * practice — and those are what this shows. A choice with options is not drawn
 * yet; its initial value is returned unchanged, so the caller still gets every id
 * it asked about, and the gap is logged instead of silently answered.
 */
function readChoices(raw: unknown): { shown: AlertChoice[]; fixed: Record<string, string> } {
    const shown: AlertChoice[] = []
    const fixed: Record<string, string> = {}
    for (const [id, label, options, initial] of unpack<[string, string, [string, string][], string][]>(raw, [])) {
        if (options.length === 0) shown.push({ id, label, initial: initial === "true" })
        else {
            console.warn(`[consent] choice "${id}" has ${options.length} options — not drawn yet, answering its initial "${initial}"`)
            fixed[id] = initial
        }
    }
    return { shown, fixed }
}

function accessDialog(
    [handle, appId, parentWindow, title, subtitle, body, options]:
        [string, string, string, string, string, string, Record<string, unknown>],
    reply: (response: number, choices: Record<string, string>) => void,
): void {
    const app = appId ? appService.getResolvedApp(appId) : null
    const { shown, fixed } = readChoices(options?.choices)
    const icon = app?.get_icon?.() ?? (unpack<string>(options?.icon, "") || "dialog-question-symbolic")

    const handleRef = showNidaraAlert({
        parentWindow,
        appId: "nidara-consent",
        icon,
        heading: title,
        // The frontend already words `title`/`subtitle` in the user's language and
        // names the app; `body` is the reason the APP gave, when it gave one.
        body: [subtitle, body].filter(Boolean).join("\n\n"),
        choices: shown,
        responses: [
            { id: "deny", label: unpack<string>(options?.deny_label, "") || t("consent.deny") },
            { id: "grant", label: unpack<string>(options?.grant_label, "") || t("consent.allow"), suggested: true },
        ],
        onResponse: (id, _text, choices) => {
            open.delete(handle)
            reply(id === "grant" ? RESPONSE_GRANTED : RESPONSE_DENIED, { ...fixed, ...(choices ?? {}) })
        },
    })
    open.set(handle, handleRef)
}

/** Register `org.nidara.Shell.Consent` on the shell's session connection. Fail-soft. */
export function exportConsentService(): void {
    const impl = {
        AccessDialogAsync(params: any[], invocation: any) {
            if (!fromPortalBackend(invocation.get_sender())) {
                invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied",
                    "only the Nidara portal backend may raise a consent prompt")
                return
            }
            try {
                accessDialog(params as any, (response, choices) => {
                    const results: Record<string, GLib.Variant> = {}
                    const pairs = Object.entries(choices)
                    if (pairs.length > 0) results.choices = new GLib.Variant("a(ss)", pairs)
                    invocation.return_value(new GLib.Variant("(ua{sv})", [response, results]))
                })
            } catch (e) {
                console.error("[consent] could not show the prompt:", e)
                // Denied, never granted: a prompt that failed to appear asked nobody.
                invocation.return_value(new GLib.Variant("(ua{sv})", [RESPONSE_DENIED, {}]))
            }
        },
        CloseAsync([handle]: [string], invocation: any) {
            if (!fromPortalBackend(invocation.get_sender())) {
                invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied",
                    "only the Nidara portal backend may close a consent prompt")
                return
            }
            // Closing answers the pending AccessDialog as denied (the alert's cancel).
            open.get(handle)?.close()
            invocation.return_value(null)
        },
    }
    try {
        const exported = Gio.DBusExportedObject.wrapJSObject(CONSENT_IFACE, impl)
        exported.export(Gio.DBus.session, CONSENT_PATH)
        // Held for the life of the process: an unreferenced exported object is
        // collected and stops answering with no error.
        ;(exportConsentService as any)._exported = exported
    } catch (e) {
        console.error("[consent] could not export org.nidara.Shell.Consent:", e)
    }
}
