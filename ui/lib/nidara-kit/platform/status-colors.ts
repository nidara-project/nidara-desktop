// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Nidara — semantic status colors (single source of truth)
 *
 * Fixed "this needs attention" / "this is good" colors — NOT part of the
 * user-selectable accent palette (see accent.ts). Used for things like a
 * critically low battery, an active recording indicator, or a charging state,
 * which must read consistently regardless of which accent the user picked.
 */

export const DANGER_HEX = "#ff3b30"
export const SUCCESS_HEX = "#30d158"
/** A WARNING, as opposed to an error — orange, as GNOME's (the platforms' `systemOrange`,
 *  the same light-appearance family as `DANGER_HEX`). Until 2026-09-29 there was no
 *  such colour and every symbolic icon's `warning` part was painted like its `error`
 *  part (#676 thread: a warning in red reads as a failure). */
export const WARNING_HEX = "#ff9500"
