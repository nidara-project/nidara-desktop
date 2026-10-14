import Gtk from "gi://Gtk?version=4.0"
import app from "../../../lib/nidara-kit/platform/host"
import { showNidaraAlert } from "../../../lib/nidara-kit/alert-dialog"
import { t } from "../../core/i18n"

export async function runSettingsAction(action: () => void | Promise<unknown>): Promise<boolean> {
    try { await action(); return true }
    catch (e) {
        console.error("[Settings]", String(e))
        const parent = app.get_windows().find(w => w.get_visible()) as Gtk.Window | undefined
        if (parent) showNidaraAlert({ parent, heading: "Nidara Settings", body: String(e),
            responses: [{ id: "close", label: t("settings.window.close") }], onResponse: () => {} })
        return false
    }
}
