/* nidara-wl — see nidara-wl.h for what this is and why it exists. */

#define _GNU_SOURCE   /* memfd_create */

#include "nidara-wl.h"

#include <cairo.h>
#include <errno.h>
#include <fcntl.h>
#include <gdk/wayland/gdkwayland.h>
#include <poll.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>

#include "ext-foreign-toplevel-list-v1-client-protocol.h"
#include "ext-image-capture-source-v1-client-protocol.h"
#include "ext-image-copy-capture-v1-client-protocol.h"
#include "hyprland-focus-grab-v1-client-protocol.h"
#include "hyprland-surface-v1-client-protocol.h"
#include "hyprland-toplevel-mapping-v1-client-protocol.h"
#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "nidara-material-v1-client-protocol.h"
#include "nidara-window-controls-v1-client-protocol.h"

/* A capture that has not answered in this long is not coming. Generous on
 * purpose: the compositor schedules the copy on its own frame clock, and a
 * capture issued while nothing else is repainting waits for the next frame —
 * measured at 8-20ms typically but with 120ms outliers on an idle screen. */
#define CAPTURE_TIMEOUT_MS 2000

G_DEFINE_QUARK (nidara-wl-error-quark, nidara_wl_error)

/* ======================================================================
 * Shared init state
 *
 * Two different Wayland connections, deliberately:
 *
 *  - The VISIBLE REGION side must ride GDK's connection, because the surfaces it
 *    talks about are GDK's. It only ever SENDS requests; its objects live on a
 *    private event queue so nothing it does can be dispatched into GDK's.
 *
 *  - The CAPTURE side opens its OWN connection, per capture, on a worker thread.
 *    Sharing GDK's connection across threads would mean coordinating with GDK's
 *    reader, and there is nothing to gain: a connect + two roundtrips costs a
 *    couple of milliseconds against a capture that costs tens.
 * ====================================================================== */

static gboolean                        wl_inited = FALSE;
static gboolean                        wl_ok = FALSE;
static struct wl_display              *gdk_wl_display = NULL;
static struct wl_event_queue          *shim_queue = NULL;
static struct hyprland_surface_manager_v1 *surface_mgr = NULL;
static struct hyprland_focus_grab_manager_v1 *focus_grab_mgr = NULL;
static gboolean                        capture_supported = FALSE;
static struct nidara_material_manager_v1 *material_mgr = NULL;
static struct nidara_window_controls_manager_v1 *controls_mgr = NULL;

static void
init_registry_global (void *data, struct wl_registry *registry, uint32_t name,
                      const char *interface, uint32_t version)
{
  (void) data;

  if (g_strcmp0 (interface, hyprland_surface_manager_v1_interface.name) == 0)
    {
      /* set_visible_region is since=2; on v1 we bind nothing and report the
       * capability as unavailable rather than silently doing nothing. */
      if (version >= 2)
        surface_mgr = wl_registry_bind (registry, name,
                                        &hyprland_surface_manager_v1_interface, 2);
    }
  else if (g_strcmp0 (interface,
                      hyprland_focus_grab_manager_v1_interface.name) == 0)
    focus_grab_mgr = wl_registry_bind (registry, name,
                                       &hyprland_focus_grab_manager_v1_interface, 1);
  else if (g_strcmp0 (interface,
                      ext_image_copy_capture_manager_v1_interface.name) == 0)
    capture_supported = TRUE;
  else if (g_strcmp0 (interface, nidara_material_manager_v1_interface.name) == 0)
    {
      /* Version 1 is the whole protocol: it is ours and unpublished, so a request
       * it gains goes into version 1 rather than a new one (owner, 2026-10-02). The
       * library and Hyalo are therefore installed together. */
      material_mgr = wl_registry_bind (registry, name,
                                       &nidara_material_manager_v1_interface, 1);
    }
  else if (g_strcmp0 (interface, nidara_window_controls_manager_v1_interface.name) == 0)
    controls_mgr = wl_registry_bind (registry, name,
                                     &nidara_window_controls_manager_v1_interface, 1);
}

static void
init_registry_global_remove (void *data, struct wl_registry *r, uint32_t name)
{
  (void) data; (void) r; (void) name;
}

static const struct wl_registry_listener init_registry_listener = {
  .global = init_registry_global,
  .global_remove = init_registry_global_remove,
};

gboolean
nidara_wl_init (GError **error)
{
  if (wl_inited)
    {
      if (!wl_ok)
        g_set_error_literal (error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                             "nidara-wl is unavailable in this session");
      return wl_ok;
    }
  wl_inited = TRUE;

  GdkDisplay *display = gdk_display_get_default ();
  if (!GDK_IS_WAYLAND_DISPLAY (display))
    {
      g_set_error_literal (error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                           "not a Wayland session");
      return FALSE;
    }

  gdk_wl_display = gdk_wayland_display_get_wl_display (display);
  if (!gdk_wl_display)
    {
      g_set_error_literal (error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                           "no wl_display behind the GDK display");
      return FALSE;
    }

  shim_queue = wl_display_create_queue (gdk_wl_display);

  /* Bind through a proxy wrapper so the registry — and everything it creates —
   * is dispatched on our queue, never on GDK's. */
  struct wl_display *wrapped = wl_proxy_create_wrapper (gdk_wl_display);
  wl_proxy_set_queue ((struct wl_proxy *) wrapped, shim_queue);
  struct wl_registry *registry = wl_display_get_registry (wrapped);
  wl_proxy_wrapper_destroy (wrapped);

  wl_registry_add_listener (registry, &init_registry_listener, NULL);
  wl_display_roundtrip_queue (gdk_wl_display, shim_queue);
  wl_registry_destroy (registry);

  wl_ok = TRUE;
  return TRUE;
}

gboolean
nidara_wl_is_available (void)
{
  return wl_ok;
}

gboolean
nidara_wl_has_visible_region (void)
{
  return wl_ok && surface_mgr != NULL;
}

gboolean
nidara_wl_has_capture (void)
{
  return wl_ok && capture_supported;
}

gboolean
nidara_wl_has_focus_grab (void)
{
  return wl_ok && focus_grab_mgr != NULL;
}

/* ======================================================================
 * Visible region
 * ====================================================================== */

/* Per-GdkSurface state, hung off the surface itself so it dies with it. */
typedef struct
{
  struct hyprland_surface_v1 *hypr_surface;
  struct wl_region           *pending;
} SurfaceState;

static void
surface_state_free (gpointer data)
{
  SurfaceState *st = data;

  if (st->pending)
    wl_region_destroy (st->pending);
  if (st->hypr_surface)
    hyprland_surface_v1_destroy (st->hypr_surface);
  g_free (st);
}

static SurfaceState *
surface_state_get (GdkSurface *surface, gboolean create)
{
  if (!nidara_wl_has_visible_region () || !GDK_IS_WAYLAND_SURFACE (surface))
    return NULL;

  SurfaceState *st = g_object_get_data (G_OBJECT (surface), "nidara-wl-state");
  if (st || !create)
    return st;

  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (!wls)
    return NULL;   /* not mapped yet — there is no surface to talk about */

  st = g_new0 (SurfaceState, 1);
  st->hypr_surface =
    hyprland_surface_manager_v1_get_hyprland_surface (surface_mgr, wls);
  wl_proxy_set_queue ((struct wl_proxy *) st->hypr_surface, shim_queue);

  g_object_set_data_full (G_OBJECT (surface), "nidara-wl-state", st,
                          surface_state_free);
  return st;
}

void
nidara_wl_visible_region_begin (GdkSurface *surface)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));

  SurfaceState *st = surface_state_get (surface, TRUE);
  if (!st)
    return;

  if (st->pending)
    wl_region_destroy (st->pending);

  struct wl_compositor *compositor =
    gdk_wayland_display_get_wl_compositor (gdk_surface_get_display (surface));
  st->pending = wl_compositor_create_region (compositor);
  wl_proxy_set_queue ((struct wl_proxy *) st->pending, shim_queue);
}

void
nidara_wl_visible_region_add_rect (GdkSurface *surface,
                                   int x, int y, int width, int height)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));

  SurfaceState *st = surface_state_get (surface, FALSE);
  if (!st || !st->pending || width <= 0 || height <= 0)
    return;

  wl_region_add (st->pending, x, y, width, height);
}

