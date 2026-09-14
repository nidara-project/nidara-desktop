import { showNidaraAlert, type AlertHandle } from "../../../lib/nidara-kit"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { startNetworkAgent, validPsk, type WifiSecretsRequest } from "../../core/NetworkAgent"

// The face of core/NetworkAgent: the dialog NetworkManager's password questions
// land in. Session-wide, not tied to Settings — NM asks whenever it needs a key:
// a network joined from Settings, a saved network whose router password changed
// while the laptop slept, the Live medium before the installer can continue.
//
// A parentless dialog on purpose: the question can arrive with nothing of ours
// open. It declares the Settings app-id so the window list names it after the
// app that owns networks, as Settings' own dialogs do.

let open: AlertHandle | null = null

function prompt(req: WifiSecretsRequest): Promise<string | null> {
    return new Promise(resolve => {
        open = showNidaraAlert({
            appId: "nidara-settings",
            icon: Icons.wifi,
            heading: t(req.retry ? "network.prompt.heading.retry" : "network.prompt.heading").replace("%s", req.ssid),
            body: t(req.retry ? "network.prompt.body.retry" : "network.prompt.body"),
            // No trim: a WPA key may begin or end with a space, and a trimmed one
            // can never match.
            entry: { password: true, placeholder: t("network.prompt.placeholder"), valid: text => validPsk(text, req.keyMgmt) },
            responses: [
                { id: "cancel", label: t("network.prompt.cancel") },
                { id: "connect", label: t("network.prompt.connect"), suggested: true },
            ],
            onResponse: (id, text) => {
                open = null
                resolve(id === "connect" && text !== undefined && validPsk(text, req.keyMgmt) ? text : null)
            },
        })
    })
}

/** Serve NetworkManager's secret requests for the whole session. Called once from app.ts. */
export function startWifiPasswordPrompt(): void {
    startNetworkAgent({
        prompt,
        cancel: () => { open?.close(); open = null },
    })
}
