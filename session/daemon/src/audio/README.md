# Native session audio

`nidara-sessiond --audio`, built with `--features audio-native`, serves
`org.nidara.Audio1` at `/org/nidara/Audio` on `org.nidara.Session`. The normal daemon
remains opt-in, alongside `--config`. The TypeScript shell is unchanged. A build
without the native feature keeps the root interface available with `Unavailable`
and an explicit build error; it never pretends an empty graph is working audio.

The backend is Rust using libwireplumber 0.5 (a confined ABI boundary on a GLib
thread) and pipewire-rs for PCM streams. It explicitly selects the mixer plugin's
**cubic enum**, not an integer GValue. Metadata uses `WpGlobalProxy` properties:
`WpMetadata` does not implement `WpPipewireObject`. Neither API mistake is caught
by compiling. Never install WirePlumber's process-wide GLib log writer.
The negotiated channel count is decoded from SPA pods in Rust: calling
AudioInfoRaw::parse introduced a generated-C-wrapper linker failure in the
optimized package build, even though the development build passed.

## Client contract

The root implements ObjectManager. Subscribe before `GetManagedObjects`, apply
updates in bus order, and discard all proxies on bus name-owner change. Object
paths include a provider generation and PipeWire serial; provider numeric IDs
are never client identity. Root defaults become `/` before removed interfaces
are announced. Additions are installed before root references are published.
PropertiesChanged invalidates changed records; clients fetch current properties.
A disappeared object is a `NotFound`, not a write redirected to its replacement.

| Interface | Properties |
| --- | --- |
| Audio1 | State, LastError, Generation, DefaultOutput, DefaultInput, VolumeLimit, Streams, RecordingStreams, InternalCapture, Capabilities, DefaultSwitchMode |
| AudioNode1 | Kind, Serial, Name, Description, MediaName, ApplicationId, ApplicationName, IconName, Device, Volume, Muted, Channels `a(sd)`, Balance, Capabilities, State, Targets, RequestedTarget, CaptureKind, Routes, ActiveRoute |
| AudioDevice1 | Name, Description, Profiles, ActiveProfile, Capabilities |
| AudioProfile1 | Index, Name, Description, Availability, Priority |
| AudioRoute1 | Index, DeviceIndex, Direction, Name, Description, Availability, Profiles, Active |

Root methods: `SetVolume(o,d)`, `SetMuted(o,b)`, `SetBalance(o,d)`, `SetDefault(o)`,
`ClearDefault(s)` (`input` or `output`), `MovePlayback(o,o)`, `FollowDefault(o)`,
`SetProfile(o)`, `SetRoute(o,o)`, `SubscribePeak(o,u) -> o`,
`TestChannel(o,s) -> o`, `PlayAlert(s) -> o`, `PlayVolumeFeedback(o) -> o`.

Volume 1.0 means 100%, using the same scale as wpctl. Scalar writes preserve
channel ratios; a zero vector recovers equal gains. Balance attenuates left/right
in **linear amplitude** (cube/cube-root at the UI boundary), keeping center/LFE and the front/rear ratios within each side.
Mono and ambiguous channel maps do not claim balance support. Unsupported data
is identified by missing capabilities, rather than presented as a known zero.
External volumes above our write limit remain readable without truncation.

Writes wait for observed backend confirmation, up to 5s for volume/mute/balance,
15s for topology changes. A timeout is uncertainty, not rollback. Volume dragging
uses last-wins per destination; displaced calls get `Error.Superseded` immediately.
Worker sequence numbers also reject out-of-order obsolete requests. An already
sent write cannot be undone; subsequent graph updates remain authoritative.
ClearDefault and policy settings acknowledge acceptance, not a future hardware
outcome. Other errors: Unavailable, NotSupported, InvalidArgument, NotFound,
PermissionDenied, Busy, Timeout, Failed, under `org.nidara.Audio1.Error`.

Profiles/routing enumerate actual SPA EnumProfile/Profile and EnumRoute/Route;
Bluetooth codecs and layouts are never invented. A route is a device route,
including its logical device index, not a PipeWire port. WirePlumber owns
persistence (SPA save) and default/stream restoration. MovePlayback writes
`target.object` on default metadata; Targets reports observed links. FollowDefault
uses WP's `-1` sentinel to mask an immutable app target as well; simply removing
the metadata would restore that explicit app target. A profile
change may replace nodes, requiring clients to enumerate again.

## Preferences and hotplug

Config1 exposes these keys in `org.nidara.audio` GSettings, even without PipeWire:

| Config1 key | Default |
| --- | --- |
| audio.overamplification | false |
| audio.alerts-enabled | true |
| audio.alert-volume | 0.5, cubic 0..1 |
| audio.volume-feedback | false |
| audio.switch-on-connect | true |

Overamplification changes our write limit from 1.0 to 1.5. Disabling it also
clamps currently boosted nodes proportionally; failure is visible, and readings
are never falsified. Other PipeWire clients can still change volume afterward.
These preferences do not duplicate WirePlumber's persisted mixer state.