gboolean
nidara_wl_visible_region_commit (GdkSurface *surface)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);

  SurfaceState *st = surface_state_get (surface, FALSE);
  if (!st || !st->pending)
    return FALSE;

  hyprland_surface_v1_set_visible_region (st->hypr_surface, st->pending);
  wl_region_destroy (st->pending);
  st->pending = NULL;

  /* The request is queued against the surface's next wl_surface.commit, which
   * GTK issues on its own frame cycle. Flushing only pushes it down the socket;
   * it does not make it take effect any sooner. */
  wl_display_flush (gdk_wl_display);
  return TRUE;
}

void
nidara_wl_visible_region_clear (GdkSurface *surface)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));

  SurfaceState *st = surface_state_get (surface, FALSE);
  if (!st)
    return;

  if (st->pending)
    {
      wl_region_destroy (st->pending);
      st->pending = NULL;
    }

  hyprland_surface_v1_set_visible_region (st->hypr_surface, NULL);
  wl_display_flush (gdk_wl_display);
}

/* ======================================================================
 * Material (nidara-material-v1 — protocols/ at the repository root)
 *
 * The glass's shapes and its blur, told to Hyalo, the compositor of our own (#680). Every request
 * is double-buffered by the protocol itself, so nothing is held here: the shapes
 * land with the surface's next wl_surface.commit, i.e. with the frame GTK is about
 * to paint when the caller runs in the frame clock's layout phase.
 * ====================================================================== */

gboolean
nidara_wl_has_material (void)
{
  return wl_ok && material_mgr != NULL;
}

static NidaraWlMaterialInkFunc ink_cb = NULL;
static gpointer                ink_cb_data = NULL;
static GDestroyNotify          ink_cb_destroy = NULL;

static void
material_handle_ink (void *data, struct nidara_material_v1 *m, uint32_t id, uint32_t dark)
{
  (void) m;
  if (ink_cb)
    ink_cb (GDK_SURFACE (data), id, dark != 0, ink_cb_data);
}

static const struct nidara_material_v1_listener material_listener = {
  .ink = material_handle_ink,
};

void
nidara_wl_material_set_ink_func (NidaraWlMaterialInkFunc func,
                                 gpointer                user_data,
                                 GDestroyNotify          destroy)
{
  if (ink_cb_destroy)
    ink_cb_destroy (ink_cb_data);
  ink_cb = func;
  ink_cb_data = user_data;
  ink_cb_destroy = destroy;
}

gboolean
nidara_wl_material_has_ink (void)
{
  return nidara_wl_has_material ();
}

static struct nidara_material_v1 *
material_get (GdkSurface *surface)
{
  if (!nidara_wl_has_material () || !GDK_IS_WAYLAND_SURFACE (surface))
    return NULL;

  struct nidara_material_v1 *m = g_object_get_data (G_OBJECT (surface), "nidara-wl-material");
  if (m)
    return m;

  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (!wls)
    return NULL;

  m = nidara_material_manager_v1_get_material (material_mgr, wls);
  /* GDK's own queue, not ours: the one event this object has (ink) is then
   * dispatched by GDK's reader on the main loop, as it arrives — nothing of ours
   * has to poll for it (see grab_pump for what that costs). */
  wl_proxy_set_queue ((struct wl_proxy *) m, NULL);
  nidara_material_v1_add_listener (m, &material_listener, surface);
  g_object_set_data_full (G_OBJECT (surface), "nidara-wl-material", m,
                          (GDestroyNotify) nidara_material_v1_destroy);
  return m;
}

void
nidara_wl_material_begin (GdkSurface *surface)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (m)
    nidara_material_v1_clear_shapes (m);
}

void
nidara_wl_material_add_shape (GdkSurface *surface,
                              double x, double y, double width, double height,
                              double corner_radius, double exponent)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m || width <= 0 || height <= 0)
    return;
  nidara_material_v1_add_shape (m,
                                wl_fixed_from_double (x), wl_fixed_from_double (y),
                                wl_fixed_from_double (width), wl_fixed_from_double (height),
                                wl_fixed_from_double (corner_radius),
                                wl_fixed_from_double (exponent));
}

void
nidara_wl_material_add_shape_clipped (GdkSurface *surface,
                                      double x, double y, double width, double height,
                                      double corner_radius, double exponent, double opacity,
                                      double clip_x, double clip_y,
                                      double clip_width, double clip_height)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m || width <= 0 || height <= 0 || opacity <= 0)
    return;
  nidara_material_v1_add_shape_clipped (m,
                                        wl_fixed_from_double (x), wl_fixed_from_double (y),
                                        wl_fixed_from_double (width), wl_fixed_from_double (height),
                                        wl_fixed_from_double (corner_radius),
                                        wl_fixed_from_double (exponent),
                                        wl_fixed_from_double (MIN (opacity, 1.0)),
                                        wl_fixed_from_double (clip_x), wl_fixed_from_double (clip_y),
                                        wl_fixed_from_double (clip_width),
                                        wl_fixed_from_double (clip_height));
}

void
nidara_wl_material_add_shape_pointed (GdkSurface *surface,
                                      double x, double y, double width, double height,
                                      double corner_radius, double exponent, double opacity,
                                      double clip_x, double clip_y,
                                      double clip_width, double clip_height,
                                      double base_x, double base_y, double tip_x, double tip_y,
                                      double pointer_width, double tip_radius, double base_radius)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m || width <= 0 || height <= 0 || opacity <= 0)
    return;
  nidara_material_v1_add_shape_pointed (m,
                                        wl_fixed_from_double (x), wl_fixed_from_double (y),
                                        wl_fixed_from_double (width), wl_fixed_from_double (height),
                                        wl_fixed_from_double (corner_radius),
                                        wl_fixed_from_double (exponent),
                                        wl_fixed_from_double (MIN (opacity, 1.0)),
                                        wl_fixed_from_double (clip_x), wl_fixed_from_double (clip_y),
                                        wl_fixed_from_double (clip_width),
                                        wl_fixed_from_double (clip_height),
                                        wl_fixed_from_double (base_x), wl_fixed_from_double (base_y),
                                        wl_fixed_from_double (tip_x), wl_fixed_from_double (tip_y),
                                        wl_fixed_from_double (pointer_width),
                                        wl_fixed_from_double (tip_radius),
                                        wl_fixed_from_double (base_radius));
}

void
nidara_wl_material_set_glass (GdkSurface *surface,
                              double tint_r, double tint_g, double tint_b,
                              double alpha_min, double alpha_max, double target_luminance,
                              double refraction, double rim, double saturation)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m)
    return;
  nidara_material_v1_set_glass (m,
                                wl_fixed_from_double (tint_r), wl_fixed_from_double (tint_g),
                                wl_fixed_from_double (tint_b), wl_fixed_from_double (alpha_min),
                                wl_fixed_from_double (alpha_max),
                                wl_fixed_from_double (target_luminance),
                                wl_fixed_from_double (refraction), wl_fixed_from_double (rim),
                                wl_fixed_from_double (saturation));
}

void
nidara_wl_material_set_lensing (GdkSurface *surface, double size_fraction)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (m)
    nidara_material_v1_set_lensing (m, wl_fixed_from_double (size_fraction));
}

void
nidara_wl_material_set_scrim (GdkSurface *surface, double max_strength, double size_fraction,
                              double tint_limit, double region_edge)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (m)
    nidara_material_v1_set_scrim (m, wl_fixed_from_double (max_strength),
                                  wl_fixed_from_double (size_fraction),
                                  wl_fixed_from_double (tint_limit),
                                  wl_fixed_from_double (region_edge));
}

void
nidara_wl_material_add_scrim_region (GdkSurface *surface,
                                     double x, double y, double width, double height,
                                     double falloff)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m || width <= 0 || height <= 0)
    return;
  nidara_material_v1_add_scrim_region (m,
                                       wl_fixed_from_double (x), wl_fixed_from_double (y),
                                       wl_fixed_from_double (width), wl_fixed_from_double (height),
                                       wl_fixed_from_double (falloff));
}

