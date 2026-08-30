// What a terminal would have done to a line, done here, because a GtkTextView is
// not a terminal.
//
// Everything archinstall spawns writes for a TTY. Captured with `script`, one
// real `pacman -Qi` line reads:
//
//   ESC[?25l ESC[0;1m Name : ESC[0m bash CR
//
// — a cursor it hid on the way in, two colour changes, and a carriage return. The
// TextView has no meaning for any of them, so it printed them: that is where the
// stray `[?25h` and the half-drawn blocks in the installer's log came from, and
// they are the child's bytes arriving intact, not corruption.
//
// This is deliberately NOT a terminal emulator, and should not grow into one. A
// log needs two answers only: which bytes were ever text (drop the escapes), and
// which text is still on screen (a carriage return means the child redrew the
// line from column zero — a progress bar does this dozens of times, and only its
// last take is what a terminal would be showing when the line finally ends).

// CSI — `ESC [`, private-marker and parameter bytes, then a final byte. Covers
// both the colours (`ESC[0;1m`) and the cursor visibility (`ESC[?25l`). The `$`
// alternative is for a sequence the child never finished writing (it died, or the
// pipe closed): without it the ESC goes and the `[` stays, which is the exact
// litter this file exists to remove.
const CSI = /\x1b\[[0-?]*[ -/]*(?:[@-~]|$)/g
// OSC — `ESC ]` up to a BEL or a string terminator. This is how a child sets the
// window title, which archinstall's pacman does on every transaction.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
// The short escapes: charset designators (`ESC ( B`) and the single-byte ones
// (`ESC M`, `ESC 7`). Then any ESC left over, so a sequence cut in half by the
// end of a line cannot leak a lone byte through.
const SHORT = /\x1b[()#][0-9A-Za-z]|\x1b[@-Z\\-_0-9<=>]|\x1b/g
// C0 control bytes that survived, minus tab (real content) — CR and LF are gone
// by this point, handled above as layout rather than deleted as noise.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Reduce one line of TTY-shaped child output to the text a terminal would be
 * showing. Returns "" for a line that was nothing but escapes — the caller
 * decides whether that is a blank line worth keeping.
 */
export function stripAnsi(line: string): string {
  const plain = line.replace(CSI, "").replace(OSC, "").replace(SHORT, "").replace(CONTROL, "")
  // The trailing CR goes first and is not a redraw: read_line splits on LF alone,
  // so every line of a CRLF stream arrives carrying one. Cutting at the LAST CR
  // without this returns "" for every line a pty ever touched.
  const drawn = plain.replace(/\r+$/, "")
  // Of what is left, only the last take is still on screen. Overwriting a longer
  // line leaves its tail behind on a real terminal; a log is better off without
  // that debris.
  const lastTake = drawn.slice(drawn.lastIndexOf("\r") + 1)
  return lastTake.replace(/\s+$/, "")
}
