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
} IdleSignalData;

static gboolean dispatch_signal_idle(gpointer user_data) {
    IdleSignalData *data = (IdleSignalData *)user_data;
    NidaraAuthPam *self = g_weak_ref_get(&data->weak_ref);

    if (self) {
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

static void emit_signal_from_thread(NidaraAuthPam *self, guint signal_id, const gchar *msg) {
    IdleSignalData *data = g_new0(IdleSignalData, 1);
    g_weak_ref_init(&data->weak_ref, self);
    data->signal_id = signal_id;
    if (msg) data->msg = g_strdup(msg);
    g_idle_add(dispatch_signal_idle, data);
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
                emit_signal_from_thread(self, signals[SIGNAL_PROMPT_HIDDEN], m->msg);
                g_mutex_lock(&self->mutex);
                while (!self->secret_ready && !self->cancelled) {
                    g_cond_wait(&self->cond, &self->mutex);
                }
                if (self->cancelled) {
                    g_mutex_unlock(&self->mutex);
                    free(reply);
                    return PAM_CONV_ERR;
                }
                reply[i].resp = self->secret ? strdup(self->secret) : strdup("");
                reply[i].resp_retcode = 0;
                if (self->secret) {
                    explicit_bzero(self->secret, strlen(self->secret));
                    g_free(self->secret);
                    self->secret = NULL;
                }
                self->secret_ready = FALSE;
                g_mutex_unlock(&self->mutex);
                break;

            case PAM_PROMPT_ECHO_ON:
                emit_signal_from_thread(self, signals[SIGNAL_PROMPT_VISIBLE], m->msg);
                g_mutex_lock(&self->mutex);
                while (!self->secret_ready && !self->cancelled) {
                    g_cond_wait(&self->cond, &self->mutex);
                }
                if (self->cancelled) {
                    g_mutex_unlock(&self->mutex);
                    free(reply);
                    return PAM_CONV_ERR;
                }
                reply[i].resp = self->secret ? strdup(self->secret) : strdup("");
                reply[i].resp_retcode = 0;
                if (self->secret) {
                    explicit_bzero(self->secret, strlen(self->secret));
                    g_free(self->secret);
                    self->secret = NULL;
                }
                self->secret_ready = FALSE;
                g_mutex_unlock(&self->mutex);
                break;

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

    const char *service = resolve_service(self->service);
    const char *user = (self->username && self->username[0]) ? self->username : g_get_user_name();

    int status = pam_start(service, user, &conv, &pamh);
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

    if (status == PAM_SUCCESS && !self->cancelled) {
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
    if (self->secret) {
        explicit_bzero(self->secret, strlen(self->secret));
        g_free(self->secret);
        self->secret = NULL;
    }
    g_mutex_unlock(&self->mutex);

    g_object_ref(self);
    self->worker_thread = g_thread_new("nidara-auth-worker", auth_worker_func, self);
    g_thread_unref(self->worker_thread);
}

void nidara_auth_pam_supply_secret(NidaraAuthPam *self, const char *secret) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));

    g_mutex_lock(&self->mutex);
    if (self->secret) {
        explicit_bzero(self->secret, strlen(self->secret));
        g_free(self->secret);
    }
    self->secret = secret ? g_strdup(secret) : NULL;
    self->secret_ready = TRUE;
    g_cond_signal(&self->cond);
    g_mutex_unlock(&self->mutex);
}

const char *nidara_auth_pam_get_username(NidaraAuthPam *self) {
    g_return_val_if_fail(NIDARA_AUTH_IS_PAM(self), NULL);
    return self->username;
}

void nidara_auth_pam_set_username(NidaraAuthPam *self, const char *username) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));
    g_free(self->username);
    self->username = g_strdup(username);
    g_object_notify_by_pspec(G_OBJECT(self), properties[PROP_USERNAME]);
}

const char *nidara_auth_pam_get_service(NidaraAuthPam *self) {
    g_return_val_if_fail(NIDARA_AUTH_IS_PAM(self), NULL);
    return self->service;
}

void nidara_auth_pam_set_service(NidaraAuthPam *self, const char *service) {
    g_return_if_fail(NIDARA_AUTH_IS_PAM(self));
    g_free(self->service);
    self->service = g_strdup(service);
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

    g_mutex_lock(&self->mutex);
    self->cancelled = TRUE;
    g_cond_signal(&self->cond);
    g_mutex_unlock(&self->mutex);

    g_mutex_clear(&self->mutex);
    g_cond_clear(&self->cond);

    if (self->secret) {
        explicit_bzero(self->secret, strlen(self->secret));
        g_free(self->secret);
    }
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
