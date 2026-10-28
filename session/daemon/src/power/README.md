# Power1

`nidara-sessiond --power` serves `org.nidara.Power1` and ObjectManager at
`/org/nidara/Power`, on `org.nidara.Session`. The packaged unit starts
`--media --power`. `--power-read-only` publishes diagnostics and rejects mutations;
it produces no holds, hooks, notifications, charge/backlight writes, hardware-key
inhibitors or logind actions. Config1 and Hyalo idle remain independent.

DisplayBrightness1 is also served under --power, sharing this logind session/owner/epoch
and rejecting writes in read-only mode. Its mapping, coalescing, DDC process and Fn
contract is in [brightness/README.md](brightness/README.md). It adds no energy policy.

UPower, power-profiles-daemon 0.30 (`org.freedesktop.UPower.PowerProfiles`) and
logind have independent unique owners and generations. Object paths are daemon
identities, not raw provider paths; retain neither across removal/restart. Install
objects before root references and remove references before interfaces. Property
signals contain changed values and no invalidated names. A failed provider keeps
working capabilities from the others. No battery is normal on a desktop.

Device properties expose percentages in 0..100, seconds, known flags, raw warning
and battery levels, physical battery health and cycles. DisplayDevice is UPower's
aggregate, never a second physical battery. Unknown health/cycles are not healthy
100%/zero cycles. Charge protection is per supported physical battery: call
EnableChargeThreshold, accept UPower's firmware thresholds, and observe readback.
There is no custom slider, sysfs writer, extra polkit rule or global on/off mirror.
Factory behavior never enables protection automatically; an already enabled
firmware state remains authoritative. Provider/polkit can deny a request.

PowerDevice1 includes BluetoothDevicePath, BatteryOwner and DeduplicationState.
Bluetooth1's Snapshot supplies identity: exact NativePath or a unique actual
address, never labels. Linked UPower telemetry remains in Devices but is excluded
from PeripheralDevices and Power1 peripheral notifications. Consumers combining
the services use BatteryOwner to show one row. Ambiguity stays unresolved.

## Battery episodes and profiles

The main battery policy uses low <=20%, rearmed >=25% or AC; critical <=5%, clear
>7% or AC. Unknown source is not AC. WarningLevel is fallback when the percentage
is unavailable; UPower Action is telemetry only. UPower alone owns its critical
2% action. Low is notified once per episode; critical emits BatteryAlert and a
backup urgent notification. The old TS critical island can appear alongside it
until the Rust island exists, an accepted temporary duplicate. Notification
replacement validates the current record and its correlation key before using
an old ID. Peripherals use their warning level, with percentage fallback, and
never trigger the system saver or suspend.

The main battery's `battery-low` hook belongs solely to this daemon. It spawns
`nidara-hook` with fixed argv on a known downward crossing, without fabricating a
startup crossing. The TS observer is removed; other hooks and games are unchanged.

Automatic saver defaults on, using PPD HoldProfile(power-saver). It releases only
its own cookie on AC/disable/loss of policy readiness; never restores a saved
ActiveProfile. SetProfile is a manual override. PPD ProfileReleased invalidates
holds and marks an interrupted automatic episode overridden. Persisted episode
state preserves that choice across daemon/provider restart; missing telemetry
cannot invent another episode. New unplug or a recovered-and-crossed threshold
permits automatic saving again. Writes in flight validate provider/episode/caller
before publishing the returned lease. Calls with uncertain results are not
retried against a replacement provider.

HoldProfile(profile, reason, applicationId) returns a sender-owned PowerProfileHold1
lease. Only advertised power-saver/performance profiles can be held. Release is
owner scoped; caller disappearance releases its holds. External holds are listed
read-only. The legacy TS game command is indistinguishable from a manual profile
change and cancels automatic saving. Its restore can leave power-saver selected
manually, even after AC is attached. Future Rust game code should use holds.

## Preferences and idle

Config1 keys and homes:

| Key | Factory | Home |
| --- | --- | --- |
| power.automatic-saver | true | org.nidara.power |
| power.show-percentage | true | org.nidara.power |
| power.power-button-action | menu | org.nidara.power |
| power.lid-action-on-battery | suspend | org.nidara.power |
| power.lid-action-on-ac | suspend | org.nidara.power |
| power.screen-off-seconds | 300 | Hyalo idle.screen_off |
| power.lock-seconds | 600 | Hyalo idle.lock |
| power.suspend-battery-seconds | 0 | Hyalo idle.suspend_battery |
| power.suspend-ac-seconds | 0 | Hyalo idle.suspend_ac |
| power.dim-before-off-seconds | 10 | Hyalo idle.dim_before_off |

Hyalo alone writes its settings TOML through existing IPC. Config1 reads the
merged effective values, polls external changes on a bounded worker, and reports
an overridden write as a failure. It has no second GSettings copy of idle values.
An obsolete poll cannot replace a newer Apply result. Apply queues its change
before replying so Config1's revision includes it.

