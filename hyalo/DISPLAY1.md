# Display1: compositor-owned output configuration

`org.nidara.Display` on the session bus, object `/org/nidara/Display`, interface
`org.nidara.Display1`, is implemented by Hyalo. The Rust wire records are in
`compositor/src/display/model.rs`; introspection is the wire signature source.
Methods returning records expose their fields as D-Bus output arguments. Clients
must subscribe to `Changed(epoch, revision)` before reading `GetState` and reread
the whole snapshot. Signals may coalesce intermediate revisions. The signal worker blocks on a change channel;
it has no polling clock.

The first two Displays cuts of #959 implement extended and mirrored layouts, output
configuration, primary publication, transactions, profiles, Identify and the
Power1 lid effect. DisplayBrightness1/DDC/Fn is served separately by sessiond; see
`../session/daemon/src/power/brightness/README.md`. The native Settings page and
Super+P remain a separate cut.
No TS bridge is added. The TS bar/dock do not follow the published primary;
the TS brightness widget continues using brightnessctl. No brightness OSD is added.

## Records and methods

The snapshot contains `epoch`, `revision`, `capabilities`, `outputs`, `layout`,
`pending` and `last_error`. Every connected output is included, also disabled
ones. Each has a connection-scoped `id`, persistent `identity`, connector,
internal/enabled/powered flags, make/model/serial, physical dimensions, advertised
modes, current mode, scale, transform, position, VRR capability/configuration/live
state and Identify number. A mode id contains width, height and **integer mHz**;
callers must use the advertised opaque id, not construct a string in Hz.

A layout names every connected output exactly once, plus an enabled `primary`
and ordered `mirror_groups`. Per-output settings are id, enabled,
mode, scale, transform, x, y and VRR (`off`, `on`, `games`). Coordinates are logical
pixels after transform and scale. The validator rejects unknown modes/ids,
nonfinite/out-of-range scales, unsupported VRR, excessive coordinates, overlaps,
disconnected arrangements and disabling the last output. Contact needs a shared
edge of positive length: corners alone do not connect. Different heights need
not fill the bounding rectangle. The compositor does not silently move a user's
invalid layout; a future UI can snap edges before calling Validate.

- `GetState()` reads a coherent snapshot.
- `GetHardwareState()` is an additive cached mapping for sessiond brightness. Its
  separate records (`compositor/src/display/hardware.rs`) carry epoch/revision,
  output id/identity/connector, canonical GPU port, EDID fingerprint,
  internal/enabled/logical flags, logical geometry and powered state. GetState's
  wire records remain unchanged. The powered flag lets sessiond restart finite
  read-only discovery when an output wakes; Hyalo performs no brightness I/O.
- `Validate(epoch, revision, layout)` checks geometry/capabilities and sorts a layout
  without effects. GPU/resource preflight happens in Preview, before mutation.
- `Preview(epoch, revision, layout)` starts one global transaction; returns
  pending token, phase and absolute CLOCK_MONOTONIC deadline in microseconds.
- `Confirm(token)` durably stores the accepted layout.
- `Cancel(token)` restores the previous layout, also after activity is lost.
- `Identify(epoch, revision)` labels enabled outputs for three seconds. It takes
  no input focus. The output records provide the corresponding accessible list.
- `SetLidState(generation, sequence, closed)` is exclusively a Power1 policy effect:
  the caller must own `org.nidara.Session`. Ordinary clients cannot use it.
  Effects from the same owner must have an increasing generation/sequence pair.

Errors use `org.nidara.Display1.Error`: StaleState, InvalidLayout, Unsupported,
Busy, PermissionDenied, Expired, ApplyFailed, PersistenceFailed. Error strings
are technical details, not translated UI messages. Future native consumers must
map errors to the existing exported locale catalogue. Identify contains numbers
only; this cut adds no user-facing translated text.

## Mirrored layouts

Each group is `[source_id, follower_id, ...]`, with at least two disjoint, enabled
members. The first member supplies the one logical scene: its windows, workspace,
wallpaper, layers, cursor and compositor material. Followers have no second desktop,
workspace or layer-shell scene. Their wl_output globals are withdrawn while mirrored
and restored when extended again; existing follower layers receive close. Physical
outputs remain visible in Display1, so a future native client can select or identify
them. Primary must be a logical source, never a follower.

Every member retains its own advertised mode, scale and transform. No shared mode
is required. Followers are excluded from desktop overlap/connectivity checks and
their x/y normalize to the source origin. A retained GPU canvas renders the source
scene in its upright physical pixels; each follower contains that canvas uniformly
and centers it over opaque black bands. Identify numbers are physical overlays,
so a follower shows its own number, never its source's number. Changing back to
extended releases the mirror canvas and restores logical output globals.

