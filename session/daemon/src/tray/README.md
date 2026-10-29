# Native session tray (Tray1 v1)

`nidara-sessiond --tray` serves `org.nidara.Tray1` on `org.nidara.Session`,
`/org/nidara/Tray`. Without this explicit flag the interface and watchers are
absent. The installed unit and TS shell are untouched. There is no TS bridge,
Rust bar, Settings reader, focus action or popup renderer in this service step
(#959 A). The toolkit popup work is B; the Rust bar/Settings consumer is C.

## Watcher and item lifecycle

Both `org.kde.StatusNotifierWatcher` and
`org.freedesktop.StatusNotifierWatcher` are acquired with DoNotQueue only.
Failure of either releases the other and leaves Tray1 present with
`Available=false` and `UnavailableReason`; other sessiond services continue.
There is no automatic takeover when the competing watcher exits. Restart the
opt-in daemon in its private session when that is intended.
Both watcher interfaces at `/StatusNotifierWatcher` expose the standard methods,
properties and signals over one registry. Items may implement either the KDE
or freedesktop SNI interface. Registration accepts a bus name (default path
`/StatusNotifierItem`) or a path on the caller's unique connection. A registered
bus name must belong to the caller. Host registrations are also checked against
the sender; clients can use Tray1 `RegisterHost()`/`UnregisterHost()` directly.
A watcher alone does not count as a visualization host. Sender disappearance
removes its hosts and menus. Item owner disappearance, or loss of the well-known
name it registered, removes the item and outstanding menu sessions.

Runtime handles are unique-owner + object path, with a separate monotonically
allocated generation. Identical re-registration is idempotent; owner churn gets
a fresh identity and all old calls fail `Stale`. The signal subscription exists
before registration/snapshot. Signals arriving during hydration are bounded and
merged after the initial read; asynchronous property refreshes cannot overwrite
newer inline signals. NewXxx signals invalidate only their property group;
NewStatus and XAyatanaNewLabel carry values directly. PropertiesChanged and its
invalidations are supported. Tooltip text is plain data; the sender's embedded
tooltip pixmap is not retained.

The read-only properties are `Available:b`, `UnavailableReason:s`, `Revision:t`,
`Items:aa{sv}`. `GetSnapshot() -> (t, aa{sv})` reads revision and items under one
lock. Subscribe to `Changed(t revision)` before hydration, reread the snapshot
and track the daemon's unique owner; handles/generations are scoped to that
owner. PropertiesChanged invalidates the cached root properties too.
Each ready item includes Handle, Generation, Owner, ObjectPath, OwnerPid,
PreferenceKey (`tray:<SNI Id>`), MenuAvailable and its bounded SNI metadata:
Id, Title, Status, Category, ItemIsMenu (default false), IconName,
AttentionIconName, OverlayIconName, IconThemePath, XAyatanaLabel,
XAyatanaLabelGuide, Menu and ToolTip (`(sss)` theme icon/title/description).
Status defaults to Active. The original SNI Menu object path is normalized to
a string. Pixmaps never travel in Items or broadcast signals.
IconThemePath is either empty or absolute; sessiond never walks it. The host
resolves theme names with its own bounded cache.

`GetIcon(s handle, t generation, s kind, u requestedSize) -> (u width, u height,
ay rgba)` chooses the nearest suitable pixmap (prefer one at least as large),
for kind normal/attention/overlay; requestedSize is 1..512. It converts tightly
packed network-order ARGB to RGBA. It does not scale or premultiply; the host
paints/scales it. A missing pixmap is NotFound, so the host can use IconName.

`Activate(stii)`, `SecondaryActivate(stii)` and `ContextMenu(stii)` forward real,
signed global logical screen coordinates provided by the host; `Scroll(stis)`
forwards signed delta and horizontal/vertical. No fake `(0,0)` or focus success
is synthesized. Errors are Unavailable, InvalidArgument, NotFound, Stale, Busy,
Timeout or Failed (with underlying D-Bus errors preserved).
The host will handle ItemIsMenu, open a local dbusmenu when available, and call
remote ContextMenu only as a fallback. Left-click window raise belongs to the
Rust host + Hyalo: verified exact PID, then bounded process ancestry, then SNI
Activate when no window matches. Sessiond provides the owner PID from the bus;
it does not use sender titles as proof of process identity or access Hyalo.

## Menus

RegisterHost is required. `OpenMenu(sti handle,generation,parentId=0)` returns
`(s token,u revision,aa{sv} rows)`; `ReadMenu(si token,parentId)` opens a level and
returns `(u revision,aa{sv} rows)`. Tokens belong to the unique sender, item
generation and menu path. `CloseMenu(s token)` retires a session. Closing/unregistering
a host frees its caches. `MenuClosed(s token)` targets the owning host when the
item disappears. Stale tokens cannot cross hosts or survive an owner change.

Every level sends AboutToShow before GetLayout with recursionDepth=1. Rows
include Id:i plus type/label/enabled/visible, icon-name, toggle-type/toggle-state,
children-display, accessible-desc and shortcut when supplied. Defaults follow
dbusmenu: missing enabled/visible mean true, missing type means standard.
Labels and mnemonic underscores remain data for the host to interpret safely.
PNG icon-data is decoded off the async executor and supplied as IconRgba:ay,
IconWidth:u, IconHeight:u; corrupt/oversized images are omitted.

`MenuEvent(s token,u revision,i nodeId,s event,v data,u timestamp)` accepts
clicked/opened/closed, int32-zero reserved data, and the input timestamp supplied
by the host. Clicks on disabled/invisible/separator/stale rows fail. Each read
publishes a new token-wide revision, so the host updates all open levels to that
revision. LayoutUpdated or ItemsPropertiesUpdated invalidates loaded levels,
increments revision and sends directed `MenuChanged(s token,u revision)`.
The host rereads the root and reopens still-valid submenus; removed properties
therefore regain their protocol defaults without retaining stale toggles/actions.
Reads racing a newer revision fail Stale and must be retried. These are cache
publication revisions, not the remote application's GetLayout revision.

Limits: 256 items, 32 per unique owner; 64 registered hosts; eight concurrent
application RPC/refresh/decode workers, no unbounded work queue. Property refresh
requests coalesce by item/field and are debounced 25 ms. RPCs and whole refresh
batches have a two-second deadline. Item strings are at most 4096 UTF-8 bytes.
At most 16 pixmaps/property, each <=512x512 with exact checked byte length;
retained pixmaps <=4 MiB/item and 32 MiB total. Menus: eight tokens/host,
64 total; <=4096 loaded nodes/item across sessions and 16384 globally, depth
<=16; encoded PNG <=1 MiB, <=512x512, decoder allocation <=4 MiB; decoded menu
icons <=16 MiB/item and 32 MiB globally. Concurrent reads recheck budgets before
publication. Replacing a level credits its old subtree before computing room.
At the node cap the returned list ends with a visible disabled `…` row carrying
LimitReached=true and reserved Id=INT32_MIN; it is never an actionable node.
A depth limit is an explicit InvalidArgument. Arbitrary sender paths/data are
not executed or opened by sessiond.

## Future presentation contract and validation boundary

Passive items are omitted by the host (including overflow); Active returns.
NeedsAttention temporarily promotes even a hidden icon, without changing saved
preferences. Always/automatic/hidden control placement. Automatic is the factory
default; existing bar-order and tray-known identities/order remain intact.
For tray keys, bar-hidden will mean hidden in overflow, **not removed entirely**.
The future reader adds tray-always:as to the GSettings schema in the same PR;
this service does not read or write these preferences. The host measures Label
and LabelGuide, uses real screen coordinates and projects accessible controls.

The toolkit menu host must service parent and child events while open, bound
root/submenus to the anchor output's usable workarea, honor confirmed placement
and dimensions, and expose clipping, wheel/keyboard/reveal, scroll indicators,
submenu navigation and AT-SPI. The current nested run_popup suspends its parent;
adding a Scroll alone does not meet this contract. No popup/toolkit acceptance
is claimed by the service test.

`daemon/tests/tray.rs` runs `scripts/ci/sessiond-tray-test.py` using the real
binary, a fake SNI/dbusmenu process and independent host connections on a fresh
private dbus-run-session. No live session/system bus, installed service restart,
XEmbed/xembedsniproxy, or new CI job/step is involved. Unit tests cover bounds,
UTF-8, icon wire format and metadata. Private-bus tests cover watcher collisions,
hosts, aliases, both SNI interfaces, churn, property invalidation, signed actions,
timeouts, PNGs, a 1000-row menu, submenus, revisions and the visible node limit.
These checks establish the service contract; they do not establish visible bar,
menu scrolling/focus/Orca, installed-package or live-compositor acceptance.