Hyalo dims its rendered outputs temporarily before off; it never alters saved
backlight brightness. Any input removes the dim and restores the current render.
Zero disables each step; off <= dim lead time omits dim. An inhibitor release,
source change or changed suspend timeout starts a fresh suspend stretch. Unknown
source disables source-dependent sleep. Only a real --session may suspend;
--winit never starts logind or idle-locks/suspends the host. Lock-before-sleep
continues to use Hyalo's existing confirmed-lock delay inhibitor.

Legacy idle.suspend is normalized to both new fields in each layer before merge,
only where that layer lacks an explicit new field. Existing TS single-timeout
writes therefore still change both; it gains no new UI here.

## Hardware and consumers

PowerButtonPressed, Suspend(interactive), PowerOff(interactive) and LockSession
are explicit methods. Suspend/PowerOff confirm logind acceptance, not that a
physical transition finished. Automatic effects never request interactive polkit.

Power1 takes hardware FDs only for an active local real Hyalo session with the
event route ready. The separate handle-lid-switch FD is taken only for a known
power source whose chosen action is lock/nothing. Suspend (including the factory
default) and unknown source stay with logind: its lid policy retains sleep-block
inhibitor handling, dock detection and holdoff/re-evaluation on undock. Hyalo's power binding
must be locked-capable, bypass shortcut inhibition, have no repeat/release, and
its fixed helper must exist. No evdev grab. The low-level FD inhibits logind's
SOFTWARE long press too; no separate long-press implementation is added. Firmware
hard cutoff is outside this service. On daemon/system-bus/seat/route loss, the FDs
close and logind resumes ITS defaults (possibly poweroff), not our menu preference.

While locked a short press only wakes screens. With preference menu and no
registered consumer, MenuAvailable=false and PowerButtonEffectiveAction=suspend.
No TS menu verb or new shell UI is introduced. A future Rust bar calls
RegisterMenuConsumer(objectPath), receiving a PowerMenuLease1. Delivery calls
org.nidara.PowerMenuConsumer1.Show(requestId) on that sender's unique owner;
acceptance is not presentation. The owner calls lease.MenuShown(requestId) after
showing it. Foreign acknowledgements are PermissionDenied; stale IDs are NotFound.
A failing/timed-out/departed registered consumer produces an error with no
suspend/poweroff fallback and no automatic unregister on timeout. MenuRequested
is informational. Lease.Release and caller loss end registration.

Lid actions are suspend/lock/nothing per known source; suspend is delegated to
logind and follows its system configuration. Opening cancels pending
work. Startup with the lid already closed does nothing. An external enabled
physical output or logind Docked prevents lid suspend; unknown dock status does
not mean undocked. Undocking with the lid closed re-evaluates after logind's
HoldoffTimeoutUSec or 30 seconds, rechecking source/seat/provider/readiness.

Keyboard objects expose raw Brightness/MaxBrightness/Known/LastChangeSource.
Use the legacy primary alias or a unique keyboard, never guess among several.
SetKeyboardBrightness checks bounds, coalesces superseded queued absolute writes,
and confirms observed state. StepPrimaryKeyboardBrightness serializes relative
steps. Firmware internal/external source signals update state without echo writes.
The fixed `nidara-kbd-light up|down` helper serves the Hyalo Fn bindings.

Notifications use `power1.*` keys from all twelve canonical locales. The build
embeds that subset directly from the same TS catalogs; installed settings-data
JSON can override it through `/usr/share/nidara/settings-data/i18n` (or
`NIDARA_I18N_DIR` in development). No separately maintained translation table.
Peripheral notices name the provider model or a translated device type.

Inhibitors are informational, with no termination API. logind ListInhibitors is
a timestamped snapshot (InhibitorsMode), refreshed explicitly and on provider
signals. Counts/masks do not promise every logind version reports live changes.
Hyalo power_info exports shown Wayland idle-inhibit and ScreenSaver metadata;
labels are unauthenticated. They are ineffective under lock, cleaned up on caller
or surface loss. IPC publishes power/lock/config/output/inhibitor changes.

## Verification boundary

Private provider tests exercise identities, typed ObjectManager, observed writes,
permission denial, sender-scoped holds/menu, manual saver override/provider restart,
firmware no-echo and read-only effects. Config1 tests use separate homes and a fake
Hyalo socket. Hyalo clock tests cover source/timeout/input/inhibition resets,
unknown source, dim bounds, nested restrictions and legacy layer normalization.
Tests synchronize through subscription readiness, PropertiesChanged, MenuRequested
and FD EOF; they do not poll for convergence against a runner-speed deadline.
Native builds, these tests and nested rendering do not establish real hardware,
polkit, installed-package or live-session acceptance. No installed service is
restarted by development or tests.
