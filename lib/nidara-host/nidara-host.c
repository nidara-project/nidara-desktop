// SPDX-License-Identifier: GPL-3.0-or-later
// Private module runner for every Nidara GJS program (./hosts). Embed GJS rather than exec its
// console so /proc/PID/exe names the application. This is not the gjs CLI:
// argv[1] is a local ESM file; remaining arguments belong to the application.
#include <gjs/gjs.h>
#include <stdint.h>
#include <stdio.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <module.js> [arguments...]\n", argv[0]);
        return 2;
    }
    char *name = g_path_get_basename(argv[0]);
    g_set_prgname(name);
    g_free(name);
    char *path = g_canonicalize_filename(argv[1], NULL);
    GjsContext *context = g_object_new(GJS_TYPE_CONTEXT,
        "program-name", argv[0], "program-path", path,
        "exec-as-module", TRUE, NULL);
    gjs_context_set_argv(context, argc - 2, (const char **)(argv + 2));
    uint8_t code = 0;
    GError *error = NULL;
    gboolean ok = gjs_context_eval_module_file(context, path, &code, &error);
    if (!ok && !g_error_matches(error, GJS_ERROR, GJS_ERROR_SYSTEM_EXIT)) {
        fprintf(stderr, "%s: %s\n", argv[0], error ? error->message : "module evaluation failed");
        if (code == 0) code = 1;
    }
    g_clear_error(&error);
    g_object_unref(context);
    g_free(path);
    return code;
}