Associated absolute input and output-targeted virtual-pointer input use the same
contain projection back to source logical coordinates. Bands have no pointer target
and swallow presses and their matching releases; a grab begun in the scene receives an
out-of-scene motion before release in a band, so it cancels a click without sticking.
Relative input resumes from the last scene coordinate. Relative input traverses only logical desktops. Screenshots by
physical connector and existing follower screencopy/image-capture handles include
the projected picture and black bands. Newly enumerated Wayland clients see logical
sources only. Capture remains denied while locked; lock acknowledgement waits for
all powered physical followers as well as logical outputs.

Only the logical source normally sends frame callbacks, selects primary scanout/dmabuf
feedback and owns presentation feedback. Follower repaint completes its own captures,
without advancing the client's clock. If the source is DPMS-off, exactly one powered
follower (connector-name order) takes over the logical scene clock, keeping the source
as the logical output and using canvas states. Power changes queue redraws to transfer
ownership. Restoring the source returns ownership immediately; an inactive VT has no
clock. A rendering error does not elect another clock: normal recovery/error handling
applies. Queueing records the owning scene with the frame; follower-only flips cannot
consume source presentation feedback. The canvas and its sampling use the same GL
context, so their commands are ordered without a CPU wait for GPU completion.

This cut requires all group members on the primary rendering GPU, VRR `off` throughout
the group, and at most 16,777,216 source pixels summed over follower canvases. Preview
rejects unsupported GPU/texture combinations with Unsupported before modesetting;
validation does not promise a resource reservation against later driver failures.
A failed composition cannot activate the preview: the normal bounded lease restores
the previous layout. The mirror capability is advertised on DRM, never nested winit.
These are explicit backend limits, not permission to fall back to distorted or
independently rendered desktops. Duplicate connector names across GPUs remain refused.

Groups use stable identities in confirmed profiles and connection ids on the bus.
Cancel, timeout, owner loss and failed apply restore the complete previous grouping.
Topology changes reconcile profiles or safe defaults; a disconnected source is never
left as the authoritative desktop. Lid inhibition prunes the internal member and
promotes a surviving external to source, preserving a group when two externals remain;
opening restores the previous grouping. Legacy configuration cannot disable a group
member or enable its VRR behind Display1 validation; use a complete Display1 layout
to dissolve the group explicitly.

## Confirmation and recovery

D-Bus methods send typed commands to calloop. No D-Bus method mutates the scene
from its worker. The disk worker owns durable profile I/O. Discovery reads EDID
at connector events, not on every frame. Inventory reconciliation is scheduled by
output/connector, lock and VT events. A single timer exists only while a preview
is waiting for activation or confirmation, at its exact deadline. With no lease
or external event there is no Display1 timer wakeup. A transaction prepares all target
configs, enables destinations before disabling origins, and verifies observed
mode/enabled state. The backend may change one GPU before another fails; this
is recovery across GPUs, not a promise of atomic KMS across devices.

An apply has five seconds to produce a successful frame on **every enabled
output**. A frame built before the transaction does not count. Only then does
the 15-second confirmation deadline begin. Hardware uses frame-submitted/vblank;
winit uses successful host submission and does not prove physical presentation.
Unchanged destinations are forced to draw too. The client receives Preview only
after activation, while GetState can expose the applying phase with deadline 0.

Tokens belong to the caller's unique bus name. Another sender cannot cancel or
confirm them. A lost client, expiry, failed apply, changed topology, incompatible
config reload, lock or activity loss restores the entire previous layout. If it
cannot be restored, Hyalo attempts one output at a safe advertised mode. Recovery
on an inactive VT is deferred until that VT is active. A failed recovery is
reported in snapshot `last_error`; no failed mode is silently accepted.

Confirm received before expiry reserves the transaction while the disk worker
finishes the explicit confirmation. Concurrent mutations/cancel return Busy;
client departure after that accepted Confirm does not undo a successful save.
No new unconfirmed preview is saved. A failed save leaves the original token and
deadline armed (if already expired, completion immediately reverts it). The worker
uses an exclusive 0600 temporary file, file sync, rename and parent-directory sync;
only a successful save disarms the preview. On compositor restart, the confirmed
profile is loaded; pending preview tokens and temporary files are never replayed.

## Profiles, manual configuration and legacy callers

The versioned file is `hyalo-display-profiles.json` beside the settings layer.
With `HYALO_CONFIG`, persistence is possible only if `HYALO_SETTINGS` explicitly
selects a private settings layer. The key is the sorted multiset of identities
of all connected outputs, including disabled ones. Identity uses normalized
make/model/serial, otherwise a stable non-security FNV-1a EDID fingerprint;
missing/duplicate identities use the GPU sysfs device path and connector. When
sysfs is unavailable the GPU device number is a weaker fallback. Identical
serial-less monitors cannot be reliably distinguished after a port swap.

Connection ids change on a topology/mode-list epoch; persisted profiles contain
identities instead. An obsolete/unsupported profile is not rewritten by fallback.
A new set defaults to Unir: internal first and primary, external outputs to its
right in stable order, top edges aligned. Without an internal, use a deterministic
external. Reliable physical DPI chooses a quarter-step scale, rounded down (DPI/96, so a
27" 2560×1440 panel at ~108 DPI stays at 1.0 and a 27" 4K at ~163 gets 1.5); unknown
or implausible dimensions fall back to 1.0. Existing generated legacy settings
remain usable before Display1 first confirms that set. Explicit compositor layers
other than the generated settings layer constrain profiles and mutations; a
conflicting request is refused. Invalid startup constraints trigger safe recovery
and expose the refusal in `last_error`.

