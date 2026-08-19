#pragma once

#include <glib-object.h>

G_BEGIN_DECLS

#define NIDARA_AUTH_TYPE_PAM (nidara_auth_pam_get_type())

G_DECLARE_FINAL_TYPE(NidaraAuthPam, nidara_auth_pam, NIDARA_AUTH, PAM, GObject)

/**
 * NidaraAuthPam:
 *
 * GObject wrapper for asynchronous PAM authentication.
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
 * Supplies a secret or response to an ongoing PAM conversation.
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
