/* nidara-wl — Nidara's Wayland shim.
 *
 * GJS cannot speak raw Wayland: libwayland-client has no GObject introspection,
 * and `gdk_wayland_surface_get_wl_surface` is marked introspectable="0" in
 * GdkWayland-4.0.gir. Two things the shell needs are therefore unreachable from
 * TypeScript, and both live here — in-process, so a captured frame comes back as
 * a GdkTexture instead of travelling through a pipe as a file descriptor.
 *
 *  1. WINDOW CAPTURE (ext-image-copy-capture). Hyprland re-renders the window on
 *     demand into an export framebuffer — verified in ScreenshareFrame.cpp and in
 *     the field — so a window on a hidden workspace captures fine and costs one
 *     render pass, not continuous rendering. This is what makes real thumbnails
 *     affordable in the Overview and the window switcher.
 *
 *  2. VISIBLE REGION (hyprland-surface-v1 v2). Hyprland charges layer blur by the
 *     surface's BOX, not by the pixels that end up visible, so Nidara's three
 *     monitor-sized layers tax every repaint of every window. Declaring the region
 *     a surface actually paints recovers ~88% of that. See tech-debt §46.
 *
 * Symbol prefix `nidara_wl`, namespace `NidaraWl` — from GJS:
 *
 *     import NidaraWl from "gi://NidaraWl";
 */

#pragma once

#include <gdk/gdk.h>
#include <gio/gio.h>
#include <glib-object.h>

G_BEGIN_DECLS

#define NIDARA_WL_ERROR (nidara_wl_error_quark ())

/**
 * NidaraWlError:
 * @NIDARA_WL_ERROR_UNAVAILABLE: not a Wayland session, or a required global is missing
 * @NIDARA_WL_ERROR_NO_WINDOW: no toplevel with the requested Hyprland address
 * @NIDARA_WL_ERROR_CAPTURE_FAILED: the compositor refused or aborted the capture
 * @NIDARA_WL_ERROR_TIMEOUT: the compositor never answered
 */
typedef enum {
  NIDARA_WL_ERROR_UNAVAILABLE,
  NIDARA_WL_ERROR_NO_WINDOW,
  NIDARA_WL_ERROR_CAPTURE_FAILED,
  NIDARA_WL_ERROR_TIMEOUT,
} NidaraWlError;

GQuark nidara_wl_error_quark (void);

/**
 * nidara_wl_init:
 * @error: (nullable): return location for an error
 *
 * Binds what the shim needs against GDK's Wayland connection. Safe to call more
 * than once; later calls are no-ops that report the first result.
 *
 * Failing here is not fatal to the shell — every entry point below degrades to a
 * no-op or an error, so callers can treat the shim as an enhancement.
 *
 * Returns: %TRUE if the shim is usable
 */
gboolean nidara_wl_init (GError **error);

/**
 * nidara_wl_is_available:
 *
 * Returns: %TRUE if nidara_wl_init() succeeded
 */
gboolean nidara_wl_is_available (void);

/**
 * nidara_wl_has_visible_region:
 *
 * Whether the compositor advertises hyprland_surface_manager_v1 at version 2 or
 * later. Version 1 has no set_visible_region, so the blur optimisation silently
 * does nothing there — check this before assuming it took effect.
 *
 * Returns: %TRUE if visible regions are supported
 */
gboolean nidara_wl_has_visible_region (void);

/**
 * nidara_wl_has_capture:
 *
 * Returns: %TRUE if window capture is supported by this compositor
 */
gboolean nidara_wl_has_capture (void);

/* ---------------------------------------------------------------- capture */

