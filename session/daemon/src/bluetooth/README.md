# Bluetooth1

The Bluetooth slice of #959 in `nidara-sessiond`. `--bluetooth` is an explicit Rust
session opt-in. Normal startup does not export/register an agent or change radios.
**Never enable it beside the daily TS shell's agent.** The nested runner accepts
`--bluetooth` (and optionally `--network`), but tests must provide private system and
session buses and fake BlueZ/obexd providers. No installed service is modified.

`--bluetooth-read-only` exports snapshots, refuses writes and UI registration, and
never registers agents, starts discovery or activates obexd. UI registration and
sending may activate the normal session-bus obexd in write mode. BlueZ absence and
OBEX absence are separate capabilities; one does not remove the other's service.

## Session wire contract

Name `org.nidara.Bluetooth`, path `/org/nidara/Bluetooth`, interface
`org.nidara.Bluetooth1`. `Snapshot() -> (t epoch, t revision, s JSON)` and
`Updated(t epoch, t revision, s JSON)` carry complete schemaVersion1 documents.
Subscribe first, pin the unique service owner, then hydrate. Reject stale revisions
and generations; repeat hydration after owner loss. Provider replacement withdraws
requests and clears that provider's old state before a new snapshot is published.
A failed provider read is retried, not treated as a successful empty inventory.

Snapshots include all adapters and device paths, parent adapter, address/type,
name/alias/icon, paired/trusted/blocked/connected, servicesResolved, UUIDs, optional
RSSI and optional Battery1 percentage. Missing battery is null, not zero. Radio,
alias and device writes refresh actual state before returning. Consent device labels strip control and bidi characters, retain the device address
alongside them, and use the same bounded sanitization as filenames. No PIN/passkey is
in snapshots, logs, command arguments or files. Audio profile selection is outside
this service; Device1.Connect is the generic BlueZ operation.

Sensor/inventory polling and full Updated documents are coalesced to at most four
per second, with the latest state winning. Explicit user writes publish immediately;
consent signals bypass that limiter. Inventory, registration/lease control and
transfer monitoring have independent workers, so a stalled BlueZ call does not
stop OBEX disk checks. Consent cleanup survives a dropped caller future; total
incoming authorization is bounded at 55 seconds including metadata and I/O. Terminal OBEX property signals are subscribed
before agent registration and retained: a server can remove its completed transfer
before the next periodic snapshot. They are authenticated by OBEX's unique owner.

| Method | Input | Result |
|---|---|---|
| SetPowered | `o adapter, b powered` | Confirm adapter power |
| SetAdapterAlias | `o adapter, s alias` | Bluetooth alias only; empty resets it, not the system hostname |
| SetBlocked | `o device, b blocked` | Block/unblock |
| Pair | `o device` | Await pairing, then trust; incomplete trust is explicit |
| CancelPairing | `o device` | Cancel while Pair is pending |
| Connect / Disconnect | `o device` | Await BlueZ's generic operation |
| Forget | `o device` | Remove on that device's adapter |
| HoldDiscovery / HoldDiscoverable | `o adapter` | `t lease` belonging to the caller's unique name |
| ReleaseDiscovery / ReleaseDiscoverable | `t lease` | Only its owning caller/kind may release it |
| RegisterUi / UnregisterUi | none | One renderer slot, owned by its unique sender |
| ReplyRequest | `t epoch, t id, b accept, s value` | Only the registered UI; typed reply for that request |
| CancelRequest | `t epoch, t id` | Withdraw consent; cancel display-only pairing at BlueZ too |
| SendFile | `o device, s absolutePath` | `t id`; starts a transfer, not proof it finished |
| CancelTransfer | `t epoch, t id` | Cancel this service's transfer; never adopt a foreign session |

Errors are Unavailable, Denied, Invalid, NotFound, Busy, Conflict, Cancelled,
TimedOut, Incomplete, NoSpace and Failed. Remote error text is not logged. Device
operations serialize per device; cancellation and consent never wait behind a
Pair/Connect that needs their callbacks. Pair can leave a real paired device with
Incomplete if setting Trusted fails; it never deletes pairing to hide that outcome.

## Leases and pairing

Discovery refcounts frontend clients into only our own BlueZ discovery session;
stopping ours does not stop another application's discovery. Lost frontend names
release their leases. Visibility we enabled uses a nonzero 180-second BlueZ timer,
refreshed every 60 seconds only while leases survive. The final lease disables it.
A crash therefore cannot leave visibility we enabled indefinite. Preexisting external
visibility is observed and preserved, including an external timeout of zero.

