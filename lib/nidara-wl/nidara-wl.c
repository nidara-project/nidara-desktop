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
{ (void) d; (void) h; (void) i; }

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
    if (ctx->toplevels[i].handle)
      ext_foreign_toplevel_handle_v1_destroy (ctx->toplevels[i].handle);

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

  if (!ctx.shm || !ctx.list || !ctx.source_mgr || !ctx.capture_mgr || !ctx.mapping_mgr)
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

  for (int i = 0; i < ctx.n_toplevels; i++)
    {
      struct hyprland_toplevel_window_mapping_handle_v1 *mh =
        hyprland_toplevel_mapping_manager_v1_get_window_for_toplevel (
          ctx.mapping_mgr, ctx.toplevels[i].handle);
      hyprland_toplevel_window_mapping_handle_v1_add_listener (
        mh, &cap_map_listener, &ctx.toplevels[i]);
    }
  wl_display_roundtrip (ctx.display);

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