void
nidara_wl_material_set_fusion (GdkSurface *surface, guint group, double spacing)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m)
    return;
  nidara_material_v1_set_fusion (m, group, wl_fixed_from_double (MAX (spacing, 0.0)));
}

void
nidara_wl_material_clear_glass (GdkSurface *surface)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (m)
    nidara_material_v1_clear_glass (m);
}

void
nidara_wl_material_add_ink_box (GdkSurface *surface, guint id,
                                double x, double y, double width, double height)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m || width <= 0 || height <= 0)
    return;
  nidara_material_v1_add_ink_box (m, id,
                                  wl_fixed_from_double (x), wl_fixed_from_double (y),
                                  wl_fixed_from_double (width), wl_fixed_from_double (height));
}

void
nidara_wl_material_set_ink (GdkSurface *surface, double dark_above, double light_below,
                            double tint_r, double tint_g, double tint_b)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (!m)
    return;
  nidara_material_v1_set_ink (m, wl_fixed_from_double (dark_above), wl_fixed_from_double (light_below),
                              wl_fixed_from_double (tint_r), wl_fixed_from_double (tint_g),
                              wl_fixed_from_double (tint_b));
}

void
nidara_wl_material_clear_ink (GdkSurface *surface)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_material_v1 *m = material_get (surface);
  if (m)
    nidara_material_v1_clear_ink (m);
}

/* The material is double-buffered state: it takes effect with the surface's next
 * commit, and GTK commits only a frame that drew something. A change that moves no
 * pixel of the client's own — a tuning value, the glass's parameters — would wait
 * for the next unrelated redraw: the dock, which repaints only when touched, kept its
 * old glass indefinitely (2026-10-02). So at the end of the frame the material was
 * sent in, the surface is committed once more. Where GTK drew, it has committed
 * already and this commit carries nothing; where it did not, this is the commit. It
 * comes AFTER GTK's, never before: an early one would show the new shapes over the
 * old buffer for a frame. */
static void
material_after_paint (GdkFrameClock *clock, GdkSurface *surface)
{
  (void) clock;
  if (!g_object_get_data (G_OBJECT (surface), "nidara-wl-material-dirty"))
    return;
  g_object_set_data (G_OBJECT (surface), "nidara-wl-material-dirty", NULL);
  /* A surface hidden in the meantime has no role to commit for. */
  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (wls && gdk_surface_get_mapped (surface))
    {
      wl_surface_commit (wls);
      wl_display_flush (gdk_wl_display);
    }
}

gboolean
nidara_wl_material_commit (GdkSurface *surface, double blur_size, guint blur_passes)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);
  struct nidara_material_v1 *m = material_get (surface);
  if (!m)
    return FALSE;
  nidara_material_v1_set_blur (m, wl_fixed_from_double (blur_size), blur_passes);
  wl_display_flush (gdk_wl_display);
  GdkFrameClock *clock = gdk_surface_get_frame_clock (surface);
  if (clock)
    {
      if (!g_object_get_data (G_OBJECT (surface), "nidara-wl-material-hooked"))
        {
          g_signal_connect_object (clock, "after-paint", G_CALLBACK (material_after_paint),
                                   surface, G_CONNECT_AFTER);
          g_object_set_data (G_OBJECT (surface), "nidara-wl-material-hooked", GINT_TO_POINTER (1));
        }
      g_object_set_data (G_OBJECT (surface), "nidara-wl-material-dirty", GINT_TO_POINTER (1));
    }
  return TRUE;
}

/* ======================================================================
 * Window controls (nidara-window-controls-v1 — protocols/ at the repository root)
 *
 * The compositor draws a window's close/minimize/maximize over the app's own header, where the
 * app reserved room for them (#708 point 5). Here: the object per toplevel surface, the box's
 * position (double-buffered: it lands with the commit of the frame that left room for it), and
 * the `layout` event — the box to reserve and the side — handed to one process-wide function.
 * ====================================================================== */

gboolean
nidara_wl_has_window_controls (void)
{
  return wl_ok && controls_mgr != NULL;
}

static NidaraWlWindowControlsLayoutFunc controls_cb = NULL;
static gpointer                         controls_cb_data = NULL;
static GDestroyNotify                   controls_cb_destroy = NULL;

static void
controls_handle_layout (void *data, struct nidara_window_controls_v1 *c, uint32_t side,
                        wl_fixed_t width, wl_fixed_t height)
{
  (void) c;
  if (controls_cb)
    controls_cb (GDK_SURFACE (data), side, wl_fixed_to_double (width), wl_fixed_to_double (height),
                 controls_cb_data);
}

static const struct nidara_window_controls_v1_listener controls_listener = {
  .layout = controls_handle_layout,
};

void
nidara_wl_window_controls_set_layout_func (NidaraWlWindowControlsLayoutFunc func,
                                           gpointer                         user_data,
                                           GDestroyNotify                   destroy)
{
  if (controls_cb_destroy)
    controls_cb_destroy (controls_cb_data);
  controls_cb = func;
  controls_cb_data = user_data;
  controls_cb_destroy = destroy;
}

static struct nidara_window_controls_v1 *
controls_get (GdkSurface *surface)
{
  if (!nidara_wl_has_window_controls () || !GDK_IS_WAYLAND_SURFACE (surface))
    return NULL;

  struct nidara_window_controls_v1 *c = g_object_get_data (G_OBJECT (surface), "nidara-wl-controls");
  if (c)
    return c;

  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (!wls)
    return NULL;

  c = nidara_window_controls_manager_v1_get_window_controls (controls_mgr, wls);
  /* GDK's queue, as the material's: `layout` is dispatched on the main loop as it arrives. */
  wl_proxy_set_queue ((struct wl_proxy *) c, NULL);
  nidara_window_controls_v1_add_listener (c, &controls_listener, surface);
  g_object_set_data_full (G_OBJECT (surface), "nidara-wl-controls", c,
                          (GDestroyNotify) nidara_window_controls_v1_destroy);
  wl_display_flush (gdk_wl_display);
  return c;
}

gboolean
nidara_wl_window_controls_request (GdkSurface *surface)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);
  return controls_get (surface) != NULL;
}

/* Like the material: a position that moves no pixel of the app's would wait for its next
 * unrelated redraw, so the frame after it is committed once more (see material_after_paint). */
static void
controls_after_paint (GdkFrameClock *clock, GdkSurface *surface)
{
  (void) clock;
  if (!g_object_get_data (G_OBJECT (surface), "nidara-wl-controls-dirty"))
    return;
  g_object_set_data (G_OBJECT (surface), "nidara-wl-controls-dirty", NULL);
  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (wls && gdk_surface_get_mapped (surface))
    {
      wl_surface_commit (wls);
      wl_display_flush (gdk_wl_display);
    }
}

static void
controls_mark_dirty (GdkSurface *surface)
{
  wl_display_flush (gdk_wl_display);
  GdkFrameClock *clock = gdk_surface_get_frame_clock (surface);
  if (!clock)
    return;
  if (!g_object_get_data (G_OBJECT (surface), "nidara-wl-controls-hooked"))
    {
      g_signal_connect_object (clock, "after-paint", G_CALLBACK (controls_after_paint),
                               surface, G_CONNECT_AFTER);
      g_object_set_data (G_OBJECT (surface), "nidara-wl-controls-hooked", GINT_TO_POINTER (1));
    }
  g_object_set_data (G_OBJECT (surface), "nidara-wl-controls-dirty", GINT_TO_POINTER (1));
  gdk_surface_queue_render (surface);
}

gboolean
nidara_wl_window_controls_set_position (GdkSurface *surface, double x, double y)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);
  struct nidara_window_controls_v1 *c = controls_get (surface);
  if (!c)
    return FALSE;
  nidara_window_controls_v1_set_position (c, wl_fixed_from_double (x), wl_fixed_from_double (y));
  controls_mark_dirty (surface);
  return TRUE;
}

void
nidara_wl_window_controls_unset_position (GdkSurface *surface)
{
  g_return_if_fail (GDK_IS_SURFACE (surface));
  struct nidara_window_controls_v1 *c = controls_get (surface);
  if (!c)
    return;
  nidara_window_controls_v1_unset_position (c);
  controls_mark_dirty (surface);
}

