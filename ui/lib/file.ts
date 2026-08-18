// File helpers — what `ags/file` gave us, minus everything we never called.
//
// AGS's module also exported `readFileAsync`, `writeFileAsync` and `monitorFile`
// (a recursive `Gio.FileMonitor` wrapper that re-arms itself on CREATE). Nidara
// imports only `readFile` and `writeFile`; the code that watches files here
// builds its own monitor because it needs the event kind (ThemeManager,
// core/*Config). So this is the whole surface.
//
// Both are SYNCHRONOUS on purpose: every call site is small JSON under
// `~/.config/nidara/` read or written at a user action or at startup, and the
// async versions were never used once.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

/**
 * Read a file as UTF-8 text.
 *
 * @throws when the file does not exist or cannot be read — callers that treat a
 * missing file as "no config yet" must catch, exactly as they did before.
 */
export function readFile(file: string | Gio.File): string {
  const f = typeof file === "string" ? Gio.File.new_for_path(file) : file
  const [, bytes] = f.load_contents(null)
  return new TextDecoder().decode(bytes)
}

/**
 * Write UTF-8 text, creating the parent directory tree if needed.
 *
 * @returns the `Gio.File` written, as the AGS version did
 */
export function writeFile(file: string | Gio.File, content: string): Gio.File {
  const gfile = typeof file === "string" ? Gio.File.new_for_path(file) : file
  const path = typeof file === "string" ? file : gfile.get_path()
  if (!path) throw Error("path is null")

  const dir = GLib.path_get_dirname(path)
  if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
    Gio.File.new_for_path(dir).make_directory_with_parents(null)
  }

  gfile.replace_contents(
    new TextEncoder().encode(content),
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  )
  return gfile
}
