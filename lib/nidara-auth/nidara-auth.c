#define _GNU_SOURCE
#include "nidara-auth.h"
#include <security/pam_appl.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <glib.h>

struct _NidaraAuthPam {
    GObject parent_instance;

    gchar *username;
    gchar *service;

    GMutex mutex;
    GCond cond;

    gchar *secret;
    gboolean secret_ready;
    /* TRUE only while the worker is actually blocked on a PAM prompt. Guards
     * `supply_secret` against arming the gate when nothing is waiting at it —
     * see the contract in nidara-auth.h. */
    gboolean prompt_pending;
    /* Which prompt is waiting, and which prompt the main loop is currently
     * delivering. An answer counts only when they agree — see supply_secret.
     * `prompt_gen` MUST stay monotonic for the whole attempt (it restarts only in
     * start_authenticate): if a second prompt reused the first one's number, a
     * late answer to the first would be accepted as the answer to the second —
     * the same crossing-over this guard exists to stop, one prompt narrower. */
    guint64 prompt_gen;
    guint64 dispatched_gen;
    gboolean cancelled;
    gboolean is_authenticating;

    GThread *worker_thread;
};

enum {
    PROP_0,
    PROP_USERNAME,
    PROP_SERVICE,
    N_PROPERTIES
};

enum {
    SIGNAL_SUCCESS,
    SIGNAL_FAIL,
    SIGNAL_PROMPT_HIDDEN,
    SIGNAL_PROMPT_VISIBLE,
    SIGNAL_INFO,
    SIGNAL_ERROR,
    N_SIGNALS
};

static GParamSpec *properties[N_PROPERTIES] = { NULL, };
static guint signals[N_SIGNALS] = { 0, };

G_DEFINE_TYPE(NidaraAuthPam, nidara_auth_pam, G_TYPE_OBJECT)

typedef struct {
    GWeakRef weak_ref;
    guint signal_id;
    gchar *msg;
    gboolean is_prompt;
    guint64 gen;
} IdleSignalData;

static gboolean dispatch_signal_idle(gpointer user_data) {
    IdleSignalData *data = (IdleSignalData *)user_data;
    NidaraAuthPam *self = g_weak_ref_get(&data->weak_ref);

    if (self) {
        /* Publish WHICH prompt is being delivered before running the handlers,
         * so an answer supplied from inside one (or later, asynchronously, by a
         * UI that had to wait for the user) can be matched to it. */
        if (data->is_prompt) {
            g_mutex_lock(&self->mutex);
            self->dispatched_gen = data->gen;
            g_mutex_unlock(&self->mutex);
        }
        if (data->signal_id == signals[SIGNAL_SUCCESS]) {
            g_signal_emit(self, data->signal_id, 0);
        } else {
            g_signal_emit(self, data->signal_id, 0, data->msg ? data->msg : "");
        }
        g_object_unref(self);
    }

    g_weak_ref_clear(&data->weak_ref);
    if (data->msg) g_free(data->msg);
    g_free(data);
    return G_SOURCE_REMOVE;
}

static void emit_tagged_from_thread(NidaraAuthPam *self, guint signal_id, const gchar *msg,
                                    gboolean is_prompt, guint64 gen) {
    IdleSignalData *data = g_new0(IdleSignalData, 1);
    g_weak_ref_init(&data->weak_ref, self);
    data->signal_id = signal_id;
    if (msg) data->msg = g_strdup(msg);
    data->is_prompt = is_prompt;
    data->gen = gen;
    g_idle_add(dispatch_signal_idle, data);
}

static void emit_signal_from_thread(NidaraAuthPam *self, guint signal_id, const gchar *msg) {
    emit_tagged_from_thread(self, signal_id, msg, FALSE, 0);
}

/* Wipe and drop the pending secret. Caller must hold `self->mutex`. */
static void wipe_secret_locked(NidaraAuthPam *self) {
    if (self->secret) {
        explicit_bzero(self->secret, strlen(self->secret));
        g_free(self->secret);
        self->secret = NULL;
    }
}

/* Free a partially-filled reply array, wiping any answer already written into
 * it. Reached on cancellation, where PAM never takes ownership and would
 * otherwise leave plaintext answers on the heap. */
static void free_replies(struct pam_response *reply, int n) {
    for (int i = 0; i < n; i++) {
        if (reply[i].resp) {
            explicit_bzero(reply[i].resp, strlen(reply[i].resp));
            free(reply[i].resp);
        }
    }
    free(reply);
}

