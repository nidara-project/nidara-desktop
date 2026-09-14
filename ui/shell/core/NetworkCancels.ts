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
 * ⚠️ In-process only. It works because today the agent and every joiner share the shell.
 * A Settings APPLICATION (#571) joining a network gets its prompt from the shell's agent,
 * so the record lands in the shell and Settings reads an empty map: a cancelled prompt
 * reports as "failed" (the row says the network failed instead of staying quiet). When the
 * agent moves out (#574) the fact has to travel with the reply — over D-Bus.
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
