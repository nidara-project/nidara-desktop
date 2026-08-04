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
 *  3. FOCUS GRAB (hyprland-focus-grab-v1). Keyboard focus for a layer surface
 *     WITHOUT layer-shell's EXCLUSIVE interactivity, plus compositor-side
 *     outside-click dismissal. Replaces two long-standing kludges: the full-screen
 *     invisible "catcher" buttons, and the EXCLUSIVE/ON_DEMAND dance whose release
 *     is double-buffered (core/InputYield, HyprlandState.afterGrabRelease).
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

/* ------------------------------------------------------------- focus grab */

/**
 * nidara_wl_has_focus_grab:
 *
 * Whether the compositor advertises hyprland_focus_grab_manager_v1.
 *
 * Returns: %TRUE if focus grabs are supported
 */
gboolean nidara_wl_has_focus_grab (void);

/**
 * NidaraWlFocusGrabClearedFunc:
 * @user_data: the data passed to nidara_wl_focus_grab_acquire()
 *
 * Called when the compositor takes the grab away — see
 * nidara_wl_focus_grab_acquire() for the three things that do that. It is NOT
 * called when the grab is dropped by nidara_wl_focus_grab_release(): that path
 * is the caller's own decision and it already knows.
 */
typedef void (*NidaraWlFocusGrabClearedFunc) (gpointer user_data);

/**
 * nidara_wl_focus_grab_acquire:
 * @surface: the #GdkSurface that should own keyboard and pointer
 * @cleared: (nullable) (scope notified) (closure user_data) (destroy destroy):
 *   called when the compositor clears the grab
 * @user_data: data for @cleared
 * @destroy: (nullable): called when @user_data is no longer needed
 *
 * Restricts input to @surface. While the grab holds:
 *
 *  - @surface receives keyboard focus even with layer-shell interactivity NONE
 *    (CFocusGrab drives CFocusState::rawSurfaceFocus directly, which does not
 *    look at interactivity). This is the point: EXCLUSIVE is what puts a surface
 *    in Hyprland's m_exclusiveLSes, and that list makes the compositor REFUSE to
 *    move window focus at all — the reason core/InputYield had to exist.
 *  - a pointer press outside @surface clears the grab and dismisses, without any
 *    widget of ours having to cover the screen to notice it.
 *  - the pointer merely MOVING outside is clamped to @surface, so nothing under
 *    us gets phantom hover.
 *  - on release the compositor refocuses the window the user came from, honouring
 *    input:follow_mouse. We no longer do that by hand.
 *
 * ⚠️ There is exactly ONE grab slot in the compositor (CSeatManager::m_seatGrab)
 * and xdg-shell popups use the SAME slot for their own grab. So a #GtkPopover
 * with autohide opening anywhere in the process will evict this grab, and
 * @cleared will fire. Three things clear a grab, and they are indistinguishable
 * from the client side:
 *
 *   1. the user pressed outside @surface (the dismissal we want),
 *   2. a popup grab took the slot,
 *   3. a layer surface mapped with interactivity != NONE (LayerSurface.cpp).
 *
 * Treat @cleared as "you no longer hold input", not as "the user dismissed you",
 * and re-acquire if the surface is still meant to be up.
 *
 * Acquiring while another grab of ours is live releases that one first.
 *
 * Returns: %TRUE if the grab reached the compositor. %FALSE means no support or
 *   an unmapped surface — the caller must keep its old mechanism in that case.
 */
gboolean nidara_wl_focus_grab_acquire (GdkSurface                   *surface,
                                       NidaraWlFocusGrabClearedFunc  cleared,
                                       gpointer                      user_data,
                                       GDestroyNotify                destroy);

/**
 * nidara_wl_focus_grab_add_surface:
 * @surface: another #GdkSurface the live grab should accept
 *
 * Widens the active grab's whitelist. The protocol's whitelist is a SET, and this
 * is the reason it is: a press inside any whitelisted surface is delivered
 * normally and does NOT dismiss.
 *
 * 🔑 Why a surface that is merely adjacent needs to be in the set. On an outside
 * press the compositor delivers the button to whatever holds pointer focus — and
 * while a grab is up the pointer is CLAMPED to the grabbed surface — and only then
 * clears the grab. So the press never reaches the thing you clicked: an outside
 * click dismisses and does nothing else. When a second surface of ours is supposed
 * to stay clickable through the grab (the bar strip, under the island's modes, so
 * capsule-to-capsule switching stays ONE click), it has to be whitelisted rather
 * than left outside.
 *
 * No-op when no grab is held. Takes effect immediately, like acquire.
 *
 * Returns: %TRUE if the widened whitelist reached the compositor
 */
gboolean nidara_wl_focus_grab_add_surface (GdkSurface *surface);

/**
 * nidara_wl_focus_grab_release:
 *
 * Gives the grab back. Unlike dropping layer-shell keyboard interactivity — which
 * is double-buffered and only applies on the surface's next commit, a ~12 ms race
 * that cost us afterGrabRelease() — this takes effect when the compositor reads
 * the request. No-op when nothing is held.
 */
void nidara_wl_focus_grab_release (void);

/**
 * nidara_wl_focus_grab_active:
 *
 * Returns: %TRUE while a grab acquired here is believed to be held
 */
gboolean nidara_wl_focus_grab_active (void);

G_END_DECLS
