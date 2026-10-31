# Applications1 A1/A2

`nidara-sessiond --applications` serves `org.nidara.Applications1` on
`org.nidara.Applications`, `/org/nidara/Applications`. It is explicitly opt-in;
the normal installed daemon, TS shell and systemd units are unchanged. The
private Rust-session runner accepts `--applications`. A competing owner is
neither replaced nor queued behind; restart the opt-in daemon when appropriate.

A1 of [the contract](../../../design/APPLICATIONS1-DOCK.md) supplies catalogue,
search, app icon rendering/overrides and typed pin/folder layout. A2 adds
launch/actions/open/default directories and typed XDG autostart preferences;
read [A2.md](A2.md) before using or extending those effects. Launchable now
reflects entry availability, with request/provider failures still explicit.
There is no usage/new-app tracker, Unity listener, window watcher, dock or TS
bridge. ResolveWindow and AcknowledgeNew remain Unavailable before H1/A3.
`LauncherAvailable` refers to Unity, not app launching: use `LaunchAvailable`
and the `launch` capability; neither implies observed window/focus success.

## Data and lifecycle

The GLib worker owns GSettings and directory monitors. It reads bounded desktop
files and passes an already bounded GKeyFile to GIO's desktop parser; it does
not reopen the filename through the parser. IDs preserve case and use the XDG
relative-directory-to-hyphen rule. Higher-priority Hidden entries mask lower
entries. NoDisplay and desktop filtering affect visibility, not retained app
metadata. TryExec failure retains the ID as unavailable/hidden: a missing binary
is not proof that its still-present desktop entry was uninstalled. Name/GenericName/Comment/
Keywords and action names use the process locale. Exec is used only for its
parsed executable basename in search, never for arbitrary argument matching.
No child is started by the catalogue or a search.

XDG_DATA_HOME and XDG_DATA_DIRS are authoritative; when the latter is unset,
standard user/system, Flatpak and Snap export locations are included when
present or previously observed. Explicit XDG_DATA_DIRS enables fully private
profiles without traversing host exports. Watch the nearest existing ancestor
for missing roots, all scanned directories, and atomic changes. Changes coalesce
for 100 ms on the blocking GLib MainLoop. The bounded async job receiver wakes
that context on demand and yields before each effect to service consent changes.
A healthy, fully monitored catalogue has no periodic rescan or 5 ms loop. Failed
scans/monitor installation use recovery backoff from 1 to 60 seconds; jobs do not
reset its deadline. Recursive bounded icon watches and resolved asset parents
cover artwork changes, including non-selected sizes. Icon traversal is bounded
to 4096 directories/65536 entries/16 levels; combined installed directory watches
are capped at 8192, with the same recovery backoff if coverage is incomplete. AppInfo/volume notifications
cover default-handler/mount changes. A scan failure/degraded root preserves the previous complete
in-process catalogue. Initial partial metadata is labelled incomplete. There is
no empty-success claim or pruning on failed/partial/unmounted roots.

A bounded, atomically replaced 0600 root-history map at
`$XDG_STATE_HOME/nidara/applications-roots-v1.json` records previously observed
roots and their mount provenance. Mount disappearance/change, unreadable history
or a known root disappearing stays degraded across daemon restart; root recovery
on its prior mount restores normal scanning. This map stores no privilege.
Genuinely changing the catalogue's mount configuration requires reviewing that
profile's history rather than treating a different filesystem as uninstall.

GetSnapshot returns `(t epoch, t revision, a{sv} state)`. State includes independent
CatalogueRevision/LayoutRevision, zero UsageRevision/LauncherRevision, IconRevision,
CatalogueComplete/Diagnostics, Apps, AppsNext, ordered Layout, LayoutAvailable,
DefaultDirectoryApp, ActiveLaunches and explicitly unavailable window matching.
Subscribe to Changed and owner changes before reading. PropertiesChanged
invalidates root property caches as well. A daemon restart gives a new epoch;
changed/recreated desktop entries receive new monotonic generations within it.

