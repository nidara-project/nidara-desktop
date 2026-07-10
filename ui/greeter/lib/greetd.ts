// @ts-ignore
import AstalGreet from "gi://AstalGreet"
import GLib from "gi://GLib"

// Checked greetd login — replaces AstalGreet.login(), which SWALLOWS greetd
// protocol errors: Request.send() returns the {type:"error"} reply as an
// AstalGreet.Error OBJECT (it only throws on socket/JSON failures) and
// login_with_env() discards every response. So a wrong password "resolved"
// successfully, the card called app.quit(), greetd saw "greeter exited
// without creating a session" and terminated, systemd restarted it — a TTY
// flash and a fresh greeter with no error message (VM-verified 2026-07-10).
// Upstream also never cancels the failed session, which would break the next
// create_session. This module drives the same Request classes but CHECKS
// every response; on failure it cancels the session and throws AuthError so
// the card can tell bad-password from plumbing errors.

export class AuthError extends Error {
  constructor(readonly isAuthFailure: boolean, message: string) {
    super(message)
  }
}

// Vala async → JS promise by hand: GJS only auto-promisifies Gio-style async
// through Gio._promisify, which we'd have to patch onto each Request class.
function send(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      req.send((_: any, res: any) => {
        try { resolve(req.send_finish(res)) } catch (e) { reject(e) }
      })
    } catch (e) { reject(e) }
  })
}

// greetd refuses create_session while a failed one is still under
// configuration — always cancel before surfacing an error.
async function cancelQuietly(): Promise<void> {
  try { await send(AstalGreet.CancelSession.new()) } catch { /* nothing to cancel */ }
}

async function failWith(isAuth: boolean, msg: string): Promise<never> {
  await cancelQuietly()
  throw new AuthError(isAuth, msg)
}

async function checkedSend(req: any, step: string): Promise<any> {
  const r = await send(req)
  if (r instanceof AstalGreet.Error) {
    const isAuth = r.error_type === AstalGreet.ErrorType.AUTH_ERROR
    return failWith(isAuth, r.description || `greetd error at ${step}`)
  }
  return r
}

export async function greetdLogin(username: string, password: string, cmd: string): Promise<void> {
  let r = await checkedSend(AstalGreet.CreateSession.new(username), "create_session")

  // Standard PAM flow: create_session answers with ONE secret prompt
  // ("Password:"), we respond with the password, then start the session.
  // Anything else — an INFO/ERROR message (e.g. faillock's "account locked"
  // preauth notice) or a multi-prompt stack (OTP) — is outside this simple
  // card's scope: cancel and surface it instead of answering blind (which is
  // what upstream's login() did).
  if (r instanceof AstalGreet.AuthMessage
      && r.message_type !== AstalGreet.AuthMessageType.SECRET) {
    return failWith(false, r.message || "unsupported auth conversation")
  }

  r = await checkedSend(AstalGreet.PostAuthMesssage.new(password), "authentication")
  if (r instanceof AstalGreet.AuthMessage) {
    return failWith(false, r.message || "unsupported auth conversation")
  }

  const [, argv] = GLib.shell_parse_argv(cmd)
  await checkedSend(AstalGreet.StartSession.new(argv, []), "start_session")
}
