# Display1: compositor-owned output configuration

`org.nidara.Display` on the session bus, object `/org/nidara/Display`, interface
`org.nidara.Display1`, is implemented by Hyalo. The Rust wire records are in
`compositor/src/display/model.rs`; introspection is the wire signature source.
Methods returning records expose their fields as D-Bus output arguments. Clients
must subscribe to `Changed(epoch, revision)` before reading `GetState` and reread
the whole snapshot. Signals may coalesce intermediate revisions.

This is the first Displays cut of #959. It implements extended layouts, output
configuration, primary publication, transactions, profiles, Identify and the
Power1 lid effect. Mirror groups are reserved and **rejected**. Mirroring,
DisplayBrightness1/DDC/Fn, the native Settings page and Super+P are later cuts.
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
and `mirror_groups` (empty in this cut). Per-output settings are id, enabled,
mode, scale, transform, x, y and VRR (`off`, `on`, `games`). Coordinates are logical
pixels after transform and scale. The validator rejects unknown modes/ids,
nonfinite/out-of-range scales, unsupported VRR, excessive coordinates, overlaps,
disconnected arrangements and disabling the last output. Contact needs a shared
edge of positive length: corners alone do not connect. Different heights need
not fill the bounding rectangle. The compositor does not silently move a user's
invalid layout; a future UI can snap edges before calling Validate.

- `GetState()` reads a coherent snapshot.
- `Validate(epoch, revision, layout)` checks and sorts a layout without effects.
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

## Confirmation and recovery

D-Bus methods send typed commands to calloop. No D-Bus method mutates the scene
from its worker. The disk worker owns durable profile I/O. Discovery reads EDID
at connector events, not on every frame. A transaction prepares all target
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
deadline armed (if already expired, the next recovery tick reverts it). The worker
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
external. Reliable physical DPI chooses a supported quarter-step scale; unknown
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
refresh sends the sequenced lid effect, including false when state is unknown or
the session is inactive. Hyalo applies it only in a real active session, never in
a nested compositor. It disables internal panels only when an enabled powered
external exists, compacts the remaining desktop and chooses an external primary.
Opening restores the previous layout. Losing the external/topology reconciles a
safe connected configuration; losing the Power1 bus owner withdraws the effect.
The temporary panel state is never persisted. Docked reflects connected external
outputs, including disabled ones, so panel inhibition cannot feed back into Docked.
No new logind listener or suspend action is introduced.

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
