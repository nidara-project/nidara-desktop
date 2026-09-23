// SPDX-License-Identifier: LGPL-3.0-or-later
import GLib from "gi://GLib"

/**
 * The kit's stylesheet, loaded at runtime (tech-debt #108 phase 2).
 *
 * The kit's look used to be compiled INTO each app's sheet — three copies of the
 * same ~47 KB, kept in step only because they shared a working tree. Now it is
 * compiled once, to `kit.css`, and an app asks for it here.
 *
 * 🔑 ONE provider, not two — and that was measured. GTK does not compare
 * specificity ACROSS providers: a rule in a later (or higher-priority) provider
 * beats a MORE specific rule in an earlier one (probe, 2026-09-23:
 * `.a label {color: red}` in one provider lost to `label {color: blue}` in a
 * second one added after it; in one sheet, red won). The kit and the app were
 * one sheet, where specificity decides, so they stay one provider: the CSS this
 * returns is two `@import`s, the kit's first, and GTK reads both into whichever
 * provider loads it. Same cascade as before, and parse errors still name the
 * file they are in.
 *
 * Where the sheet is, in order:
 *   1. `$NIDARA_KIT_DIR/kit.css` — a probe that compiles its own copy says so.
 *   2. a SOURCE TREE: an app sheet at `<repo>/ui/<app>/style.css` has the kit at
 *      `<repo>/ui/lib/nidara-kit/kit.css`. A checkout always wins over the system
 *      copy, which may be a release behind it.
 *   3. `/usr/share/nidara-kit/kit.css` — the installed kit.
 */

export const KIT_INSTALL_DIR = "/usr/share/nidara-kit"

const exists = (p: string) => GLib.file_test(p, GLib.FileTest.EXISTS)

/** The compiled kit sheet an app with its own sheet at `appCssPath` should load. */
export function kitSheetPath(appCssPath?: string): string {
  const env = GLib.getenv("NIDARA_KIT_DIR")
  if (env) return `${env}/kit.css`
  if (appCssPath) {
    const dir = GLib.path_get_dirname(GLib.canonicalize_filename(appCssPath, null))
    const inTree = GLib.canonicalize_filename(`${dir}/../lib/nidara-kit/kit.css`, null)
    if (exists(inTree)) return inTree
  }
  return `${KIT_INSTALL_DIR}/kit.css`
}

/**
 * CSS text for ONE provider: the kit's sheet, then the app's. Load it with
 * `load_from_string` (or pass it as `css` to `app.start`), and load it again to
 * reload both — `@import` re-reads the files.
 *
 * A missing kit sheet is not fatal (GTK logs the failed import and the app's own
 * rules still load), but it is loud here, because what it looks like on screen is
 * every kit control drawn by nothing.
 */
export function withKitSheet(appCssPath: string): string {
  const kit = kitSheetPath(appCssPath)
  if (!exists(kit)) console.error(`[nidara-kit] kit.css not found at ${kit} — kit controls will be unstyled`)
  const url = (p: string) => GLib.filename_to_uri(GLib.canonicalize_filename(p, null), null)
  return `@import url("${url(kit)}");\n@import url("${url(appCssPath)}");\n`
}
