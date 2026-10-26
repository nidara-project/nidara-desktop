import { SHELL_ROOT } from "../shell/core/Paths"
import app from "../lib/nidara-kit/platform/host"
import { useNoGtkTheme } from "../lib/nidara-kit/platform/gtk-theme"
import { initAppearance } from "../lib/nidara-kit/platform/appearance-css"
import { withKitSheet } from "../lib/nidara-kit/platform/kit-css"
import { applyCrispFontRendering } from "../lib/nidara-kit/platform/font-rendering"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Settings from "../shell/surfaces/settings/Settings"
import { registerConfigEntries } from "../shell/config-entries"
import { setWidgetCatalog } from "../shell/core/WidgetCatalog"
import { createRemoteWidgetCatalog } from "../shell/core/WidgetCatalogRemote"
import queryUI from "../shell/core/UITree"
import compositor from "../shell/core/CompositorState"

useNoGtkTheme()
const ownPid = new Gio.Credentials().get_unix_pid()
const legacy = GLib.getenv("NIDARA_SETTINGS_LEGACY") === "1"
let window: Gtk.Window | null = null
// Held here, not in main(): a local is collected and the collection unexports the object,
// so `Request` stopped answering a while after startup.
let exported: ReturnType<typeof Gio.DBusExportedObject.wrapJSObject> | null = null
// The pages the native Settings draws, from the one list it keeps (routing.rs `DRAWN`):
// it starts this process with them. Going to one asks the entry point — the native
// Settings — to show it, and this window stays where it was.
const drawnNatively = new Set((GLib.getenv("NIDARA_SETTINGS_NATIVE_PAGES") ?? "").split(",").filter(Boolean))
const handedOver = (pageId: string): boolean => {
    if (!legacy || !drawnNatively.has(pageId)) return false
    // The click's activation token travels with the request: without one the compositor
    // does not raise a window over the one the person is using (routing.rs ACTIVATION_ARG).
    const token = Gdk.Display.get_default()?.get_app_launch_context().get_startup_notify_id(null, [])
    const args = token ? ["page", pageId, "--xdg-activation-token", token] : ["page", pageId]
    Gio.DBus.session.call("org.nidara.Settings", "/org/nidara/Settings", "org.nidara.Settings", "Request",
        new GLib.Variant("(as)", [args]), null, Gio.DBusCallFlags.NONE, -1, null,
        (bus, result) => { try { bus!.call_finish(result) } catch (e) { console.error("[Settings] Hand-over:", String(e)) } })
    return true
}
let initialized: Promise<void>
const raise = () => {
    if (!window) return
    window.present()
    const client = compositor.clients.find(c => c.pid === ownPid)
    if (client) compositor.focusWindow(client.address)
}
const interfaceXml = `<node><interface name="org.nidara.Settings"><method name="Request">
    <arg type="as" direction="in"/><arg type="s" direction="out"/>
    </method></interface></node>`
app.start({
    applicationId: legacy ? "org.nidara.SettingsLegacy" : "org.nidara.Settings", applicationName: "Nidara Settings", logDomain: "nidara-settings",
    // One name for both identities: Linux keeps 15 bytes, "nidara-settings-legacy" does not fit.
    processName: "nidara-settings",
    css: withKitSheet(`${GLib.getenv("NIDARA_SETTINGS_ROOT") || SHELL_ROOT}/style.css`),
    activate: () => { void initialized?.then(raise).catch(e => console.error(String(e))) },
    main() {
        applyCrispFontRendering()
        initAppearance()
        registerConfigEntries()
        initialized = (async () => {
            const catalog = await createRemoteWidgetCatalog()
            await catalog.ready
            setWidgetCatalog(catalog)
            window = Settings(undefined, handedOver)
            window.connect("close-request", () => { Gio.Settings.sync(); catalog.dispose(); app.quit(); return false })
            window.connect("notify::visible", () => {
                if (window && !window.visible) { Gio.Settings.sync(); catalog.dispose(); app.quit() }
            })
            raise()
        })()
        void initialized.catch(e => { console.error("[Settings] Startup:", String(e)); app.quit(1) })
        exported = Gio.DBusExportedObject.wrapJSObject(interfaceXml, {
            RequestAsync([args]: [string[]], invocation: Gio.DBusMethodInvocation) {
                void initialized.then(() => {
                    let response = "ok"
                    const win = window as any
                    const [verb, id] = args
                    if (verb === "queryUI") return JSON.stringify(queryUI(id))
                    if (verb === "page") {
                        if (!id || !win.navigateToPage(id)) response = `unknown page: ${id ?? ""} — valid: ${win.pageIds.join(", ")}`
                    } else if (verb === "app") {
                        if (!id) response = "usage: settingsApp <desktop-id>"
                        else if (!win.navigateToApp(id)) response = `no page for app: ${id} — Settings shows the list of apps`
                    } else if (verb !== "open") throw Error("Unknown Settings request")
                    raise()
                    return response
                }).then(text => invocation.return_value(new GLib.Variant("(s)", [text])))
                  .catch(e => invocation.return_value(new GLib.Variant("(s)", [`error: ${e}`])))
            },
        })
        exported.export(Gio.DBus.session, "/org/nidara/Settings")
    },
})