static int pam_conv_cb(int num_msg, const struct pam_message **msg,
                       struct pam_response **resp, void *appdata_ptr) {
    NidaraAuthPam *self = (NidaraAuthPam *)appdata_ptr;
    if (num_msg <= 0 || num_msg > PAM_MAX_NUM_MSG) return PAM_CONV_ERR;

    struct pam_response *reply = calloc(num_msg, sizeof(struct pam_response));
    if (!reply) return PAM_BUF_ERR;

    for (int i = 0; i < num_msg; i++) {
        const struct pam_message *m = msg[i];
        if (!m) continue;

        switch (m->msg_style) {
            case PAM_PROMPT_ECHO_OFF:
            case PAM_PROMPT_ECHO_ON: {
                /* ⚠️ ORDER MATTERS. `prompt_pending` is raised, and the signal
                 * emitted, while HOLDING the mutex — the handler runs on the
                 * main thread and calls `supply_secret`, which takes the same
                 * mutex, so it cannot run until `g_cond_wait` below releases
                 * it. Raising the flag after the emit would leave a window in
                 * which the answer arrives, finds nothing pending, is dropped,
                 * and the worker then waits forever. */
                guint sig = (m->msg_style == PAM_PROMPT_ECHO_OFF)
                    ? signals[SIGNAL_PROMPT_HIDDEN]
                    : signals[SIGNAL_PROMPT_VISIBLE];

                g_mutex_lock(&self->mutex);
                self->prompt_pending = TRUE;
                self->prompt_gen++;
                emit_tagged_from_thread(self, sig, m->msg, TRUE, self->prompt_gen);
                while (!self->secret_ready && !self->cancelled) {
                    g_cond_wait(&self->cond, &self->mutex);
                }
                if (self->cancelled) {
                    self->prompt_pending = FALSE;
                    g_mutex_unlock(&self->mutex);
                    free_replies(reply, num_msg);
                    return PAM_CONV_ERR;
                }
                reply[i].resp = self->secret ? strdup(self->secret) : strdup("");
                reply[i].resp_retcode = 0;
                wipe_secret_locked(self);
                self->secret_ready = FALSE;
                self->prompt_pending = FALSE;
                g_mutex_unlock(&self->mutex);
                break;
            }

            /* Informational messages carry NO response — PAM neither expects
             * nor reads one, so these emit and move on. A handler must NOT
             * answer them with `supply_secret`; `supply_secret` drops such a
             * stray answer precisely so it cannot survive to satisfy the next
             * real prompt. (AstalAuth blocked here too and REQUIRED the ack;
             * this library deliberately does not — see nidara-auth.h.) */
            case PAM_TEXT_INFO:
                emit_signal_from_thread(self, signals[SIGNAL_INFO], m->msg);
                break;

            case PAM_ERROR_MSG:
                emit_signal_from_thread(self, signals[SIGNAL_ERROR], m->msg);
                break;

            default:
                break;
        }
    }

    *resp = reply;
    return PAM_SUCCESS;
}

static const char *resolve_service(const char *requested) {
    if (requested && requested[0]) return requested;
    if (access("/etc/pam.d/nidara-lock", F_OK) == 0) return "nidara-lock";
    if (access("/etc/pam.d/system-auth", F_OK) == 0) return "system-auth";
    return "login";
}

