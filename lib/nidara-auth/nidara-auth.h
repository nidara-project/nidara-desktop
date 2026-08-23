#pragma once

#include <glib-object.h>

G_BEGIN_DECLS

#define NIDARA_AUTH_TYPE_PAM (nidara_auth_pam_get_type())

G_DECLARE_FINAL_TYPE(NidaraAuthPam, nidara_auth_pam, NIDARA_AUTH, PAM, GObject)

/**
 * NidaraAuthPam:
 *
 * GObject wrapper for asynchronous PAM authentication.
 *
 * # The conversation contract — READ THIS BEFORE WRITING A CONSUMER
 *
 * PAM drives the exchange, not you. A worker thread runs the PAM stack and
 * relays each message as a signal on the main loop. There are two KINDS of
 * message and they are not answered the same way:
 *
 * 1. **Prompts** — `auth-prompt-hidden` (`PAM_PROMPT_ECHO_OFF`, the password)
 *    and `auth-prompt-visible` (`PAM_PROMPT_ECHO_ON`, a username or a second
 *    factor). The worker is **blocked** waiting for you. Each one MUST be
 *    answered with exactly one nidara_auth_pam_supply_secret() call. Until you
 *    answer, authentication does not proceed. Answering is not optional: an
 *    unanswered prompt hangs the attempt.
 *
 * 2. **Messages** — `auth-info` (`PAM_TEXT_INFO`) and `auth-error`
 *    (`PAM_ERROR_MSG`). These are things to SHOW the user. PAM expects no
 *    response and the worker does not wait. **Do NOT call supply_secret() for
 *    these.** Show them, or ignore them.
 *
 * ⚠️ **This differs from AstalAuth, which this library replaced.** AstalAuth
 * blocked on all four signals and its documented contract was "exactly one
 * supply_secret call" for every one of them, `NULL` for info and error. A
 * consumer written against that contract acknowledges messages — and a
 * consumer ported across unchanged is the bug that shipped in #200: the stray
 * answer armed the gate, and the next real prompt consumed it and replied with
 * an empty password the user never typed. On Arch, one `pam_faillock preauth`
 * message was enough to make every subsequent unlock fail with the correct
 * password. supply_secret() now DROPS an answer that no prompt is waiting for,
 * so the mistake is inert rather than dangerous — but write consumers to the
 * contract above, not to AstalAuth's.
 *
 * # What is checked, and the two signals that qualify the verdict
 *
 * Both `pam_authenticate()` (the credential) and `pam_acct_mgmt()` (whether the
 * account may be used at all) run before `success` is emitted. Two signals carry
 * what `success`/`fail` cannot say on their own. Both are emitted BEFORE the
 * verdict they qualify, and every signal goes through `g_idle_add`, which is
 * FIFO — so a handler always has them in hand by the time the verdict arrives:
 *
 * - `password-expired` (no argument) then `success`. An expired password
 *   (`PAM_NEW_AUTHTOK_REQD`) still UNLOCKS, deliberately: this authenticates
 *   against an already-running session, and refusing would trap the user inside
 *   their own desktop with no way to reach a prompt to change it. **Tell them.**
 *   It carries no text on purpose — a user-visible string built in C reaches no
 *   translation catalog, and this desktop ships twelve languages, so the wording
 *   belongs to the consumer.
 *
 * - `account-denied` (the PAM error string, for the log) then `fail`. The
 *   account stack refused: expired account, `usermod -L`, outside a `pam_time`
 *   window. **This is not a wrong password**, and a UI that says so invites the
 *   user to retry a correct password until `pam_faillock` locks them out for
 *   real. Say the account is unavailable, not that the password is wrong.
 *
 * # Threading
 *
 * Signals are delivered through `g_idle_add`, so handlers run on the DEFAULT
 * main context (`g_main_context_default()` — not the thread-default one) and may
 * touch the UI. The object holds itself alive for the duration of an attempt.
 * There is no cancellation: once a prompt is waiting, only supply_secret() can
 * release it.
 */
NidaraAuthPam *nidara_auth_pam_new(void);

/**
 * nidara_auth_pam_start_authenticate:
 * @self: a #NidaraAuthPam
 *
 * Starts the asynchronous PAM authentication process in a worker thread.
 */
void nidara_auth_pam_start_authenticate(NidaraAuthPam *self);

/**
 * nidara_auth_pam_supply_secret:
 * @self: a #NidaraAuthPam
 * @secret: (nullable): the secret response string, or %NULL
 *
 * Answers the PROMPT that is currently waiting (`auth-prompt-hidden` or
 * `auth-prompt-visible`). Call it exactly once per prompt signal.
 *
 * ⚠️ An answer that does not belong to the prompt currently being delivered is
 * **silently dropped** — including a reflexive answer to `auth-info` /
 * `auth-error`, which are not prompts at all. This is deliberate: an answer left
 * lying around used to be picked up by the NEXT prompt, which then replied with
 * an empty password nobody typed. See #NidaraAuthPam.
 *
 * Answering LATE is fine and fully supported — a UI that has to wait for the
 * user calls this from a timeout or another signal, not from inside the prompt
 * handler. What is matched is the prompt, not the call site.
 *
 * A %NULL @secret answers the waiting prompt with the empty string. It does not
 * mean "no answer" — there is no way to decline a prompt.
 */
void nidara_auth_pam_supply_secret(NidaraAuthPam *self, const char *secret);

/**
 * nidara_auth_pam_get_username:
 * @self: a #NidaraAuthPam
 *
 * Returns: (transfer none): the username.
 */
const char *nidara_auth_pam_get_username(NidaraAuthPam *self);

/**
 * nidara_auth_pam_set_username:
 * @self: a #NidaraAuthPam
 * @username: the username to authenticate
 */
void nidara_auth_pam_set_username(NidaraAuthPam *self, const char *username);

/**
 * nidara_auth_pam_get_service:
 * @self: a #NidaraAuthPam
 *
 * Returns: (transfer none): the PAM service name.
 */
const char *nidara_auth_pam_get_service(NidaraAuthPam *self);

/**
 * nidara_auth_pam_set_service:
 * @self: a #NidaraAuthPam
 * @service: the PAM service name (defaults to "nidara-lock")
 */
void nidara_auth_pam_set_service(NidaraAuthPam *self, const char *service);

G_END_DECLS
