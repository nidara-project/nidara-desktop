import GLib from "gi://GLib"
import Gio from "gi://Gio"

// The greeter's own greetd client — it speaks the protocol directly and no
// longer goes through AstalGreet (dropped 2026-08-17).
//
// This file already owned the LOGIC, and had to: AstalGreet.login() SWALLOWS
// greetd protocol errors — Request.send() returns the {type:"error"} reply as
// an Error OBJECT (it only throws on socket/JSON failures) and login_with_env()
// discards every response. So a wrong password "resolved" successfully, the
// card called app.quit(), greetd saw "greeter exited without creating a
// session" and terminated, systemd restarted it — a TTY flash and a fresh
// greeter with no error message (VM-verified 2026-07-10). Upstream also never
// cancels the failed session, which would break the next create_session.
//
// What the library still did for us was the WIRE FORMAT, and that is 30 lines:
// connect to $GREETD_SOCK, write a 4-byte native-endian length followed by the
// JSON body, read a reply framed the same way. Speaking it here removes a
// dependency we were only renting a JSON serializer from.
//
// 🔑 One upstream bug is NOT reproduced here. AstalGreet writes the length with
// DataStreamByteOrder.HOST_ENDIAN but reads it back big-endian by hand
// (`value = (value << 8) | data[i]`), so on x86 every reply length came out
// byte-swapped — 18 read as 301989888. It never surfaced because
// read_bytes_async returns as soon as ANY data is available rather than filling
// the count, so the absurd number was harmless and the real body arrived
// anyway. We read the length as native-endian and then read exactly that many
// bytes, which is both correct and what makes a short read impossible.

export class AuthError extends Error {
  constructor(readonly isAuthFailure: boolean, message: string) {
    super(message)
  }
}

// greetd-ipc(7). Only the members this card acts on are typed.
type Response =
  | { type: "success" }
  | { type: "error"; error_type: "auth_error" | "error"; description?: string }
  | {
      type: "auth_message"
      auth_message_type: "visible" | "secret" | "info" | "error"
      auth_message?: string
    }

// The length prefix is native-endian, so ask the machine rather than assume.
const NATIVE_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/** Sanity ceiling on a reply's declared length (greetd's are tens of bytes). */
const MAX_REPLY = 1 << 20

/** Gio async → promise, the same hand-rolled shape the AstalGreet version used
 *  (GJS only auto-promisifies through Gio._promisify, which we do not patch). */
function readBytes(stream: any, count: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, null, (src: any, res: any) => {
        try {
          const bytes = src.read_bytes_finish(res)
          resolve(bytes.get_data() ?? new Uint8Array(0))
        } catch (e) { reject(e) }
      })
    } catch (e) { reject(e) }
  })
}

/** read_bytes_async returns what is AVAILABLE, not what was asked for — a reply
 *  split across TCP-ish boundaries would otherwise parse as truncated JSON. */
async function readExactly(stream: any, count: number): Promise<Uint8Array> {
  const out = new Uint8Array(count)
  let got = 0
  while (got < count) {
    const chunk = await readBytes(stream, count - got)
    if (chunk.length === 0) throw new Error("greetd closed the connection mid-reply")
    out.set(chunk, got)
    got += chunk.length
  }
  return out
}

/** One request → one reply, on its own connection (greetd allows this, and it
 *  is the shape AstalGreet used, so the sequencing is unchanged). */
async function send(req: Record<string, unknown>): Promise<Response> {
  const sock = GLib.getenv("GREETD_SOCK")
  if (!sock) throw new Error("greetd socket not found (GREETD_SOCK unset)")

  // `client.connect(addr, …)` is g_socket_client_connect, NOT GObject's signal
  // connect: an introspected method on the class shadows the inherited one. Same
  // mechanic that made `device.disconnect(handlerId)` call NM's disconnect — see
  // the note on GObject.signal_handler_disconnect in the shell's core/signals.ts.
  const conn = new Gio.SocketClient().connect(Gio.UnixSocketAddress.new(sock), null)

  try {
    const payload = new TextEncoder().encode(JSON.stringify(req))
    const framed = new Uint8Array(4 + payload.length)
    new DataView(framed.buffer).setUint32(0, payload.length, NATIVE_LE)
    framed.set(payload, 4)
    conn.get_output_stream().write_all(framed, null)

    const istream = conn.get_input_stream()
    const head = await readExactly(istream, 4)
    const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, NATIVE_LE)
    // greetd replies are tens of bytes. A length in the megabytes means we and
    // the daemon disagree about the framing, and without this the mistake would
    // present as a login card that hangs forever on a 300 MB allocation
    // (verified: feeding a byte-swapped length makes the probe hang) instead of
    // as an error the card can show.
    if (length > MAX_REPLY) throw new Error(`greetd reply framed as ${length} bytes — framing mismatch`)
    const body = await readExactly(istream, length)
    return JSON.parse(new TextDecoder().decode(body)) as Response
  } finally {
    try { conn.close(null) } catch { /* already gone */ }
  }
}

// greetd refuses create_session while a failed one is still under
// configuration — always cancel before surfacing an error.
async function cancelQuietly(): Promise<void> {
  try { await send({ type: "cancel_session" }) } catch { /* nothing to cancel */ }
}

async function failWith(isAuth: boolean, msg: string): Promise<never> {
  await cancelQuietly()
  throw new AuthError(isAuth, msg)
}

async function checkedSend(req: Record<string, unknown>, step: string): Promise<Response> {
  const r = await send(req)
  if (r.type === "error") {
    return failWith(r.error_type === "auth_error", r.description || `greetd error at ${step}`)
  }
  return r
}

export async function greetdLogin(username: string, password: string, cmd: string): Promise<void> {
  let r = await checkedSend({ type: "create_session", username }, "create_session")

  // Standard PAM flow: create_session answers with ONE secret prompt
  // ("Password:"), we respond with the password, then start the session.
  // Anything else — an INFO/ERROR message (e.g. faillock's "account locked"
  // preauth notice) or a multi-prompt stack (OTP) — is outside this simple
  // card's scope: cancel and surface it instead of answering blind (which is
  // what upstream's login() did).
  if (r.type === "auth_message" && r.auth_message_type !== "secret") {
    return failWith(false, r.auth_message || "unsupported auth conversation")
  }

  r = await checkedSend(
    { type: "post_auth_message_response", response: password }, "authentication")
  if (r.type === "auth_message") {
    return failWith(false, r.auth_message || "unsupported auth conversation")
  }

  const [, argv] = GLib.shell_parse_argv(cmd)
  await checkedSend({ type: "start_session", cmd: argv, env: [] }, "start_session")
}
