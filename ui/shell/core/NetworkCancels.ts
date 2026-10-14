import { isSettingsProcess, settingsShellRequest } from "./SettingsProcess"
/**
 * Connection UUIDs whose secrets dialog the user dismissed, with when. NM does not carry
 * that fact to the activation: a cancelled prompt ends it with reason DEVICE_DISCONNECTED,
 * not NO_SECRETS (measured), so the agent that showed the dialog records it here and the
 * activation that failed reads it back.
 *
 * A leaf of its own, not part of core/NetworkAgent: NetworkService reads it, Settings
 * imports NetworkService, and importing the agent put NetworkManager's secret agent into
 * anything that builds the Network page (#571).
 *
 * The record lives with the secret agent in the shell. A joiner in the Settings
 * application consumes it over D-Bus through consumeUserCancel (#571), so cancelling
 * a password prompt does not become a spurious connection failure.
 */
const userCancels = new Map<string, number>()

export function recordUserCancel(uuid: string): void {
    userCancels.set(uuid, Date.now())
}

/** Did the user dismiss the secrets dialog for the connection `uuid` in the last
 *  half-minute? Consumes the record, so one cancel explains one failed attempt. */
export function takeUserCancel(uuid: string): boolean {
    const at = userCancels.get(uuid)
    userCancels.delete(uuid)
    return at !== undefined && Date.now() - at < 30_000
}

/** A joiner in Settings consumes the shell agent's result, not a second empty map. */
export async function consumeUserCancel(uuid: string): Promise<boolean> {
    if (!isSettingsProcess) return takeUserCancel(uuid)
    try { return (await settingsShellRequest(["takeNetworkCancel", uuid])) === "true" }
    catch (e) { console.warn("[NetworkCancels]", String(e)); return false }
}