static gpointer auth_worker_func(gpointer user_data) {
    NidaraAuthPam *self = (NidaraAuthPam *)user_data;

    pam_handle_t *pamh = NULL;
    struct pam_conv conv = {
        .conv = pam_conv_cb,
        .appdata_ptr = self,
    };

    /* Snapshot both strings under the mutex. The setters g_free the old value,
     * and a GJS caller can assign `pam.username` at any moment — reading the
     * live pointers here raced with that and could hand pam_start freed memory. */
    g_mutex_lock(&self->mutex);
    gchar *username_copy = g_strdup(self->username);
    gchar *service_copy  = g_strdup(self->service);
    g_mutex_unlock(&self->mutex);

    const char *service = resolve_service(service_copy);
    const char *user = (username_copy && username_copy[0]) ? username_copy : g_get_user_name();

    int status = pam_start(service, user, &conv, &pamh);
    /* pam_start copies both, so the snapshots are done as soon as it returns. */
    g_free(username_copy);
    g_free(service_copy);

    if (status != PAM_SUCCESS) {
        const char *err_msg = pam_strerror(pamh, status);
        emit_signal_from_thread(self, signals[SIGNAL_FAIL], err_msg);
        if (pamh) pam_end(pamh, status);
        g_mutex_lock(&self->mutex);
        self->is_authenticating = FALSE;
        g_mutex_unlock(&self->mutex);
        g_object_unref(self);
        return NULL;
    }

    status = pam_authenticate(pamh, 0);

    /* pam_authenticate only proves the CREDENTIAL. The account stack is what
     * says whether this account may be used at all right now — expired account,
     * administratively locked (`usermod -L`), pam_time windows. Our own
     * /etc/pam.d/nidara-lock declares that stack, so not running it meant the
     * config promised checks the code never performed. */
    if (status == PAM_SUCCESS) {
        int acct = pam_acct_mgmt(pamh, 0);
        if (acct == PAM_NEW_AUTHTOK_REQD) {
            /* Password expired. We still UNLOCK, deliberately: this is a screen
             * lock over a session that is already running and already belongs to
             * this user. Refusing would trap them inside their own desktop with
             * no way to reach a prompt to change the password — a worse outcome
             * than the policy being a moment late. The renewal belongs to the
             * next LOGIN, which is where PAM can actually run pam_chauthtok. */
            emit_signal_from_thread(self, signals[SIGNAL_INFO],
                                    "Your password has expired — change it at your next login.");
        } else if (acct != PAM_SUCCESS) {
            /* Everything else here is a deliberate administrative denial. */
            status = acct;
        }
    }

    g_mutex_lock(&self->mutex);
    gboolean was_cancelled = self->cancelled;
    g_mutex_unlock(&self->mutex);

    if (status == PAM_SUCCESS && !was_cancelled) {
        emit_signal_from_thread(self, signals[SIGNAL_SUCCESS], NULL);
    } else {
        const char *err_msg = pam_strerror(pamh, status);
        emit_signal_from_thread(self, signals[SIGNAL_FAIL], err_msg);
    }

    pam_end(pamh, status);

    g_mutex_lock(&self->mutex);
    self->is_authenticating = FALSE;
    g_mutex_unlock(&self->mutex);

    g_object_unref(self);
    return NULL;
}

NidaraAuthPam *nidara_auth_pam_new(void) {
    return g_object_new(NIDARA_AUTH_TYPE_PAM, NULL);
}

void nidara_auth_pam_start_authenticate(NidaraAuthPam *self) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));

    g_mutex_lock(&self->mutex);
    if (self->is_authenticating) {
        g_mutex_unlock(&self->mutex);
        return;
    }

    self->is_authenticating = TRUE;
    self->cancelled = FALSE;
    self->secret_ready = FALSE;
    self->prompt_pending = FALSE;
    self->prompt_gen = 0;
    self->dispatched_gen = 0;
    wipe_secret_locked(self);
    g_mutex_unlock(&self->mutex);

    g_object_ref(self);
    self->worker_thread = g_thread_new("nidara-auth-worker", auth_worker_func, self);
    g_thread_unref(self->worker_thread);
}

void nidara_auth_pam_supply_secret(NidaraAuthPam *self, const char *secret) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));

    g_mutex_lock(&self->mutex);

    /* ⚠️ THE BUG THIS GUARD EXISTS FOR (fixed 2026-08-23). Without it, an answer
     * that arrives while NOTHING is waiting still armed the gate — and the next
     * real password prompt then found it already open, did not wait, and replied
     * with an EMPTY password the user never typed. The lockscreen's auth-info /
     * auth-error handlers used to answer every message (correct under AstalAuth,
     * which blocked on those too), so on Arch a single `pam_faillock preauth`
     * message was enough to make every later attempt fail instantly with the
     * correct password never reaching PAM. A stray answer is now DROPPED.
     *
     * ⚠️ A plain "is a prompt waiting?" boolean is NOT enough, and the first
     * attempt at this fix used one. Signals reach the main loop through
     * `g_idle_add`, and the worker does not wait for them to be delivered — so
     * the answer to an informational message can be dispatched AFTER the worker
     * has already begun waiting on a LATER prompt. The boolean saw "yes, a
     * prompt is waiting" and let the stale answer through perhaps one run in
     * five. Hence the generation: `dispatched_gen` is the prompt the main loop
     * is currently delivering, `prompt_gen` is the one actually waiting, and an
     * answer counts only when they are the same prompt. */
    if (!self->prompt_pending || self->dispatched_gen != self->prompt_gen) {
        g_mutex_unlock(&self->mutex);
        return;
    }

    wipe_secret_locked(self);
    self->secret = secret ? g_strdup(secret) : NULL;
    self->secret_ready = TRUE;
    g_cond_signal(&self->cond);
    g_mutex_unlock(&self->mutex);
}

/* (transfer none) — valid until the next set_username. Callers on the main
 * thread are fine; the worker takes its own snapshot instead. */
const char *nidara_auth_pam_get_username(NidaraAuthPam *self) {
    g_return_val_if_fail(NIDARA_AUTH_IS_PAM(self), NULL);
    return self->username;
}

