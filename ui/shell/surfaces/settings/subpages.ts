// Builders for the subpages a parent page pushes.
//
// Kept out of `Settings.tsx` on purpose: `Settings.tsx` imports `Apps.tsx`, so
// `Apps.tsx` importing it back would be a cycle. This module is what both can
// import — and the `satisfies` below is what makes a `builder` named in the
// manifest but missing here a COMPILE error rather than a blank page.
import Gtk from "gi://Gtk?version=4.0"
import { manifest, type PageDecl } from "./manifest"
import type { SettingsNav } from "./SettingsHelpers"
import DefaultAppsPage from "./pages/DefaultApps"
import AppIconsPage from "./pages/AppIcons"
import AutostartPage from "./pages/Autostart"

export type SubpageBuilder = (nav: SettingsNav) => Gtk.Widget

type SubpageIds = Extract<(typeof manifest)[number], { parent: string }>["builder"]

export const SUBPAGE_BUILDERS = {
    defaultApps: () => DefaultAppsPage(),
    appIcons: (nav: SettingsNav) => AppIconsPage(nav),
    autostart: (nav: SettingsNav) => AutostartPage(nav),
} satisfies Record<NonNullable<SubpageIds>, SubpageBuilder>

/** The subpages a page lists, in manifest order. */
export const subpagesOf = (parentId: string): PageDecl[] =>
    (manifest as readonly PageDecl[]).filter((p) => p.parent === parentId)