Apps pages are at most 256 records and conservatively capped at 512 KiB.
ReadSnapshotPage(epoch,token) returns immutable records plus the next token;
repeating a page read is idempotent. Tokens belong to the unique sender, epoch,
retained snapshot and cursor. Closing any token frees that snapshot; sender loss
frees pages and peer credentials. Expiry is 10 seconds, retention at most 16
sessions per sender/256 global with a conservative 32 MiB allocation budget.
Expired/foreign/out-of-range tokens fail Stale. No mutation is retried. Work is
bounded to 64 in-flight calls per sender, 256 globally and a 256-job GLib queue;
timed-out queued work is discarded before its effect. GLib notifications are
serviced before each job, so a stream of reads cannot starve consent updates.

Catalogue bounds: 64 roots, 16 directory levels, 4096 monitored directories,
65536 directory entries, 16384 desktop IDs, 256 KiB input per desktop file,
64 desktop actions, 32 KiB per metadata record and 32 MiB total serialized
metadata. Rejected limits/entries produce incomplete diagnostics and prohibit
pruning. Metadata has no Exec argv, activation token or image payloads.

Search uses the existing TS field weights (name1, id0.85, executable0.78,
keyword0.65) and exact/prefix/word-prefix/substring/acronym/rescue tiers. IDs
exclude substring matches; executable/keywords exclude acronym matches. It
accent-folds, limits one-character loose matching, defaults to visible apps,
accepts an explicit hidden diagnostic mode, uses localized collation and exact
ID tie-breaks. Empty query gives visible alphabetical results. There is no
launch-count ranking masquerading as foreground usage; A3 adds that metric.

## Typed layout and policy

Native layout uses **separate** `org.nidara.dock layout:as` and
`layout-version:u` keys, unseen by the TS dock. Rust only reads legacy `pinned`
once at version0 and never writes it; later TS writes cannot replace native
order. Sharing `pinned` would let the TS orphan-pruner erase typed tokens.
Version0 imports known legacy prefixes once, preserves
case/order, prepends the movable dynamic default-directory target and includes
Apps only when its real entry ships. Version1 accepts `app:<DesktopId>`,
`default-handler:inode/directory` and `folder:<absolute-local-file-URI>`.
An intentional version1 empty layout stays empty. Future versions are read-only;
missing native schema removes layout capabilities. Layout has at most256 entries,
8 KiB per token and128 KiB total text. Both keys commit in one GSettings batch,
with readback; failed writes revert pending backend changes.

EditLayout(epoch,expectedLayoutRevision,edit) edits stable keys using insert-app,
insert-folder, move or remove. Unknown keys/types and duplicates fail before a
write. Inserts without BeforeKey append; already pinned targets are no-ops.
CAS conflicts never replace another client's layout. All callers, including
external writers of the native keys, feed the same validated native state. Only after a
complete healthy catalogue proves an app ID absent is its pin pruned (including
migrated pins); folders and unresolved dynamic defaults are not uninstalled apps.
Every actual layout change advances LayoutRevision; unrelated icon changes do not.

D-Bus mutations authenticate the unique sender's real PID/UID, cache only pinned
Peer handles and revalidate executable identity/grants and current consent at
the effect. Claiming SettingsNative or invoking an interpreter grants nothing.
New shared operations are EditPins and AppIcon: native Shell/Settings may use
both; the narrow installed `/usr/bin/nidara-apps` Launcher role may only EditPins.
External callers need computer-control AND config-write. Launcher does not gain
window control, capture, close, arbitrary config or spawn. Session/LegacySettings
also gain none of these operations. No development grants are installed here;
the Launcher path becomes active only when D4 ships that native executable;
actual future launcher dev registration must be explicit. The original A policy
for Hyalo/Config1 remains unchanged. This is cooperative same-UID consent, not a
sandbox against a program that can already edit its own GSettings/files.

## Full-colour application icons

A portal Settings ReadOne of org.gnome.desktop.interface/icon-theme selects the
app theme; the service never activates a portal or reads Config1 for paint.
Absent portal/theme uses hicolor/fallbacks. Subscribe to owner/SettingChanged
before the initial read, bound ReadOne to one second, and accept changes only
from the current unique owner. Owner loss clears the theme; a returning owner
gets one new read. No portal polling or activation. Theme index directories,
size/scale and Inherits are bounded; then hicolor/pixmaps and absolute app icons.
Nidara raw-icon overlays take precedence, with their original basename convention
for path icons; dot-separated themed names retain their full key. Chrome-PWA
casing and the bounded Steam librarycache icon fallback are preserved.