void nidara_auth_pam_set_username(NidaraAuthPam *self, const char *username) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));
    /* Under the mutex: the worker snapshots this. Notify OUTSIDE it — a handler
     * could call back in and deadlock on a non-recursive GMutex. */
    g_mutex_lock(&self->mutex);
    g_free(self->username);
    self->username = g_strdup(username);
    g_mutex_unlock(&self->mutex);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_USERNAME]);
}

const char *nidara_auth_pam_get_service(NidaraAuthPam *self) {
    g_return_val_if_fail(NIDARA_AUTH_IS_PAM(self), NULL);
    return self->service;
}

void nidara_auth_pam_set_service(NidaraAuthPam *self, const char *service) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));
    g_mutex_lock(&self->mutex);
    g_free(self->service);
    self->service = g_strdup(service);
    g_mutex_unlock(&self->mutex);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_SERVICE]);
}

static void nidara_auth_pam_get_property(GObject *object, guint prop_id,
                                         GValue *value, GParamSpec *pspec) {
    NidaraAuthPam *self = NIDARA_AUTH_PAM(object);
    switch (prop_id) {
        case PROP_USERNAME:
            g_value_set_string(value, self->username);
            break;
        case PROP_SERVICE:
            g_value_set_string(value, self->service);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void nidara_auth_pam_set_property(GObject *object, guint prop_id,
                                         const GValue *value, GParamSpec *pspec) {
    NidaraAuthPam *self = NIDARA_AUTH_PAM(object);
    switch (prop_id) {
        case PROP_USERNAME:
            nidara_auth_pam_set_username(self, g_value_get_string(value));
            break;
        case PROP_SERVICE:
            nidara_auth_pam_set_service(self, g_value_get_string(value));
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void nidara_auth_pam_finalize(GObject *object) {
    NidaraAuthPam *self = NIDARA_AUTH_PAM(object);

    /* ⚠️ This is NOT the cancellation path, and it cannot be: the worker holds a
     * strong reference for its whole life, so finalize is only ever reached
     * AFTER it has returned. The flag and the signal below are belt-and-braces
     * for a future caller that drops that reference — nothing observes them
     * today. Real cancellation (tearing the lock down while PAM is waiting for
     * a secret) has no mechanism yet; see tech-debt. */
    g_mutex_lock(&self->mutex);
    self->cancelled = TRUE;
    g_cond_signal(&self->cond);
    g_mutex_unlock(&self->mutex);

    g_mutex_clear(&self->mutex);
    g_cond_clear(&self->cond);

    /* No lock to hold any more, and no other thread left to race with. */
    wipe_secret_locked(self);
    g_free(self->username);
    g_free(self->service);

    G_OBJECT_CLASS(nidara_auth_pam_parent_class)->finalize(object);
}

static void nidara_auth_pam_init(NidaraAuthPam *self) {
    g_mutex_init(&self->mutex);
    g_cond_init(&self->cond);
}

static void nidara_auth_pam_class_init(NidaraAuthPamClass *klass) {
    GObjectClass *object_class = G_OBJECT_CLASS(klass);

    object_class->get_property = nidara_auth_pam_get_property;
    object_class->set_property = nidara_auth_pam_set_property;
    object_class->finalize = nidara_auth_pam_finalize;

    properties[PROP_USERNAME] = g_param_spec_string(
        "username", "Username", "The username to authenticate",
        NULL, G_PARAM_READWRITE | G_PARAM_CONSTRUCT | G_PARAM_STATIC_STRINGS);

    properties[PROP_SERVICE] = g_param_spec_string(
        "service", "Service", "The PAM service name",
        NULL, G_PARAM_READWRITE | G_PARAM_CONSTRUCT | G_PARAM_STATIC_STRINGS);

    g_object_class_install_properties(object_class, N_PROPERTIES, properties);

    signals[SIGNAL_SUCCESS] = g_signal_new(
        "success", G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 0);

    signals[SIGNAL_FAIL] = g_signal_new(
        "fail", G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    signals[SIGNAL_PROMPT_HIDDEN] = g_signal_new(
        "auth-prompt-hidden", G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    signals[SIGNAL_PROMPT_VISIBLE] = g_signal_new(
        "auth-prompt-visible", G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    signals[SIGNAL_INFO] = g_signal_new(
        "auth-info", G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);

    signals[SIGNAL_ERROR] = g_signal_new(
        "auth-error", G_TYPE_FROM_CLASS(klass),
        G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
        G_TYPE_NONE, 1, G_TYPE_STRING);
}
