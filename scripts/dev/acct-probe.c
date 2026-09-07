/* ────────────────────────────────────────────────────────────────────────────
 * acct-probe — what does the ACCOUNT stack actually answer, from a process
 * with no privileges?
 *
 *   ./scripts/dev/acct-expiry-probe.sh          (builds and drives this)
 *   ./acct-probe <service> <user>               (by hand; read-only)
 *
 * Read-only: no pam_authenticate, no session, no password, nothing written.
 * It asks the one question the lockscreen asks after a correct password —
 * pam_acct_mgmt() on our own `nidara-lock` service — and prints the RAW code,
 * because the whole point is telling a real verdict apart from a rubber stamp.
 *
 * ⚠️ It must run AS the account it asks about. `unix_chkpwd` answers only for
 * its own caller unless that caller is root, so asking about somebody else
 * returns 9 (PAM_AUTHINFO_UNAVAIL) whatever the account's real state is — a
 * probe that looks like it is discriminating while it is blind. That is how
 * the lockscreen works anyway: gjs runs as you and asks about you.
 * ──────────────────────────────────────────────────────────────────────────── */
#include <security/pam_appl.h>
#include <stdio.h>
#include <unistd.h>

static int conv_fn(int n, const struct pam_message **msg,
                   struct pam_response **resp, void *data) {
    (void)n; (void)msg; (void)resp; (void)data;
    return PAM_CONV_ERR;   /* the account phase must never reach this */
}

int main(int argc, char **argv) {
    const char *service = argc > 1 ? argv[1] : "nidara-lock";
    const char *user    = argc > 2 ? argv[2] : getlogin();
    struct pam_conv conv = { conv_fn, NULL };
    pam_handle_t *pamh = NULL;

    int rc = pam_start(service, user, &conv, &pamh);
    if (rc != PAM_SUCCESS) {
        printf("pam_start FAILED: %d (%s)\n", rc, pam_strerror(pamh, rc));
        return 2;
    }
    int acct = pam_acct_mgmt(pamh, 0);
    printf("service=%s user=%s euid=%d\n", service, user, geteuid());
    printf("pam_acct_mgmt -> %d (%s)%s\n", acct, pam_strerror(pamh, acct),
           acct == PAM_SUCCESS ? "  [ACCEPTED]" : "  [REFUSED]");
    pam_end(pamh, acct);
    return acct == PAM_SUCCESS ? 0 : 1;
}
