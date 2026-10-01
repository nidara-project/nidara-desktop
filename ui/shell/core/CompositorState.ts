// CompositorState.ts — the compositor, as the shell sees it, whichever one it runs on.
//
// Nidara runs on two compositors while Hyalo, the one of our own, is built (#680):
// Hyprland (the default session) and Hyalo (the preview). The shell talks to ONE
// interface, `Compositor` below, and this module hands out the implementation for the
// session it is in:
//
//   - `core/HyprlandState.ts` — Hyprland, through its sockets and `hyprctl`;
//   - `core/HyaloState.ts`    — Hyalo, through its IPC (`core/hyalo-ipc.ts`).
//
// 🔑 Nothing outside those files names a compositor (#682). A surface that needs
// something from the window manager asks `compositor` for it, and when one compositor
// cannot do a thing the interface says so in `caps` rather than letting the call fail
// in silence — the window menu hides its group rows on Hyalo, which has no tab groups by
// the owner's decision (2026-10-01).
//
// What Settings chooses for the compositor — input, displays, workspace modes, game mode,
// reduce motion, the glass's blur — goes through `settings` (`CompositorSettings`): applied
// live and persisted in the compositor's own layer, Hyprland's `nidara-*.lua`
// (`core/hyprland-settings.ts`) or Hyalo's `hyalo-settings.toml` (`core/hyalo-settings.ts`).
// `scripts/ci/compositor-boundary-check.mjs` keeps every other file off the backends.
//
// The shapes below are the ones the shell was written against (they were AstalHyprland's,
// then HyprlandState's): a window's address is BARE hex, `fullscreen` is a mode number.
// Hyalo's backend maps its own JSON into them, so no surface had to change what it reads.

import GLib from "gi://GLib"
import type { CompositorObject, CompositorSettings } from "./compositor-types"
import { createHyprlandState, type HyprlandStateClass } from "./HyprlandState"
import { createHyaloState } from "./HyaloState"
import { createHyprlandSettings } from "./hyprland-settings"
import { createHyaloSettings } from "./hyalo-settings"

export * from "./compositor-types"

/** Whether this session's compositor is Hyalo: its socket is in the environment. */
export function onHyalo(): boolean {
    return !!GLib.getenv("HYALO_SOCKET")
}

// The backend is created here, and only the one for this session: creating HyprlandState
// on Hyalo would connect to sockets that are not there and say so loudly.
const instance = (onHyalo() ? createHyaloState() : createHyprlandState()) as unknown as CompositorObject

/** The settings the compositor owns, for this session's compositor. */
export const settings: CompositorSettings = instance.kind === "hyalo"
    ? createHyaloSettings()
    : createHyprlandSettings(instance as unknown as HyprlandStateClass)

export default instance