/**
 * nidara_wl_capture_window:
 * @address: Hyprland window address, as reported by `hyprctl clients` / listWindows
 * @max_width: longest allowed width in pixels, or 0 for the window's own size
 * @max_height: longest allowed height in pixels, or 0 for the window's own size
 * @cancellable: (nullable): a #GCancellable
 * @callback: (scope async): called when the capture finishes
 * @user_data: data for @callback
 *
 * Captures a window and scales it down to fit @max_width × @max_height,
 * preserving aspect ratio. Never scales up.
 *
 * The window does NOT need to be visible: a window on another workspace captures
 * its last committed content. The scaling matters — a 2560×1440 window is 14 MB
 * of pixels, and a thumbnail strip that keeps them all at full size will hurt.
 *
 * Runs on a worker thread with its own Wayland connection, so it never blocks the
 * main loop and never touches GDK's event queue.
 */
void nidara_wl_capture_window (guint64              address,
                               int                  max_width,
                               int                  max_height,
                               GCancellable        *cancellable,
                               GAsyncReadyCallback  callback,
                               gpointer             user_data);

/**
 * nidara_wl_capture_window_finish:
 * @result: the #GAsyncResult handed to the callback
 * @error: (nullable): return location for an error
 *
 * Returns: (transfer full) (nullable): the captured frame, or %NULL on error
 */
GdkTexture *nidara_wl_capture_window_finish (GAsyncResult  *result,
                                             GError       **error);

/* --------------------------------------------------------- visible region */

/**
 * nidara_wl_visible_region_begin:
 * @surface: the #GdkSurface to describe
 *
 * Starts building the region @surface actually paints. Follow with one or more
 * nidara_wl_visible_region_add_rect() calls and finish with
 * nidara_wl_visible_region_commit().
 *
 * DANGER, and it is the whole risk of this API: anything OUTSIDE the committed
 * region is not drawn at all. Hyprland clips with a hard GL scissor
 * (OpenGL.cpp), and an empty intersection cancels the element entirely
 * (SurfacePassElement.cpp) — there is exactly 1px of tolerance. The failure mode
 * is "the surface vanished", not "the surface looks worse". Declare a region only
 * from geometry you own, and be generous at the edges.
 */
void nidara_wl_visible_region_begin (GdkSurface *surface);

/**
 * nidara_wl_visible_region_add_rect:
 * @surface: the #GdkSurface being described
 * @x: rectangle x, in surface-local coordinates
 * @y: rectangle y
 * @width: rectangle width
 * @height: rectangle height
 *
 * Adds a rectangle to the region opened by nidara_wl_visible_region_begin().
 */
void nidara_wl_visible_region_add_rect (GdkSurface *surface,
                                        int         x,
                                        int         y,
                                        int         width,
                                        int         height);

/**
 * nidara_wl_visible_region_commit:
 * @surface: the #GdkSurface being described
 *
 * Sends the accumulated region.
 *
 * Wayland applies surface state on wl_surface.commit, which GTK issues on its own
 * frame cycle — so this takes effect on the next frame the surface actually
 * paints.
 *
 * ⚠️ A surface whose content does not change may never commit, and then the
 * region sits in the compositor's pending state indefinitely, doing nothing.
 * gtk_widget_queue_draw() is NOT enough on its own: GTK skips the frame when the
 * render node comes out identical. This is a real trap — it cost a full A/B round
 * here, with the region delivered, %TRUE returned, and no visible effect.
 * Declare the region as part of a change that repaints, not as a separate step.
 *
 * Returns: %TRUE if the region reached the compositor. %FALSE means the hint was
 *   dropped — no support, or the surface is not mapped yet — which is not an
 *   error, just the un-optimised path. Worth checking once while wiring a new
 *   surface up: a silent %FALSE looks exactly like a working optimisation that
 *   saves nothing.
 */
gboolean nidara_wl_visible_region_commit (GdkSurface *surface);

/**
 * nidara_wl_visible_region_clear:
 * @surface: the #GdkSurface to reset
 *
 * Drops any declared region: the whole surface is visible again. This is the
 * escape hatch — call it before anything that changes what the surface paints in
 * a way the region does not describe yet.
 */
void nidara_wl_visible_region_clear (GdkSurface *surface);

G_END_DECLS