GetIcon(epoch,id,generation,size,scale) decodes/rasterizes off the bus/GLib
worker, with at most eight concurrent workers. Inputs16..512 logical pixels,
scale1..4, physical side capped1024. Source16 MiB, decoded source16 megapixels,
output4 MiB. SVG goes through full-colour resvg with system fonts (including
text), raster formats through the bounded image decoder. Embedded raster data
has a combined 64 MiB decoded budget per SVG; rejected resources and inkless SVGs
fall back explicitly. No external SVG file or URL resource is fetched. Output is square, aspect-preserved straight-alpha
RGBA, not premultiplied GTK icon shapes. Missing/corrupt assets use the bundled
versioned generic app artwork; tokens start `asset:` or `fallback-v1:` and hash
the rendered pixels/size/scale/revision, so changed pixels cannot reuse a token.
There is no service pixel cache; consumers can cache tokens with their own
bounded LRU. Asset metadata changes and explicit override/theme updates publish
icon invalidations. App Generation versions desktop metadata; IconRevision
versions artwork/override output without confusing layout CAS.

SetIconOverride accepts exactly Kind=file (local URI) or theme and Value. It
checks permission before reading, decodes a bounded source, then rechecks
permission/generation before committing normalized PNG. Destinations are hashed
app IDs under `$XDG_DATA_HOME/icons/nidara/per-app`; callers supply no destination.
Reject symlinked override parents, use exclusive temporary creation, fsync and
atomic rename. Reset removes only that app's own override and is idempotent;
a legacy shared raw-key override can become visible again. Legacy shared files
are read, never silently removed by a per-app reset.

## Validation and boundary

```
cargo test --manifest-path session/Cargo.toml -p nidara-sessiond --test applications --locked
cargo test --manifest-path session/Cargo.toml -p nidara-sessiond --bin nidara-sessiond --locked
cargo test --manifest-path crates/nidara-access/Cargo.toml
cargo clippy --manifest-path session/Cargo.toml -p nidara-sessiond --all-targets --locked -- -D warnings
```

The integration fixture (`scripts/dev/applications1-check.py`) uses a bus with
no service autoactivation, local GIO, private XDG roots/settings, no system bus,
and >300 fake desktop entries. It covers opt-in/conflicting owner, immutable
caller-bound pages, generations/search, layout/CAS/consent, actual root loss and
restart, healthy uninstall pruning, RGBA/SVG text/overrides and revocation.
It also checks TS/native key isolation, intentional empty layout after restart,
and portal initial read/signals/owner restart/spoof rejection.
Logs remain in target/applications1; only short-lived runtime sockets use /tmp.
No system installer, /etc grant, daily session, physical monitor, visual dock or
Orca validation is claimed. New tests run in the existing session workspace;
no CI job, workflow or CI script is added or changed.

The opt-in flag was also exercised through `scripts/dev/rust-session.sh` inside
a real private Hyalo window on headless cage: service snapshot, typed schema
availability, and compositor identity were verified on the nested bus/socket.
This is service/transport acceptance, not visible dock or hardware acceptance.

Idle measurement uses the same private catalogue and no client traffic:
`/usr/bin/python3 scripts/dev/applications1-check.py --idle <release-binary> 60`.
It records process CPU ticks and per-surviving-thread context-switch deltas from `/proc`
in `idle.json` (one-core CPU percent; started/exited thread counts are separate,
and context switches are not hardware wakeups).
No pidstat package is installed by this workflow.

The initial >300-entry private idle sample used release A1 before the event-loop
change: 0.59 CPU seconds/60.001 s (0.98% of one core), with about 12000 aggregate
thread context switches. After the event-loop change, a 60.001 s private sample
recorded 0 CPU ticks (0.00% at `/proc` tick resolution), 0 context-switch deltas in
surviving threads and 1 exited thread. CPU counters are process-wide; the old
aggregate context-switch subtraction can undercount exiting threads, so its
switch count is only approximate. These are idle service measurements, not
battery/hardware acceptance. Raw samples: `target/applications1/1793384108318425486`
(before) and `target/applications1/1793384657918390847` (final after).
The final sample's idle.json records the release binary SHA-256. The initial
fixture had over 300 entries; the expanded final fixture also includes portal
theme assets and symlink/cycle coverage. Neither interval sends client traffic
or starts a portal. The after sample includes the final asset/watch fixes.
