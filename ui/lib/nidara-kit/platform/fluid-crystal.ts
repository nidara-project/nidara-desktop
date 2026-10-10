// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * The public semantic contract for Nidara's Fluid Crystal.
 *
 * This file deliberately contains no GTK, compositor or painting code. Apps describe what
 * kind of crystal they need here; the bundle or platform backend decides how to render it.
 * Keeping the axes separate prevents a light/dark skin, an ink policy and an elevation shadow
 * from becoming accidental "variants" of one another.
 */

/** Reference treatment: Regular or the more backdrop-revealing Clear. */
export type FluidCrystalVariant = "regular" | "clear"

/** A proposed UI role, not another material variant or a measured density. */
export type FluidCrystalProfile = "compact" | "panel" | "launcher" | "popover"

/** How the content on the crystal chooses its foreground ink. */
export type FluidCrystalInk = "mode" | "adaptive" | "light" | "dark"

/** Spatial separation requested by the UI; it is independent of the glass variant. */
export type FluidCrystalElevation = "none" | "tile" | "panel"

/** A complete, backend-neutral Fluid Crystal recipe. */
export type FluidCrystalSpec = Readonly<{
    variant: FluidCrystalVariant
    profile: FluidCrystalProfile
    ink: FluidCrystalInk
    elevation: FluidCrystalElevation
}>

/** The semantic recipes exposed by the kit. */
export type FluidCrystalPreset = "bar" | "panel" | "tile" | "launcher" | "popover" | "media"

/** A named preset or an explicit recipe supplied by an app. */
export type FluidCrystalSelection = FluidCrystalPreset | FluidCrystalSpec

/**
 * Provisional role mappings for apps and shell surfaces. The macOS probe measured Regular and
 * Clear on isolated shapes; it did not establish that a Control Center, launcher or popover must
 * use a particular variant, ink policy or shadow. Validate these mappings in the Glass Lab
 * before using them to change the shell's rendered material.
 *
 * These are all Regular Crystal roles except `media`; profiles are not variants. `panel` and
 * `tile` are intentionally light-inked: Control Center and Notification Center keep white
 * content regardless of the wallpaper. `launcher` follows the system mode and is denser than a
 * general panel; `popover` is denser still for menus and command surfaces. `media` has a fixed
 * foreground because Clear Crystal does not promise to adapt over arbitrary media. The macOS
 * probe also found that mode-based text can lose contrast on both variants when the backdrop
 * opposes the chosen appearance. No preset is a contrast guarantee.
 */
export const FLUID_CRYSTAL_PRESETS: Readonly<Record<FluidCrystalPreset, FluidCrystalSpec>> = Object.freeze({
    bar: Object.freeze({
        variant: "regular",
        profile: "compact",
        ink: "mode",
        elevation: "none",
    }),
    panel: Object.freeze({
        variant: "regular",
        profile: "panel",
        ink: "light",
        elevation: "panel",
    }),
    tile: Object.freeze({
        variant: "regular",
        profile: "compact",
        ink: "light",
        elevation: "tile",
    }),
    launcher: Object.freeze({
        variant: "regular",
        profile: "launcher",
        ink: "mode",
        elevation: "panel",
    }),
    popover: Object.freeze({
        variant: "regular",
        profile: "popover",
        ink: "mode",
        elevation: "panel",
    }),
    media: Object.freeze({
        variant: "clear",
        profile: "compact",
        ink: "light",
        elevation: "tile",
    }),
})