gboolean
nidara_wl_window_controls_set_buttons (GdkSurface *surface, guint buttons)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);
  struct nidara_window_controls_v1 *c = controls_get (surface);
  if (!c)
    return FALSE;
  nidara_window_controls_v1_set_buttons (c, (uint32_t) buttons);
  controls_mark_dirty (surface);
  return TRUE;
}

/* ======================================================================
 * Focus grab
 *
 * One grab at a time, on purpose: the compositor has exactly one slot
 * (CSeatManager::m_seatGrab), so tracking more here would only invent state the
 * compositor does not have.
 * ====================================================================== */

static struct hyprland_focus_grab_v1 *grab = NULL;
static NidaraWlFocusGrabClearedFunc   grab_cleared_cb = NULL;
static gpointer                       grab_cleared_data = NULL;
static GDestroyNotify                 grab_cleared_destroy = NULL;
static guint                          grab_pump_id = 0;

/* Drop the local grab bookkeeping. `notify` runs the caller's GDestroyNotify;
 * skip it when the destroy notify itself is what got us here. */
static void
grab_forget (gboolean notify)
{
  if (grab_pump_id)
    {
      g_source_remove (grab_pump_id);
      grab_pump_id = 0;
    }

  if (grab)
    {
      hyprland_focus_grab_v1_destroy (grab);
      grab = NULL;
    }

  GDestroyNotify destroy = grab_cleared_destroy;
  gpointer       data    = grab_cleared_data;

  grab_cleared_cb      = NULL;
  grab_cleared_data    = NULL;
  grab_cleared_destroy = NULL;

  if (notify && destroy)
    destroy (data);
}

static void
grab_handle_cleared (void *data, struct hyprland_focus_grab_v1 *g)
{
  (void) data; (void) g;

  /* Snapshot before tearing down: the callback is entitled to acquire a new grab
   * from inside this call (a popup evicted us and the surface is still up), and
   * it must not have its own state ripped out from under it afterwards. */
  NidaraWlFocusGrabClearedFunc cb         = grab_cleared_cb;
  gpointer                     cb_data    = grab_cleared_data;
  GDestroyNotify               cb_destroy = grab_cleared_destroy;

  grab_forget (FALSE);   /* FALSE: cb_data has to outlive the callback */

  if (cb)
    cb (cb_data);

  /* Free the old data — unless the callback re-acquired carrying the very same
   * pointer, in which case it is live again and freeing it would be a use-after-
   * free on the next clear. */
  if (cb_destroy && !(grab != NULL && grab_cleared_data == cb_data))
    cb_destroy (cb_data);
}

static const struct hyprland_focus_grab_v1_listener grab_listener = {
  .cleared = grab_handle_cleared,
};

/* Our objects live on a private queue, so nobody dispatches them for us.
 *
 * We deliberately do NOT read the socket: GDK owns that fd and reads it
 * constantly, and wl_display_read_events() distributes to EVERY queue, ours
 * included. So the event is already sitting in our queue by the time GDK has
 * woken the main loop — all that is missing is dispatching it, which is what
 * this does, without touching the fd or racing GDK's reader.
 *
 * A timer rather than a GSource because the honest alternatives are worse: a
 * prepare() that always says "ready" turns the main loop into a spin, and a
 * check() on the fd would race the very reader we are avoiding. It only runs
 * while a grab is held (i.e. while a modal surface is open), and the cost of the
 * interval is how long a dismissal can lag — three frames at worst. */
#define GRAB_PUMP_MS 50

static gboolean
grab_pump (gpointer data)
{
  (void) data;

  if (wl_display_dispatch_queue_pending (gdk_wl_display, shim_queue) < 0)
    {
      grab_forget (TRUE);
      return G_SOURCE_REMOVE;
    }

  return grab ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

gboolean
nidara_wl_focus_grab_acquire (GdkSurface                   *surface,
                              NidaraWlFocusGrabClearedFunc  cleared,
                              gpointer                      user_data,
                              GDestroyNotify                destroy)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);

  if (!nidara_wl_has_focus_grab () || !GDK_IS_WAYLAND_SURFACE (surface))
    return FALSE;

  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (!wls)
    return FALSE;   /* not mapped yet — there is no surface to grab for */

  grab_forget (TRUE);

  grab = hyprland_focus_grab_manager_v1_create_grab (focus_grab_mgr);
  if (!grab)
    return FALSE;

  wl_proxy_set_queue ((struct wl_proxy *) grab, shim_queue);
  hyprland_focus_grab_v1_add_listener (grab, &grab_listener, NULL);

  grab_cleared_cb      = cleared;
  grab_cleared_data    = user_data;
  grab_cleared_destroy = destroy;

  hyprland_focus_grab_v1_add_surface (grab, wls);
  /* The grab starts here, in the compositor's handler for this request — not on
   * the surface's next wl_surface.commit. That is the whole difference from
   * set_visible_region above, and from layer-shell interactivity. */
  hyprland_focus_grab_v1_commit (grab);
  wl_display_flush (gdk_wl_display);

  grab_pump_id = g_timeout_add (GRAB_PUMP_MS, grab_pump, NULL);
  return TRUE;
}

gboolean
nidara_wl_focus_grab_add_surface (GdkSurface *surface)
{
  g_return_val_if_fail (GDK_IS_SURFACE (surface), FALSE);

  if (!grab || !GDK_IS_WAYLAND_SURFACE (surface))
    return FALSE;

  struct wl_surface *wls = gdk_wayland_surface_get_wl_surface (surface);
  if (!wls)
    return FALSE;

  /* Duplicate additions are ignored by the protocol, and committing again while
   * the grab is already active only re-runs CFocusGrab::start() — which skips
   * setGrab when m_grabActive and just re-checks focus. Safe to call repeatedly. */
  hyprland_focus_grab_v1_add_surface (grab, wls);
  hyprland_focus_grab_v1_commit (grab);
  wl_display_flush (gdk_wl_display);
  return TRUE;
}

void
nidara_wl_focus_grab_release (void)
{
  if (!grab)
    return;

  /* Destroying the object removes the grab; there is no need to commit an empty
   * whitelist first (CFocusGrab's destructor calls finish()). No `cleared` comes
   * back for a release we asked for. */
  grab_forget (TRUE);
  wl_display_flush (gdk_wl_display);
}

gboolean
nidara_wl_focus_grab_active (void)
{
  return grab != NULL;
}

/* ======================================================================
 * Capture
 * ====================================================================== */

#define MAX_TOPLEVELS 128

typedef struct
{
  struct ext_foreign_toplevel_handle_v1 *handle;
  guint64  address;
  gboolean address_known;
  /* The list's own identifier: on Hyalo, the window id in hex — the address. */
  gchar   *identifier;
} CapToplevel;

typedef struct
{
  struct wl_display *display;

  /* globals */
  struct wl_shm *shm;
  struct ext_foreign_toplevel_list_v1 *list;
  struct ext_foreign_toplevel_image_capture_source_manager_v1 *source_mgr;
  struct ext_image_copy_capture_manager_v1 *capture_mgr;
  struct hyprland_toplevel_mapping_manager_v1 *mapping_mgr;

  CapToplevel toplevels[MAX_TOPLEVELS];
  int         n_toplevels;

  /* session */
  guint32  buf_width, buf_height, shm_format;
  gboolean session_done, session_stopped;

  /* frame */
  gboolean frame_ready, frame_failed;
  guint32  fail_reason;
} CapCtx;

/* ---- toplevel list ---- */

static void cap_tl_closed (void *d, struct ext_foreign_toplevel_handle_v1 *h)
{ (void) d; (void) h; }
static void cap_tl_done (void *d, struct ext_foreign_toplevel_handle_v1 *h)
{ (void) d; (void) h; }
static void cap_tl_title (void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *t)
{ (void) d; (void) h; (void) t; }
static void cap_tl_app_id (void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *a)
{ (void) d; (void) h; (void) a; }
static void cap_tl_identifier (void *d, struct ext_foreign_toplevel_handle_v1 *h, const char *i)
{
  (void) h;
  CapToplevel *t = d;
  g_free (t->identifier);
  t->identifier = g_strdup (i);
}

