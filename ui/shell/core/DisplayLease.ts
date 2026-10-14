import type { MonitorSetting } from "./compositor-types"

export interface DisplayLeaseWorld {
    snapshot(name: string): MonitorSetting
    apply(name: string, cfg: MonitorSetting): void
    save(name: string, cfg: MonitorSetting): void
    later(revert: () => void): () => void
    token(): string
    record?(token: string, name: string, before: MonitorSetting): void
    forget?(token: string): void
}

/** The shell owns the rollback, including when Settings crashes or vanishes. */
export function displayLeases(world: DisplayLeaseWorld) {
    const pending = new Map<string, { owner: string; name: string; before: MonitorSetting; after: MonitorSetting; cancel: () => void }>()
    const get = (token: string, owner: string) => {
        const lease = pending.get(token)
        if (!lease || lease.owner !== owner) throw Error("Display preview expired or belongs to another client")
        return lease
    }
    const revert = (token: string) => {
        const lease = pending.get(token)
        if (!lease) return
        world.apply(lease.name, lease.before)
        world.forget?.(token)
        pending.delete(token); lease.cancel()
    }
    return {
        preview(owner: string, name: string, patch: Partial<MonitorSetting>) {
            if ([...pending.values()].some(p => p.name === name)) throw Error("Display already has a pending confirmation")
            const before = world.snapshot(name), after = { ...before, ...patch }
            const token = world.token()
            world.record?.(token, name, before) // Durable rollback before changing the output.
            try { world.apply(name, after) }
            catch (e) { world.forget?.(token); throw e }
            const lease = { owner, name, before, after, cancel: () => {} }
            pending.set(token, lease)
            lease.cancel = world.later(() => revert(token))
            return token
        },
        commit(token: string, owner: string) {
            const lease = get(token, owner)
            world.save(lease.name, lease.after) // Do not disarm recovery if saving fails.
            world.forget?.(token)
            pending.delete(token); lease.cancel()
        },
        cancel(token: string, owner: string) { get(token, owner); revert(token) },
        ownerLost(owner: string) {
            for (const [token, lease] of pending) if (lease.owner === owner) revert(token)
        },
        before(name: string) { return [...pending.values()].find(p => p.name === name)?.before },
        pending(name: string) { return [...pending.values()].some(p => p.name === name) },
    }
}
