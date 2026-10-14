// SPDX-License-Identifier: LGPL-3.0-or-later
import Gio from "gi://Gio"

/** Set Linux's main-thread comm, independently of GTK and the Wayland app-id. */
export function setProcessName(name: string): void {
  // Linux has 16 bytes including NUL. Reject truncation and keep names ASCII.
  if (!/^[a-z][a-z0-9-]{0,14}$/.test(name))
    throw new Error(`Invalid Linux process name: ${name}`)

  try {
    // Open the existing proc entry directly: replace_contents/writeFile would
    // try to create and rename a temporary file, which procfs does not support.
    const stream = Gio.File.new_for_path("/proc/self/comm").open_readwrite(null)
    try {
      stream.get_output_stream().write_all(new TextEncoder().encode(name), null)
    } finally {
      stream.close(null)
    }
  } catch (error) {
    // Process monitors are diagnostic; missing/restricted procfs must not stop UI.
    console.warn(`Could not set process name ${name}: ${error}`)
  }
}