static const struct ext_foreign_toplevel_handle_v1_listener cap_tl_listener = {
  .closed = cap_tl_closed, .done = cap_tl_done, .title = cap_tl_title,
  .app_id = cap_tl_app_id, .identifier = cap_tl_identifier,
};

static void
cap_list_toplevel (void *data, struct ext_foreign_toplevel_list_v1 *list,
                   struct ext_foreign_toplevel_handle_v1 *handle)
{
  (void) list;
  CapCtx *ctx = data;

  if (ctx->n_toplevels >= MAX_TOPLEVELS)
    {
      ext_foreign_toplevel_handle_v1_destroy (handle);
      return;
    }

  CapToplevel *t = &ctx->toplevels[ctx->n_toplevels++];
  t->handle = handle;
  t->address = 0;
  t->address_known = FALSE;
  t->identifier = NULL;
  ext_foreign_toplevel_handle_v1_add_listener (handle, &cap_tl_listener, t);
}

static void
cap_list_finished (void *d, struct ext_foreign_toplevel_list_v1 *l)
{ (void) d; (void) l; }

static const struct ext_foreign_toplevel_list_v1_listener cap_list_listener = {
  .toplevel = cap_list_toplevel, .finished = cap_list_finished,
};

/* ---- hyprland toplevel -> window address ----
 *
 * This is what makes identity exact. Matching a capture to a window by title or
 * class is guesswork that fails quietly on duplicates; the address is the same
 * one `hyprctl clients` reports. */

static void
cap_map_address (void *data, struct hyprland_toplevel_window_mapping_handle_v1 *h,
                 uint32_t hi, uint32_t lo)
{
  (void) h;
  CapToplevel *t = data;
  t->address = ((guint64) hi << 32) | lo;
  t->address_known = TRUE;
}

static void
cap_map_failed (void *data, struct hyprland_toplevel_window_mapping_handle_v1 *h)
{
  (void) h;
  ((CapToplevel *) data)->address_known = TRUE;   /* answered: it has no address */
}

static const struct hyprland_toplevel_window_mapping_handle_v1_listener cap_map_listener = {
  .window_address = cap_map_address, .failed = cap_map_failed,
};

/* ---- session ---- */

static void
cap_sess_buffer_size (void *d, struct ext_image_copy_capture_session_v1 *s,
                      uint32_t w, uint32_t h)
{
  (void) s;
  CapCtx *ctx = d;
  ctx->buf_width = w;
  ctx->buf_height = h;
}

static void
cap_sess_shm_format (void *d, struct ext_image_copy_capture_session_v1 *s, uint32_t fmt)
{
  (void) s;
  CapCtx *ctx = d;

  /* Take the first format we can turn into a texture without guessing. Both are
   * 32-bit little-endian, i.e. BGRA in memory — which is exactly cairo's
   * ARGB32/RGB24 layout, so the scale step below needs no conversion. */
  if (ctx->shm_format != WL_SHM_FORMAT_ARGB8888 &&
      (fmt == WL_SHM_FORMAT_ARGB8888 || fmt == WL_SHM_FORMAT_XRGB8888))
    ctx->shm_format = fmt;
}

static void
cap_sess_dmabuf_device (void *d, struct ext_image_copy_capture_session_v1 *s,
                        struct wl_array *dev)
{ (void) d; (void) s; (void) dev; }

static void
cap_sess_dmabuf_format (void *d, struct ext_image_copy_capture_session_v1 *s,
                        uint32_t f, struct wl_array *m)
{ (void) d; (void) s; (void) f; (void) m; }

static void
cap_sess_done (void *d, struct ext_image_copy_capture_session_v1 *s)
{ (void) s; ((CapCtx *) d)->session_done = TRUE; }

static void
cap_sess_stopped (void *d, struct ext_image_copy_capture_session_v1 *s)
{ (void) s; ((CapCtx *) d)->session_stopped = TRUE; }

static const struct ext_image_copy_capture_session_v1_listener cap_sess_listener = {
  .buffer_size = cap_sess_buffer_size,
  .shm_format = cap_sess_shm_format,
  .dmabuf_device = cap_sess_dmabuf_device,
  .dmabuf_format = cap_sess_dmabuf_format,
  .done = cap_sess_done,
  .stopped = cap_sess_stopped,
};

/* ---- frame ---- */

static void
cap_frame_transform (void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t t)
{ (void) d; (void) f; (void) t; }

static void
cap_frame_damage (void *d, struct ext_image_copy_capture_frame_v1 *f,
                  int32_t x, int32_t y, int32_t w, int32_t h)
{ (void) d; (void) f; (void) x; (void) y; (void) w; (void) h; }

static void
cap_frame_presentation_time (void *d, struct ext_image_copy_capture_frame_v1 *f,
                             uint32_t hi, uint32_t lo, uint32_t ns)
{ (void) d; (void) f; (void) hi; (void) lo; (void) ns; }

static void
cap_frame_ready (void *d, struct ext_image_copy_capture_frame_v1 *f)
{ (void) f; ((CapCtx *) d)->frame_ready = TRUE; }

static void
cap_frame_failed (void *d, struct ext_image_copy_capture_frame_v1 *f, uint32_t reason)
{
  (void) f;
  CapCtx *ctx = d;
  ctx->frame_failed = TRUE;
  ctx->fail_reason = reason;
}

static const struct ext_image_copy_capture_frame_v1_listener cap_frame_listener = {
  .transform = cap_frame_transform,
  .damage = cap_frame_damage,
  .presentation_time = cap_frame_presentation_time,
  .ready = cap_frame_ready,
  .failed = cap_frame_failed,
};

/* ---- registry ---- */

static void
cap_registry_global (void *data, struct wl_registry *reg, uint32_t name,
                     const char *iface, uint32_t version)
{
  (void) version;
  CapCtx *ctx = data;

  if (g_strcmp0 (iface, wl_shm_interface.name) == 0)
    ctx->shm = wl_registry_bind (reg, name, &wl_shm_interface, 1);
  else if (g_strcmp0 (iface, ext_foreign_toplevel_list_v1_interface.name) == 0)
    ctx->list = wl_registry_bind (reg, name, &ext_foreign_toplevel_list_v1_interface, 1);
  else if (g_strcmp0 (iface,
           ext_foreign_toplevel_image_capture_source_manager_v1_interface.name) == 0)
    ctx->source_mgr = wl_registry_bind (reg, name,
           &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1);
  else if (g_strcmp0 (iface, ext_image_copy_capture_manager_v1_interface.name) == 0)
    ctx->capture_mgr = wl_registry_bind (reg, name,
           &ext_image_copy_capture_manager_v1_interface, 1);
  else if (g_strcmp0 (iface, hyprland_toplevel_mapping_manager_v1_interface.name) == 0)
    ctx->mapping_mgr = wl_registry_bind (reg, name,
           &hyprland_toplevel_mapping_manager_v1_interface, 1);
}

static void
cap_registry_global_remove (void *d, struct wl_registry *r, uint32_t n)
{ (void) d; (void) r; (void) n; }

static const struct wl_registry_listener cap_registry_listener = {
  .global = cap_registry_global, .global_remove = cap_registry_global_remove,
};

/* ---- event pump with a deadline ----
 *
 * wl_display_dispatch() blocks forever, and "forever" on a UI thread's worker is
 * still a leaked thread. Poll the fd instead so a compositor that never answers
 * costs us a timeout, not a thread. */
static gboolean
cap_pump (struct wl_display *display, gint64 deadline_us)
{
  while (wl_display_prepare_read (display) != 0)
    {
      if (wl_display_dispatch_pending (display) < 0)
        return FALSE;
    }

  if (wl_display_flush (display) < 0 && errno != EAGAIN)
    {
      wl_display_cancel_read (display);
      return FALSE;
    }

  gint64 remaining_ms = (deadline_us - g_get_monotonic_time ()) / 1000;
  if (remaining_ms < 0)
    remaining_ms = 0;

  struct pollfd pfd = { .fd = wl_display_get_fd (display), .events = POLLIN };
  int rc = poll (&pfd, 1, (int) remaining_ms);
  if (rc <= 0)
    {
      wl_display_cancel_read (display);
      return FALSE;
    }

  if (wl_display_read_events (display) < 0)
    return FALSE;

  return wl_display_dispatch_pending (display) >= 0;
}

