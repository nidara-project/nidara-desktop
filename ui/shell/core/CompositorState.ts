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
// What is still Hyprland's alone — its config options, the Lua the shell generates for
// it — is reached through `hyprlandOnly()`, which is null on Hyalo: those callers do
// nothing there instead of failing. Moving them onto requests both compositors answer is
// #682's next part; `scripts/ci/compositor-boundary-check.mjs` holds the list of files
// still allowed to do it, and the list only shrinks.
//
// The shapes below are the ones the shell was written against (they were AstalHyprland's,
// then HyprlandState's): a window's address is BARE hex, `fullscreen` is a mode number.
// Hyalo's backend maps its own JSON into them, so no surface had to change what it reads.

import GLib from "gi://GLib"
import type { CompositorObject } from "./compositor-types"
import { createHyprlandState, type HyprlandStateClass } from "./HyprlandState"
import { createHyaloState } from "./HyaloState"

export * from "./compositor-types"

/** Whether this session's compositor is Hyalo: its socket is in the environment. */
export function onHyalo(): boolean {
    return !!GLib.getenv("HYALO_SOCKET")
}

// The backend is created here, and only the one for this session: creating HyprlandState
// on Hyalo would connect to sockets that are not there and say so loudly.
const instance = (onHyalo() ? createHyaloState() : createHyprlandState()) as unknown as CompositorObject

/** Hyprland's own state, for what only Hyprland has (its config options, Lua) — null on
 *  Hyalo, where the caller does nothing. Shrinks away in #682's next part. */
export function hyprlandOnly(): HyprlandStateClass | null {
    return instance.kind === "hyprland" ? (instance as unknown as HyprlandStateClass) : null
}

export default instance