BlueZ registers `/org/nidara/Session/BluetoothAgent` with KeyboardDisplay. OBEX uses
`/org/nidara/Session/ObexAgent`. These differ from the TS path. Every callback checks
the current unique provider on the correct bus. A rejected OBEX registration means
reception unavailable; we never unregister somebody else's agent.

`Request(t epoch, t id, s JSON)`, `RequestUpdated(t,t,s JSON)` and
`RequestClosed(t,t,s reason)` are **unicast** to the renderer. There is one pending
dialogue. A concurrent new interaction is refused rather than queued indefinitely.
DisplayPasskey updates `entered` in that dialogue and does not reset its deadline.
PIN is 1–16 non-control characters; passkey is strictly numeric 0–999999, displayed
with six digits. Pairing has a 120-second service deadline or BlueZ's earlier one.
Cancel/Release, device/provider loss, renderer loss and deadlines withdraw requests;
stale sender/epoch/ID replies cannot answer another question. The registration slot
prevents accidental competing renderers, not malicious programs of the same user.

AuthorizeService rejects OBEX FTP (1106) even for paired/trusted peers when BlueZ
asks: a deliberate exception because FTP has no per-file consent. Other service
requests auto-authorize a paired or trusted peer, as the agreed TS policy;
RequestAuthorization auto-authorizes a trusted peer. **Neither rule authorizes file
reception.** Every incoming file needs a separate explicit consent. Outgoing active
transfers do not occupy the dialogue slot.

## Files and disk policy

Only Object Push is used, not FTP browsing, PBAP or automatic file opening. Incoming
metadata is read from the authenticated Transfer1 and Session1, rechecked after the
answer, and presented as device/address, safe filename and optional size. Unknown
size is null and must be shown as unknown. No renderer, Busy, rejection, lost owner,
lost renderer or an unanswered **45-second** deadline rejects the push; no path is
returned for accepting data before the user says yes. Upstream obexd's own agent
deadline is 60 seconds, so the service answers before that.

**Deployment preconditions:** incoming service is **OPP only**, with no FTP/PCSuite
or other non-OPP file server enabled. obexd must run without `--auto-accept`, which
bypasses AuthorizePush entirely, and its Root must be writable, user-owned and
persistent. BlueZ's adapter.c process_auth_queue bypasses Agent1 for Trusted devices,
so our explicit FTP refusal is only additional defense, not enforcement of daemon
plugins. Snapshot fileReceptionPolicy reports observed local FTP/PCSuite/SyncEvolution
service UUIDs as unsupported-server-advertised. Adapter1.UUIDs cannot identify which
application registered a profile; absence stays unverified and never certifies an
OPP-only daemon or proves that auto-accept is off.

Upstream PCSuite delegates file operations to FTP and creates backup files;
SyncEvolution receives PUT data through its backend. MAS has message/status
operations; PBAP and IrMC reject PUT but expose address-book reads. All are outside
this slice. The desktop package depends on bluez-obex and installs
`/usr/lib/systemd/user/obex.service.d/50-nidara-opp-only.conf`, resetting ExecStart
to `/usr/lib/bluetooth/obexd -p bluetooth,filesystem,opp`. Removing this allowlist
breaks the per-file consent guarantee; excluding individual known plugins is not
a future-proof replacement. This source change does not install or activate it
in an existing session.
Without `-r`, upstream `main.c` selects `$XDG_CACHE_HOME/obexd` (normally
`~/.cache/obexd`) and creates it with mode 0700. The expected deployment keeps this
on disk, as well as the configured Downloads directory. `statfs` refuses tmpfs,
ramfs and hugetlbfs for staging/root and Downloads; there is no silent RAM fallback.
A RAM-backed Root produces an explicit `persistent-root-required` transfer error in
Snapshot. The service never changes an installed daemon's flags, Root or units.

Staging stays in a freshly-created private 0700 directory within obexd's Root; the
payload is 0600. This is necessary because upstream filesystem_open/verify_path
restrict accepted paths to Root unless the daemon enables symlinks. Returning an
arbitrary Downloads path outside Root is not a portable workaround. Another agent
or an auto-accept daemon can bypass this backend's consent policy; registration and
these preconditions are part of the deployment, not proof about an arbitrary daemon.

The free-space floor is **256 MiB**, checked on both staging and destination volumes.
A known size is checked before prompting, without creating Downloads or staging;
capacity is checked again after consent. Size plus the floor and outstanding known
reservations must fit, using
checked arithmetic. Unknown-size transfers are allowed, but the monitor checks both
volumes every 250 ms and calls Transfer1.Cancel if below the floor or capacity cannot
be read. Cancel failure remains `cancel-pending` with an explicit incomplete error
and is retried; it is never announced as a successful stop. Other processes can
consume space independently; the service does not claim a filesystem quota.