static int
anon_shm_fd (gsize size)
{
  int fd = memfd_create ("nidara-wl-capture", MFD_CLOEXEC);
  if (fd < 0)
    return -1;
  if (ftruncate (fd, (off_t) size) < 0)
    {
      close (fd);
      return -1;
    }
  return fd;
}

/* Scale the captured frame down to fit, and copy it out of the shm mapping into
 * a texture that owns its pixels.
 *
 * The scale is not a nicety: a capture comes back at the window's real size, so
 * a strip of full-size 2560x1440 frames is ~14 MB each. Scaling here means the
 * big buffer lives for one memcpy and the caller holds only the thumbnail. */
static GdkTexture *
texture_from_capture (const guint8 *src, guint32 width, guint32 height,
                      guint32 stride, guint32 format,
                      int max_width, int max_height)
{
  double scale = 1.0;
  if (max_width > 0)
    scale = MIN (scale, (double) max_width / (double) width);
  if (max_height > 0)
    scale = MIN (scale, (double) max_height / (double) height);

  int out_w = MAX (1, (int) (width * scale + 0.5));
  int out_h = MAX (1, (int) (height * scale + 0.5));

  /* XRGB has no meaningful alpha; saying so keeps cairo from compositing against
   * garbage in the unused byte. */
  cairo_format_t cformat = (format == WL_SHM_FORMAT_XRGB8888)
                             ? CAIRO_FORMAT_RGB24 : CAIRO_FORMAT_ARGB32;

  cairo_surface_t *source = cairo_image_surface_create_for_data (
    (guchar *) src, cformat, (int) width, (int) height, (int) stride);
  cairo_surface_t *dest = cairo_image_surface_create (cformat, out_w, out_h);

  cairo_t *cr = cairo_create (dest);
  cairo_scale (cr, scale, scale);
  cairo_set_source_surface (cr, source, 0, 0);
  cairo_pattern_set_filter (cairo_get_source (cr), CAIRO_FILTER_GOOD);
  cairo_set_operator (cr, CAIRO_OPERATOR_SOURCE);
  cairo_paint (cr);
  cairo_destroy (cr);
  cairo_surface_flush (dest);

  int dest_stride = cairo_image_surface_get_stride (dest);
  GBytes *bytes = g_bytes_new (cairo_image_surface_get_data (dest),
                               (gsize) dest_stride * out_h);

  GdkTexture *texture = gdk_memory_texture_new (
    out_w, out_h,
    cformat == CAIRO_FORMAT_RGB24 ? GDK_MEMORY_B8G8R8X8
                                  : GDK_MEMORY_B8G8R8A8_PREMULTIPLIED,
    bytes, (gsize) dest_stride);

  g_bytes_unref (bytes);
  cairo_surface_destroy (dest);
  cairo_surface_destroy (source);

  return texture;
}

static void
cap_ctx_teardown (CapCtx *ctx)
{
  for (int i = 0; i < ctx->n_toplevels; i++)
    {
      if (ctx->toplevels[i].handle)
        ext_foreign_toplevel_handle_v1_destroy (ctx->toplevels[i].handle);
      g_clear_pointer (&ctx->toplevels[i].identifier, g_free);
    }

  if (ctx->mapping_mgr)
    hyprland_toplevel_mapping_manager_v1_destroy (ctx->mapping_mgr);
  if (ctx->capture_mgr)
    ext_image_copy_capture_manager_v1_destroy (ctx->capture_mgr);
  if (ctx->source_mgr)
    ext_foreign_toplevel_image_capture_source_manager_v1_destroy (ctx->source_mgr);
  if (ctx->list)
    ext_foreign_toplevel_list_v1_destroy (ctx->list);
  if (ctx->shm)
    wl_shm_destroy (ctx->shm);
  if (ctx->display)
    wl_display_disconnect (ctx->display);
}

typedef struct
{
  guint64 address;
  int     max_width;
  int     max_height;
} CaptureRequest;

static void
capture_thread (GTask *task, gpointer source_object, gpointer task_data,
                GCancellable *cancellable)
{
  (void) source_object;

  CaptureRequest *req = task_data;
  CapCtx ctx = { 0 };
  ctx.shm_format = WL_SHM_FORMAT_XRGB8888;

  GError *error = NULL;
  GdkTexture *texture = NULL;
  gint64 deadline = g_get_monotonic_time () + CAPTURE_TIMEOUT_MS * 1000;

  struct ext_image_capture_source_v1        *source = NULL;
  struct ext_image_copy_capture_session_v1  *session = NULL;
  struct ext_image_copy_capture_frame_v1    *frame = NULL;
  struct wl_shm_pool                        *pool = NULL;
  struct wl_buffer                          *buffer = NULL;
  guint8                                    *pixels = MAP_FAILED;
  gsize                                      pixels_size = 0;
  int                                        fd = -1;

  ctx.display = wl_display_connect (NULL);
  if (!ctx.display)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                           "could not connect to the Wayland display");
      goto out;
    }

  struct wl_registry *registry = wl_display_get_registry (ctx.display);
  wl_registry_add_listener (registry, &cap_registry_listener, &ctx);
  wl_display_roundtrip (ctx.display);
  wl_registry_destroy (registry);

  if (!ctx.shm || !ctx.list || !ctx.source_mgr || !ctx.capture_mgr)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                           "compositor does not offer window capture");
      goto out;
    }

  /* Enumerate toplevels, then ask Hyprland which window address each one is.
   * Two roundtrips for the list (objects, then their properties), one for the
   * addresses. */
  ext_foreign_toplevel_list_v1_add_listener (ctx.list, &cap_list_listener, &ctx);
  wl_display_roundtrip (ctx.display);
  wl_display_roundtrip (ctx.display);

  if (ctx.mapping_mgr)
    {
      for (int i = 0; i < ctx.n_toplevels; i++)
        {
          struct hyprland_toplevel_window_mapping_handle_v1 *mh =
            hyprland_toplevel_mapping_manager_v1_get_window_for_toplevel (
              ctx.mapping_mgr, ctx.toplevels[i].handle);
          hyprland_toplevel_window_mapping_handle_v1_add_listener (
            mh, &cap_map_listener, &ctx.toplevels[i]);
        }
      wl_display_roundtrip (ctx.display);
    }
  else
    {
      /* No Hyprland mapping: Hyalo lists each window under its id in hex, which is
       * the address the shell holds for it (hyalo/compositor/src/capture.rs). */
      for (int i = 0; i < ctx.n_toplevels; i++)
        {
          CapToplevel *t = &ctx.toplevels[i];
          gchar *end = NULL;
          if (t->identifier && *t->identifier)
            {
              guint64 v = g_ascii_strtoull (t->identifier, &end, 16);
              if (end && *end == '\0')
                {
                  t->address = v;
                  t->address_known = TRUE;
                }
            }
        }
    }

  if (g_cancellable_set_error_if_cancelled (cancellable, &error))
    goto out;

  CapToplevel *target = NULL;
  for (int i = 0; i < ctx.n_toplevels; i++)
    if (ctx.toplevels[i].address == req->address)
      target = &ctx.toplevels[i];

  if (!target)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_NO_WINDOW,
                   "no window with address 0x%" G_GINT64_MODIFIER "x", req->address);
      goto out;
    }

  source = ext_foreign_toplevel_image_capture_source_manager_v1_create_source (
    ctx.source_mgr, target->handle);
  session = ext_image_copy_capture_manager_v1_create_session (
    ctx.capture_mgr, source, 0);
  ext_image_copy_capture_session_v1_add_listener (session, &cap_sess_listener, &ctx);

  while (!ctx.session_done && !ctx.session_stopped)
    {
      if (!cap_pump (ctx.display, deadline))
        {
          g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_TIMEOUT,
                               "capture session never became ready");
          goto out;
        }
    }

  if (ctx.session_stopped || ctx.buf_width == 0 || ctx.buf_height == 0)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                           "compositor stopped the capture session");
      goto out;
    }

  guint32 stride = ctx.buf_width * 4;
  pixels_size = (gsize) stride * ctx.buf_height;

  fd = anon_shm_fd (pixels_size);
  if (fd < 0)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                   "could not allocate %" G_GSIZE_FORMAT " bytes of shared memory: %s",
                   pixels_size, g_strerror (errno));
      goto out;
    }

  pixels = mmap (NULL, pixels_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                   "could not map the capture buffer: %s", g_strerror (errno));
      goto out;
    }
  memset (pixels, 0, pixels_size);

  pool = wl_shm_create_pool (ctx.shm, fd, (int32_t) pixels_size);
  buffer = wl_shm_pool_create_buffer (pool, 0, (int32_t) ctx.buf_width,
                                      (int32_t) ctx.buf_height, (int32_t) stride,
                                      ctx.shm_format);

  frame = ext_image_copy_capture_session_v1_create_frame (session);
  ext_image_copy_capture_frame_v1_add_listener (frame, &cap_frame_listener, &ctx);
  ext_image_copy_capture_frame_v1_attach_buffer (frame, buffer);
  ext_image_copy_capture_frame_v1_damage_buffer (frame, 0, 0,
                                                 (int32_t) ctx.buf_width,
                                                 (int32_t) ctx.buf_height);
  ext_image_copy_capture_frame_v1_capture (frame);

  while (!ctx.frame_ready && !ctx.frame_failed)
    {
      if (!cap_pump (ctx.display, deadline))
        {
          g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_TIMEOUT,
                               "compositor never delivered the frame");
          goto out;
        }
    }

  if (ctx.frame_failed)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                   "capture failed (reason %u)", ctx.fail_reason);
      goto out;
    }

  texture = texture_from_capture (pixels, ctx.buf_width, ctx.buf_height, stride,
                                  ctx.shm_format, req->max_width, req->max_height);

