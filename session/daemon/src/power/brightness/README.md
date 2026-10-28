# DisplayBrightness1

`nidara-sessiond --power` also serves `org.nidara.DisplayBrightness1` at
`/org/nidara/DisplayBrightness` on `org.nidara.Session`. Power1 remains the only
energy policy owner. Brightness shares its system connection, logind unique owner,
provider epoch, resolved local session path and active-state authority. It adds no
seat listener, inhibitor, suspension action, software dimming or keyboard-backlight
backend. `--power-read-only` exposes observation but refuses every brightness write.
There is no startup write. The existing TS CC still uses brightnessctl; no bridge
or new OSD is included. Native Settings/Super+P remain a separate cut.

## Wire contract

Records use the Rust types in `model.rs`; introspection supplies D-Bus signatures.
Methods returning records expose their fields as output arguments, like Display1.

- `GetState() -> Snapshot { generation, revision, devices }`.
- `Changed(generation, revision)`: subscribe before reading; reread the snapshot.
- Device: opaque `id`, connection-scoped `output_id`, `provider` (`logind` or `ddc`),
  raw unsigned `min`, `max`, `current`, `available`, `writable`, and `epoch`.
- `SetBrightness(device, epoch, raw_value) -> Device`: returns observed state,
  after one write and readback. Reject stale ids/epochs and values outside range.
- `StepBrightness(direction) -> Device`, direction strictly -1 or +1. Prefer an
  enabled controllable internal panel; otherwise select the logical output under
  the pointer. Reject ambiguous/missing/uncontrollable targets. Capture the target
  and epoch before enqueueing; never move a delayed write to another monitor.
- `Refresh() -> revision` requests rediscovery and read-only probes, at most once
  per two seconds. It retires existing device ids; reread after Changed. Probes
  finish asynchronously; accepting Refresh does not mean a channel is ready.

Errors have prefix `org.nidara.DisplayBrightness1.Error`: Unavailable,
NotSupported, Stale, InvalidArgument, PermissionDenied, Superseded, Timeout.
Strings are technical diagnostics, not UI translations. A timeout is uncertainty,
never a reason to retry an action. There are no automatic error notifications.
Unavailable channels expose no writable slider; errors go to the journal and the
requesting caller. Consumers must not present a requested value as an observed one.

One worker per device accepts a single pending latest value. A newer pending
request completes its predecessor as Superseded. Fn and slider/a11y requests share
this queue and a minimum 250 ms between write issues (at most four per second).
Fn accumulates against the pending target, steps by ceil(max / 20), at least one
raw level, and keeps ceil(max / 100), at least one level, as its safe floor.
When no panel request is pending, Fn reads its configured raw brightness directly
instead of using an old UI observation at wake or after firmware changes. An
explicit slider may request raw zero; Fn never turns a panel off. The last
SetBrightness on drag release remains queued and is not discarded. Firmware
backlight changes update observations without an echo write.

## Mapping and provider I/O

Hyalo adds `Display1.GetHardwareState()`, without changing GetState's existing
wire records. Its independent snapshot has epoch/revision and output records:
id, identity, connector, canonical GPU port, EDID fingerprint, internal/enabled,
logical flag and logical geometry. It uses connector-event discovery already
cached by the compositor; no sysfs brightness or DDC I/O runs on calloop. The
shared `hyalo/compositor/src/display/hardware.rs` defines this additive wire model.
Mirror followers are physical records with logical=false; pointer selection cannot
accidentally select an overlapping follower.

Sessiond matches the exact canonical GPU port and EDID to a connected sysfs DRM
connector. Empty EDID, duplicate ports/channels, multiple backlights without a
unique association and unsupported platform backlights remain unavailable. It
does not guess by model, serial, enumeration order or “the only global backlight”.
Internal association requires the backlight below the connector, or its GPU with
exactly one internal output and one backlight. Writes use the already resolved
logind Session.SetBrightness("backlight", name, raw). Readback uses actual_brightness
when available; panel observations are polled once per second, without writes.

For an external output, use only its sysfs `ddc` I2C link and an accessible read/write
`/dev/i2c-N`. Opening checks permission but sends no transaction. A successful VCP
0x10 continuous read establishes the range before publishing availability. There is
no broad `ddcutil detect` scan. Commands have fixed arguments, decimal bus/value and
VCP 10, C locale, no shell or persistence command:

- `ddcutil --bus N --terse getvcp 10`.
- `ddcutil --bus N --noverify setvcp 10 VALUE`, followed by our explicit getvcp.

A child has a two-second deadline, bounded stdout/stderr, cancellation and kill/reap.
Each worker I/O attempt has a five-second deadline; a pending call may also wait
for the previous bounded attempt and the rate gate. Caller timeout is uncertainty,
not proof that no write happened. A per-channel lock and last-write timestamp survive output
retirement while I/O is in flight and across the 250 ms rate window. New device ids
cannot reset the limiter or overlap replacement discovery.
There are at most two simultaneous discovery probes; failed probes are cached until
a new identity/session epoch or explicit rate-limited Refresh. There is no idle DDC
polling, blind retry or VCP profile save. Repeated unrelated Power1 refreshes do
not query Display1: only a changed shared session authority triggers that refresh;
Display1 topology/owner signals handle its own changes. DDC timeouts, permission failures and bad
readback withdraw the capability. Exact identity/connection/session checks run before
and after I/O; loss cancels pending work. An already issued hardware transaction
cannot be physically retracted, and never reports success after detected loss.
Render/session mocks do not establish real dock or I2C behavior.

The Arch `ddcutil` package is a runtime dependency. Its official 3.0.2-1 file list
includes `60-ddcutil-i2c.rules` and `modules-load.d/ddcutil.conf`; reuse both, with no
local all-I2C permission rule or duplicate module-load file:
https://archlinux.org/packages/extra/x86_64/ddcutil/files/
The CLI terse format and verification behavior are documented upstream:
https://www.ddcutil.com/command_getvcp/ and https://www.ddcutil.com/command_setvcp/ .
The developer installer copies the same helper with executable permissions; its
dependencies already derive from the PKGBUILD. Nothing is installed or loaded by
development tests.

## Fn routing and evidence

Factory Hyalo bindings invoke `nidara-display-brightness up|down`, including while
locked. It calls StepBrightness; it uses brightnessctl only after ServiceUnknown
and a separate confirmation that org.nidara.Session has no owner. Permission,
timeout, NoReply, NameHasNoOwner and missing interfaces never cause fallback.
Superseded is a normal coalescing result. No optimistic brightness OSD is added.

The existing sessiond unit suite contains pure range/parser/association checks,
private-bus logind and compositor fixtures, fake DDC executables, real process
cancellation/reaping/deadlines/output bounds, coalescing/rate/readback, firmware
no-echo, lost session/provider/output, ambiguous association and helper fallback
checks. Fixtures use explicit constructor paths, never production environment
redirects. They create disposable files under target/ and no hardware/system write.
The existing nested Display1 runner also checks the additive mapping transport and
that nested outputs do not invent physical ports. No CI job/configuration is added.
Real backlight permission/readback, DDC/EDID, USB-C/docks and installed Fn acceptance
remain separate hardware checks requiring authorization for live-session changes.