Legacy SetOutput uses the same whole-layout validation and recovery, never writes
a profile and is refused during a Display1 preview. Legacy settings output patches
are preflighted before disk writes. Once Display1 owns a confirmed profile for a
set, legacy output saves are refused explicitly rather than silently overriding
that profile. There is no TS client adaptation in this cut.

Current backend APIs address outputs by connector name. Duplicate connector names
across GPUs are explicitly refused before mutation; this cut does not claim
support for that ambiguous case. Single-GPU multimonitor and unique names across
GPUs use the same layout machinery; physical coverage remains separate below.

## Lid policy

Power1 remains the only lid/suspend/inhibitor policy owner. Its existing provider
refresh updates the desired lid effect, including false when state is unknown or
the session is inactive. The forwarder sends only when that value changes, and
replays the latest value when the bus owner of Display1 changes. A single task
coalesces in-flight updates and uses a bounded direct D-Bus call to the unique
owner, without property proxies; it does not await Hyalo from Power1 refresh.
Failures do not retry on unrelated refreshes. Firmware keyboard-brightness source
metadata is serialized with provider snapshots as well: a refresh must not replace
a just-received source with its older copy.

Hyalo applies the effect only in a real active session, never in a nested
compositor. It disables internal panels only when a connected enabled external
exists. DPMS is independent: inactivity may power every configured output off,
without restoring the closed panel or changing the layout. The remaining external
positions retain their relative arrangement and are translated to the origin.
Only a graph disconnected by removing the internal panel is compacted into a row.
An external primary is chosen. Opening restores the previous layout. Losing the external/topology reconciles a
safe connected configuration; losing the Power1 bus owner withdraws the effect.
The temporary panel state is never persisted. Docked reflects connected external
outputs, including disabled ones, so panel inhibition cannot feed back into Docked.
No new logind listener or suspend action is introduced.

An external explicitly disabled by the user is kept disabled: lid closure does
not implicitly enable it. With no enabled external, Display1 leaves the internal
configuration alone and Power1/logind retain their existing lid/suspend policy.
That can leave no visible screen with the physical lid closed; automatically
using a disabled external would be a separate policy decision, not an implicit
preference override in this cut.

## Evidence and limits

`cargo test --locked --manifest-path hyalo/Cargo.toml -p nidara-hyalo` includes
geometry, profiles, durable file replacement, partial backend failure recovery
and injected-clock activation tests. The existing Power1 tests exercise its fake
system providers on disposable buses.

`scripts/dev/check-display1-headless.sh` starts a private bus and a software-rendered
headless cage containing nested Hyalo with private runtime/config. Set HYALO_BIN to
a development binary. Its real D-Bus client checks revision/owner isolation, last
output protection, disconnect/cancel/timeout recovery, failed durable save, retry,
profile restart, Identify capture and policy authorization. It creates no CI job
and uses no live-session socket. OUT must select a fresh evidence directory.

The headless host exposes one nested output. Multi-output geometry/failure tests
are simulations, not DRM multimonitor, EDID/dock, lid, multi-GPU or installed-package
acceptance. Those require isolated vkms/hardware; do not infer them from compilation,
private-bus success or the Identify screenshot. No hardware or system installation
is performed by the runner.

`scripts/dev/check-mirror-headless.sh` runs the controlled `--mirror-probe` command
on its main thread under a private bus and headless Cage. It starts a real GTK shm
client and uses production scene/GL/capture/input paths with synthetic output modes.
The runner checks fractional source scale, normal/portrait/rotated followers, black
bands, sampled scene pixels, mapped pointer focus, band presses and drag release against a real GTK button (including a positive click).
It saves PNGs/logs under a fresh `target/mirror` evidence directory and has a bounded
runtime. It is a local probe, not a CI job or physical KMS mirror acceptance. Headless
hosting can use the machine's render GPU; no live output or installed session is used.

The mirror runner also builds a disposable Wayland frame client with one outstanding
wl_surface.frame request. One simulated second drives production post-repaint at 60 Hz
source / 144 Hz follower, then 144 Hz / 60 Hz. It waits for each actual client request
before the next opportunity and requires respectively 60 and 144 callbacks, never the
sum. This is deterministic callback routing evidence, not a physical refresh benchmark.
A temporary local control reintroducing follower callback delivery fails with 204
callbacks instead of 60, proving the counter rejects the original duplication.
It saves frame-callbacks.txt. Source-first/DPMS takeover/VT-none election is unit-tested;
physical DPMS takeover and KMS presentation remain separate acceptance. The relative
virtual-pointer motion path is checked to remain inside the source's logical geometry.