out:
  if (frame)
    ext_image_copy_capture_frame_v1_destroy (frame);
  if (buffer)
    wl_buffer_destroy (buffer);
  if (pool)
    wl_shm_pool_destroy (pool);
  if (pixels != MAP_FAILED)
    munmap (pixels, pixels_size);
  if (fd >= 0)
    close (fd);
  if (session)
    ext_image_copy_capture_session_v1_destroy (session);
  if (source)
    ext_image_capture_source_v1_destroy (source);
  cap_ctx_teardown (&ctx);

  if (texture)
    g_task_return_pointer (task, texture, g_object_unref);
  else
    g_task_return_error (task, error);
}

void
nidara_wl_capture_window (guint64              address,
                          int                  max_width,
                          int                  max_height,
                          GCancellable        *cancellable,
                          GAsyncReadyCallback  callback,
                          gpointer             user_data)
{
  GTask *task = g_task_new (NULL, cancellable, callback, user_data);
  g_task_set_source_tag (task, nidara_wl_capture_window);

  CaptureRequest *req = g_new0 (CaptureRequest, 1);
  req->address = address;
  req->max_width = max_width;
  req->max_height = max_height;
  g_task_set_task_data (task, req, g_free);

  g_task_run_in_thread (task, capture_thread);
  g_object_unref (task);
}

GdkTexture *
nidara_wl_capture_window_finish (GAsyncResult *result, GError **error)
{
  g_return_val_if_fail (g_task_is_valid (result, NULL), NULL);

  return g_task_propagate_pointer (G_TASK (result), error);
}

/* ======================================================= region capture ===
 *
 * What the output SHOWS in a rectangle — every layer, ours included — for the
 * adaptive glass (`ui/shell/core/BackdropProbe.ts`): the shell subtracts its own
 * paint from this to learn what its text actually sits on. A separate context from
 * the window capture above on purpose: different globals, and zwlr_screencopy is a
 * one-frame protocol (no session object), so sharing the struct would mean half of
 * each one's fields are dead in the other. */

#define MAX_OUTPUTS 16

typedef struct
{
  struct wl_output *output;
  char             *name;
} RegOutput;

typedef struct
{
  struct wl_display *display;
  struct wl_shm *shm;
  struct zwlr_screencopy_manager_v1 *screencopy;

  RegOutput outputs[MAX_OUTPUTS];
  int       n_outputs;

  /* frame */
  guint32  shm_format, buf_width, buf_height, buf_stride;
  gboolean have_shm_buffer, buffer_done;
  guint32  flags;
  gboolean frame_ready, frame_failed;
} RegCtx;

static void reg_out_geometry (void *d, struct wl_output *o, int32_t x, int32_t y,
                              int32_t pw, int32_t ph, int32_t sp, const char *mk,
                              const char *md, int32_t t)
{ (void) d; (void) o; (void) x; (void) y; (void) pw; (void) ph; (void) sp; (void) mk; (void) md; (void) t; }
static void reg_out_mode (void *d, struct wl_output *o, uint32_t f, int32_t w, int32_t h, int32_t r)
{ (void) d; (void) o; (void) f; (void) w; (void) h; (void) r; }
static void reg_out_done (void *d, struct wl_output *o) { (void) d; (void) o; }
static void reg_out_scale (void *d, struct wl_output *o, int32_t f) { (void) d; (void) o; (void) f; }
static void reg_out_description (void *d, struct wl_output *o, const char *s)
{ (void) d; (void) o; (void) s; }

static void
reg_out_name (void *data, struct wl_output *o, const char *name)
{
  (void) o;
  RegOutput *out = data;
  g_free (out->name);
  out->name = g_strdup (name);
}

static const struct wl_output_listener reg_output_listener = {
  .geometry = reg_out_geometry, .mode = reg_out_mode, .done = reg_out_done,
  .scale = reg_out_scale, .name = reg_out_name, .description = reg_out_description,
};

static void
reg_registry_global (void *data, struct wl_registry *reg, uint32_t name,
                     const char *iface, uint32_t version)
{
  RegCtx *ctx = data;

  if (g_strcmp0 (iface, wl_shm_interface.name) == 0)
    ctx->shm = wl_registry_bind (reg, name, &wl_shm_interface, 1);
  else if (g_strcmp0 (iface, zwlr_screencopy_manager_v1_interface.name) == 0 && version >= 3)
    /* v3 for `buffer_done`: without it there is no moment at which "every buffer
     * type has been offered" is known, and the copy is a guess. */
    ctx->screencopy = wl_registry_bind (reg, name, &zwlr_screencopy_manager_v1_interface, 3);
  else if (g_strcmp0 (iface, wl_output_interface.name) == 0 && version >= 4
           && ctx->n_outputs < MAX_OUTPUTS)
    {
      /* v4 for `name`: the connector string is the only identity GDK and Hyprland
       * both report, so it is what the caller passes. */
      RegOutput *out = &ctx->outputs[ctx->n_outputs++];
      out->output = wl_registry_bind (reg, name, &wl_output_interface, 4);
      wl_output_add_listener (out->output, &reg_output_listener, out);
    }
}

static const struct wl_registry_listener reg_registry_listener = {
  .global = reg_registry_global, .global_remove = cap_registry_global_remove,
};

static void
reg_frame_buffer (void *d, struct zwlr_screencopy_frame_v1 *f, uint32_t format,
                  uint32_t w, uint32_t h, uint32_t stride)
{
  (void) f;
  RegCtx *ctx = d;

  /* Same two formats as the window capture, same reason: BGRA in memory, which
   * Gdk has a memory format for without a conversion pass. */
  if (!ctx->have_shm_buffer &&
      (format == WL_SHM_FORMAT_ARGB8888 || format == WL_SHM_FORMAT_XRGB8888))
    {
      ctx->have_shm_buffer = TRUE;
      ctx->shm_format = format;
      ctx->buf_width = w;
      ctx->buf_height = h;
      ctx->buf_stride = stride;
    }
}

static void
reg_frame_flags (void *d, struct zwlr_screencopy_frame_v1 *f, uint32_t flags)
{ (void) f; ((RegCtx *) d)->flags = flags; }

static void
reg_frame_ready (void *d, struct zwlr_screencopy_frame_v1 *f,
                 uint32_t hi, uint32_t lo, uint32_t ns)
{ (void) f; (void) hi; (void) lo; (void) ns; ((RegCtx *) d)->frame_ready = TRUE; }

