# Shell1 contract (#959 B)

This crate is the wire contract consumed by the Rust CLI and, in C, the Rust
process that actually paints the OSD. It supplies typed asynchronous and blocking
zbus proxies, typed state, and the error namespace. **It serves nothing.**
Default backend is async-io for toolkit clients; the CLI explicitly disables
default features and selects `tokio`, then enters its own runtime. Do not force
Tokio on the toolkit's existing blocking zbus clients.

Bus name `org.nidara.Shell`, path `/org/nidara/Shell`, interface
`org.nidara.Shell1`. This replaces neither the TS `org.nidara.Shell.Request(as)`
interface nor any service inside sessiond. The CLI selects the session explicitly;
it never tries the TS method when Shell1 is missing or refuses a request.

| Member | Signature / meaning |
| --- | --- |
| Available | `b`, at least one advertised usable capability |
| Capabilities | `as`, per-function vocabulary in `src/lib.rs` |
| GetState | `() → (b a(sb) s)`, locked, available surface visibility, island mode |
| ToggleSurface | `(s surface, b keyboard) → ()` |
| SetIsland | `(s mode) → ()`; empty mode means collapsed |
| FocusSurface | `(s bar-or-dock) → ()` |
| OpenSettings | `(s page, s app) → ()`; empty strings mean default |
| ShowOSD | `(s kind, d confirmed-value, b muted, s label) → ()` |
| StateChanged | signal `((b a(sb) s))`, the current authoritative state |

Surface names: `cc`, `nc`, `prism`, `app-grid`, `overview`, `player`, `agent`,
`about`, `bar-overlay`; focus names `bar` and `dock`. The server validates the
vocabulary, arguments and availability before an effect; it rejects unsupported
methods with `org.nidara.Shell1.Error.Unavailable`, not a successful no-op.
`Invalid`, `AccessDenied` and `Failed` use the same error prefix. Only available
surfaces occur in State; their absence never means 'closed'. State is read from
the renderer, not a mirrored broker or an acknowledged pending request.

C only advertises `osd:volume` and `osd:brightness`, with no bar/panels. A missing
bar remains Unavailable until step 2. ShowOSD reports already confirmed service
values; it does not change Audio1 or DisplayBrightness1. Value is finite in
0..=1 (volume above 100% is clamped for display by the producer), kind is volume
or brightness, and muted applies only to volume. OSD is click-through and takes
no keyboard focus. **No OSD over ext-session-lock**: the future Rust lockscreen
paints its own. The renderer must refuse a locked request and remove OSD on lock.

The owner enforces the common `nidara-access` policy at the effect. Reads use
Read; showing/toggling/closing a shell surface uses OpenSurface. Arguments never
grant a role; no generic interpreter, nidara-ipc invocation or well-known bus
name is privileged. New methods need an explicit policy choice. There is no
application enumeration/launch, arbitrary dispatch, config writing, capture or
input injection in this interface. Applications1 is a separate block.

See `session/ipc/README.md` for actual CLI routes and local checks. In B no
production Shell1 service runs; private bus tests use a deliberately small fake
renderer, and real headless tests verify missing-renderer behavior.