On complete, same-filesystem publication uses renameat2(RENAME_NOREPLACE). A different
filesystem uses a bounded copy to private staging in Downloads, checking space per
chunk, then the same exclusive publication. Sanitization removes separators, '..',
control/bidi characters and excessive byte length. Empty names become `bluetooth-file`; collision suffixes precede the last extension.
Existing files and symlinks cause a suffix, including concurrent collisions; they
are never overwritten. XDG_DOWNLOAD_DIR comes from GLib's user directory setting;
if absent, the fallback is `~/Downloads`, never a hardcoded localized name.

Only after publication does Snapshot report `status=received` and `publishedName`;
`finalizing` covers local publication. The future shell can notify from that state.
A failed publication reports error, not received. Finalizing an incoming file is
Busy for cancellation; network completion has already happened. Progress and cancel
for sending use Transfer1; cancellation removes only our own outgoing session, with
cleanup retry. Files are never executed or opened automatically.

History is bounded in memory. A complete network payload already in local
finalization may finish publication after provider loss; it retains its explicit
consent. Network-active transfers from a lost OBEX owner are invalidated. Cancellation/error/provider loss removes only our
tracked partial files. A process crash may leave private orphan staging, which is
never promoted automatically; there is no persistent consent journal. Read-only
startup does no file cleanup. No remote filename selects a directory or an existing
destination, and no local scan deletes another agent's files.

## Validation

`cargo test --manifest-path session/Cargo.toml --locked` invokes the existing-job
Python/Gio test with fake BlueZ on one private bus and fake obexd on another. HOME,
XDG state and Downloads are temporary. The full run includes the real 45-second
incoming deadline. `BLUETOOTH_TEST_QUICK=1` is only a test-harness option for repeating
other scenarios with explicit cancellation; it does not alter service deadlines.
The nested repeat likewise cancels instead of waiting the same deadline again.

A private-bus Rust test injects fake free space and verifies a Cancel call and
exclusive removal of our own partial for both known and unknown sizes. A tiny
cross-filesystem fixture tests the publication primitive via `/dev/shm`; it bypasses
only the test fixture's admission construction, never production's RAM guard.
The integration itself verifies RAM Root rejection and an empty staging directory.
No test fills a disk or writes to real BlueZ/obexd. No new CI job or step is added.

Primary references: [BlueZ agent](https://bluez.readthedocs.io/en/latest/agent-api/),
[adapter](https://bluez.readthedocs.io/en/latest/adapter-api/),
[device](https://bluez.readthedocs.io/en/latest/device-api/),
[OBEX](https://bluez.readthedocs.io/en/latest/obex-api/),
[OBEX agent](https://bluez.readthedocs.io/en/latest/obex-agent-api/), and upstream
[obexd main.c](https://github.com/bluez/bluez/blob/master/obexd/src/main.c),
[filesystem.c](https://github.com/bluez/bluez/blob/master/obexd/plugins/filesystem.c),
[OPP](https://github.com/bluez/bluez/blob/master/obexd/plugins/opp.c).

Related upstream: [authorization queue](https://github.com/bluez/bluez/blob/master/src/adapter.c),
[FTP](https://github.com/bluez/bluez/blob/master/obexd/plugins/ftp.c),
[PCSuite](https://github.com/bluez/bluez/blob/master/obexd/plugins/pcsuite.c),
[plugin filtering](https://github.com/bluez/bluez/blob/master/obexd/src/plugin.c).

Arch package inspection: bluez-obex5.87-2 supplies `/usr/lib/bluetooth/obexd`,
`/usr/lib/systemd/user/obex.service` and its dbus-org.bluez.obex.service alias. The
D-Bus descriptor names the systemd alias, but its direct Exec fallback does not
inherit systemd drop-ins. Unmanaged/private-bus launches must satisfy the same
plugin precondition explicitly. The packaged drop-in covers systemd activation; it cannot enforce arbitrary
direct launches or user overrides.

The extracted Arch binary was checked in a rootless, networkless container against
a private fake ProfileManager. Its default registered FTP and PCSuite; the allowlist
removed them. It retained OPP1105 and PCE112e (Phone Book Access Client in BlueZ's
profile defaults), so the proof does not claim only one UUID is registered. The
Role option was absent. `--system-bus` was used only in this package test to avoid
requiring logind inside the container, not as proposed deployment configuration.