static void
reg_frame_failed (void *d, struct zwlr_screencopy_frame_v1 *f)
{ (void) f; ((RegCtx *) d)->frame_failed = TRUE; }

static void
reg_frame_damage (void *d, struct zwlr_screencopy_frame_v1 *f,
                  uint32_t x, uint32_t y, uint32_t w, uint32_t h)
{ (void) d; (void) f; (void) x; (void) y; (void) w; (void) h; }

static void
reg_frame_linux_dmabuf (void *d, struct zwlr_screencopy_frame_v1 *f,
                        uint32_t fmt, uint32_t w, uint32_t h)
{ (void) d; (void) f; (void) fmt; (void) w; (void) h; }

static void
reg_frame_buffer_done (void *d, struct zwlr_screencopy_frame_v1 *f)
{ (void) f; ((RegCtx *) d)->buffer_done = TRUE; }

static const struct zwlr_screencopy_frame_v1_listener reg_frame_listener = {
  .buffer = reg_frame_buffer,
  .flags = reg_frame_flags,
  .ready = reg_frame_ready,
  .failed = reg_frame_failed,
  .damage = reg_frame_damage,
  .linux_dmabuf = reg_frame_linux_dmabuf,
  .buffer_done = reg_frame_buffer_done,
};

typedef struct
{
  char *connector;
  int   x, y, width, height;
} RegionRequest;

static void
region_request_free (gpointer p)
{
  RegionRequest *req = p;
  g_free (req->connector);
  g_free (req);
}

static void
region_thread (GTask *task, gpointer source_object, gpointer task_data,
               GCancellable *cancellable)
{
  (void) source_object;

  RegionRequest *req = task_data;
  RegCtx ctx = { 0 };
  GError *error = NULL;
  GdkTexture *texture = NULL;
  gint64 deadline = g_get_monotonic_time () + CAPTURE_TIMEOUT_MS * 1000;

  struct zwlr_screencopy_frame_v1 *frame = NULL;
  struct wl_shm_pool              *pool = NULL;
  struct wl_buffer                *buffer = NULL;
  guint8                          *pixels = MAP_FAILED;
  gsize                            pixels_size = 0;
  int                              fd = -1;

  ctx.display = wl_display_connect (NULL);
  if (!ctx.display)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                           "could not connect to the Wayland display");
      goto out;
    }

  struct wl_registry *registry = wl_display_get_registry (ctx.display);
  wl_registry_add_listener (registry, &reg_registry_listener, &ctx);
  wl_display_roundtrip (ctx.display);    /* globals */
  wl_display_roundtrip (ctx.display);    /* each wl_output's name */
  wl_registry_destroy (registry);

  if (!ctx.shm || !ctx.screencopy)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_UNAVAILABLE,
                           "compositor does not offer zwlr_screencopy_manager_v1 v3");
      goto out;
    }

  struct wl_output *target = NULL;
  for (int i = 0; i < ctx.n_outputs; i++)
    if (g_strcmp0 (ctx.outputs[i].name, req->connector) == 0)
      target = ctx.outputs[i].output;

  if (!target)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_NO_OUTPUT,
                   "no output named \"%s\"", req->connector);
      goto out;
    }

  if (g_cancellable_set_error_if_cancelled (cancellable, &error))
    goto out;

  frame = zwlr_screencopy_manager_v1_capture_output_region (
    ctx.screencopy, 0, target, req->x, req->y, req->width, req->height);
  zwlr_screencopy_frame_v1_add_listener (frame, &reg_frame_listener, &ctx);

  while (!ctx.buffer_done && !ctx.frame_failed)
    {
      if (!cap_pump (ctx.display, deadline))
        {
          g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_TIMEOUT,
                               "compositor never described the frame");
          goto out;
        }
    }

  if (ctx.frame_failed || !ctx.have_shm_buffer || ctx.buf_width == 0 || ctx.buf_height == 0)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                           "compositor offered no usable shm buffer for the region");
      goto out;
    }

  pixels_size = (gsize) ctx.buf_stride * ctx.buf_height;
  fd = anon_shm_fd (pixels_size);
  if (fd < 0)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                   "could not allocate %" G_GSIZE_FORMAT " bytes of shared memory: %s",
                   pixels_size, g_strerror (errno));
      goto out;
    }

  pixels = mmap (NULL, pixels_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED)
    {
      g_set_error (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                   "could not map the capture buffer: %s", g_strerror (errno));
      goto out;
    }

  pool = wl_shm_create_pool (ctx.shm, fd, (int32_t) pixels_size);
  buffer = wl_shm_pool_create_buffer (pool, 0, (int32_t) ctx.buf_width,
                                      (int32_t) ctx.buf_height,
                                      (int32_t) ctx.buf_stride, ctx.shm_format);
  zwlr_screencopy_frame_v1_copy (frame, buffer);

  while (!ctx.frame_ready && !ctx.frame_failed)
    {
      if (!cap_pump (ctx.display, deadline))
        {
          g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_TIMEOUT,
                               "compositor never delivered the frame");
          goto out;
        }
    }

  if (ctx.frame_failed)
    {
      g_set_error_literal (&error, NIDARA_WL_ERROR, NIDARA_WL_ERROR_CAPTURE_FAILED,
                           "region capture failed");
      goto out;
    }

  /* Copy out of the shm mapping into bytes the texture owns, flipping if the
   * compositor says the rows came bottom-up — the caller reads pixels by
   * coordinate and must not have to know. */
  {
    gsize   row = (gsize) ctx.buf_stride;
    guint8 *copy = g_malloc (pixels_size);
    gboolean invert = (ctx.flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT) != 0;
    for (guint32 r = 0; r < ctx.buf_height; r++)
      memcpy (copy + r * row,
              pixels + (invert ? (ctx.buf_height - 1 - r) : r) * row, row);

    GBytes *bytes = g_bytes_new_take (copy, pixels_size);
    texture = gdk_memory_texture_new (
      (int) ctx.buf_width, (int) ctx.buf_height,
      ctx.shm_format == WL_SHM_FORMAT_XRGB8888 ? GDK_MEMORY_B8G8R8X8
                                               : GDK_MEMORY_B8G8R8A8_PREMULTIPLIED,
      bytes, row);
    g_bytes_unref (bytes);
  }

out:
  if (frame)
    zwlr_screencopy_frame_v1_destroy (frame);
  if (buffer)
    wl_buffer_destroy (buffer);
  if (pool)
    wl_shm_pool_destroy (pool);
  if (pixels != MAP_FAILED)
    munmap (pixels, pixels_size);
  if (fd >= 0)
    close (fd);
  for (int i = 0; i < ctx.n_outputs; i++)
    {
      wl_output_release (ctx.outputs[i].output);
      g_free (ctx.outputs[i].name);
    }
  if (ctx.screencopy)
    zwlr_screencopy_manager_v1_destroy (ctx.screencopy);
  if (ctx.shm)
    wl_shm_destroy (ctx.shm);
  if (ctx.display)
    wl_display_disconnect (ctx.display);

  if (texture)
    g_task_return_pointer (task, texture, g_object_unref);
  else
    g_task_return_error (task, error);
}

void
nidara_wl_capture_region (const char          *connector,
                          int                  x,
                          int                  y,
                          int                  width,
                          int                  height,
                          GCancellable        *cancellable,
                          GAsyncReadyCallback  callback,
                          gpointer             user_data)
{
  GTask *task = g_task_new (NULL, cancellable, callback, user_data);
  g_task_set_source_tag (task, nidara_wl_capture_region);

  RegionRequest *req = g_new0 (RegionRequest, 1);
  req->connector = g_strdup (connector);
  req->x = x;
  req->y = y;
  req->width = width;
  req->height = height;
  g_task_set_task_data (task, req, region_request_free);

  g_task_run_in_thread (task, region_thread);
  g_object_unref (task);
}

GdkTexture *
nidara_wl_capture_region_finish (GAsyncResult *result, GError **error)
{
  g_return_val_if_fail (g_task_is_valid (result, NULL), NULL);

  return g_task_propagate_pointer (G_TASK (result), error);
}