`config/wireplumber/nidara-audio.lua` is the default-selection policy, shipped
with its **optional** component fragment, weakly pulled in by `policy.standard`
using `wants` (an optional profile entry alone does not load a component). A load failure leaves WirePlumber
running and reports switch-on-connect unsupported. It remains inert without an Audio1 controller.
The controller preference is metadata on the daemon's **own PW client ID**,
withdrawn with the client, not a persistent root toggle. The hook establishes a
baseline on enable, excludes virtual outputs, ignores profile reenumeration,
and chooses only a single unambiguous newly available USB/BT output or headset
route. It leaves linking/fallback to WP and saves the new default through WP.
A matching mic is selected only from the same Device, with one candidate. A2DP
has no matching source. On integrated cards a headset-mic route must have become
available in that same rescan; an internal mic or standalone USB mic never wins
merely because it appeared. An unsupported hook is exposed as
`DefaultSwitchMode=unsupported`; priority-based selection is not falsely reported
as switch-on-connect. Do not reload or edit installed WirePlumber configuration
during development; the runner loads this hook only into its private instance.

**No ducking.** The owner's decision discards it. Role-based WP loopbacks would
be bypassed by an app moved directly to a physical sink, while moving a loopback
would move its whole role group. Alert playback mixes with existing audio.

## Capture, sounds and lifetime

RecordingStreams enumerates external capture streams, including paused streams;
CaptureKind distinguishes microphone/monitor/virtual/unknown. Their metadata is
not authenticated identity or a permissions boundary. Streams created by our
actual PW client handles are excluded from app/recording lists; the registry
includes the server cookie so recycled client IDs after restart cannot collide.
InternalCapture exposes our monitor nodes separately for the privacy indicator.

A peak subscription has Rate, Node, Unsubscribe, `Peak(t,ad)` and `Ended(s)`.
Methods are sender-owned and signals unicast. Rates 1..20Hz; 8 subscriptions per
sender, 32 total, 4 monitored inputs. One native capture stream is shared per
input while subscribed; the last unsubscribe, owner loss, target removal or
provider loss destroys it. Peak values are max absolute **linear** samples since
the previous emission, including clipping >1. RT callbacks only reduce buffers
into fixed atomic storage, never allocate, log, lock or emit D-Bus. Samples are
not retained. Monitoring opens a real microphone and can activate its LED or BT
profile; it is not hidden behind the external-app recording list.

Playback objects implement AudioTestPlayback1 (State, Error, Stop, Finished).
They are sender-owned, unicast on completion and removed at completion. A muted
output fails explicitly. Tests isolate a supported SPA channel without remix,
use a bounded 700ms 440Hz tone and never unmute/change the master. The embedded
fixed catalog (`notification`, `warning`, `error`, `complete`) synthesizes short
soft tones, accepts no filesystem paths/URIs, and uses the configured alert
volume. Feedback is a separate optional fixed click, capped globally to once
per 100ms. Clients request feedback for their gesture; external volume changes
do not trigger it. Playback is bounded per sender, 32 globally; only one channel
test runs globally. Target removal never redirects a test to another output.

## Validation

Existing `cargo test` includes pure gain/balance/identity tests and a private-bus
Audio1 test using a fake backend. It verifies real ObjectManager/property/error
behavior, finite bounds, last-wins before backend acknowledgment, withdrawal and
stale identity. No CI job, step or configuration was added. The dedicated sessiond job
checks the bus/model without native PW headers. The existing Hyalo job also
compiles the native backend through the package build; native clippy and audio
behavior checks are local. Package/development release builds enable the feature. Arch builds need
`clang-libs` for bindgen, in addition to the existing PipeWire/WirePlumber deps.

```
cargo test --manifest-path session/Cargo.toml --locked
cargo clippy --manifest-path session/Cargo.toml --features audio-native -- -D warnings
cargo build --manifest-path session/Cargo.toml --features audio-native
lua scripts/dev/audio-policy-test.lua
NIDARA_AUDIO_POLICY_FAULT=1 /usr/bin/python3 scripts/dev/audio-test.py
/usr/bin/python3 scripts/dev/audio-test.py
```

The real runner creates an exclusive bus/remote and disposable HOME/config/state,
disables every physical WP monitor, loads the shipped hook privately, creates
null sinks and a known virtual source, and cleans up only its processes. Logs
stay under `target/audio-probe`. It checks cubic wpctl parity, proportional
balance, app move/follow, Config1 limits/alert controls, real bounded peaks,
internal capture separation, owner cleanup, isolated test-channel PCM and
provider restart. A short private runtime path avoids the Unix socket 108-byte
limit. No packages are installed and no daily-session socket is used.
The Lua fixture checks actual hook code with fake device/rescan events.
Neither fake events nor null sinks establish USB/BT/jack/HDMI behavior, physical
speaker audibility, LEDs, installed-package or live/nested-session acceptance.
Those hardware/session checks remain explicitly unverified.
