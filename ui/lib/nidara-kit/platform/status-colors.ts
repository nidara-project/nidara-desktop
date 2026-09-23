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
