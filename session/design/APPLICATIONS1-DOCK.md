# Applications1 and the first Rust dock — proposed contract

**Status: REVISED DESIGN FOR FINAL REREAD, 2026-10-30. No implementation
authorized by this file.** The owner authorized preparing and revising the design
in Codex's chat. Scope was relayed in Palomar #959 messages #681/#684; Claude's
review #688 reports the owner's closure of §12 with the amendments incorporated
below. This records that review and its provenance, not fresh authorization to
program. The owner subsequently authorized A1 implementation directly in Codex's chat;
later implementation stages still need their own authorization. IPC B
(`f080c73b`) remains separate. No publication, installation or session change.

The implementation order puts a visible dock before usage/attention/Unity:
A1 → A2 → T1 → D1 → H1 → A3 → D2 → T2/D3 → D4. T1 is independent of the
Applications series; H1/A3 are required only by D2, not by the basic D1 dock.
It uses the Rust toolkit and Hyalo, with no TS
adapter, no duplicate widget implementation and no new CI job. An intermediate
PR may advertise fewer capabilities; the block is complete only when the
acceptance table below passes. No bar, Control Center or replacement lockscreen
is pulled into the dock's first block.

## 1. Owners and boundaries

| Owner | Owns | Does not own |
| --- | --- | --- |
| Applications module in `nidara-sessiond --applications` | desktop catalogue, search, app identity/matching, app icon resolution/overrides, default handlers, launch/actions/open, usage/new markers, pin layout, app autostart preferences, Unity launcher metadata | windows/focus/minimize, thumbnails, glass, dock geometry/input or Shell1 |
| Config1 | ordinary dock preferences, existing GSettings validation/announcements | a second app catalogue or second pin-order cache |
| Rust shell process, working binary `nidara-shell` | dock surface per output, ordered view, interactions, popups/chooser, trash UI, retained focus/a11y, Shell1 methods implemented by that process | acting as a privileged proxy for arbitrary clients |
| `nidara-apps`, a normal toolkit application | app-grid/search window, own `.desktop` and app-id, launch/open and drag source | a fixed dock slot or a bar overlay |
| Hyalo | authoritative windows/workspaces/focus/lock/output/workarea, attention requests, activation validation, capture, minimize targets/motion, glass/material/controls | client content, application search, pin storage or client accessibility |
| nk-wayland/nk-widgets | reusable layer-shell host, real input/serials, activation-token creation, capture client, DnD, compatible popup parent and bounded menus/chooser | a second Wayland host in the shell; app-specific launch policy |

Applications1 is opt-in on the nested Rust bus. It neither acquires the TS
Shell name nor calls TS services. Shell1 belongs to the process which draws:
when only the dock exists it advertises `focus:dock` and dock state, not an
imaginary bar. OSD C can join that same process later; never two competing owners
of `org.nidara.Shell`. Opening Apps becomes launching its desktop entry; the
`toggleAppGrid` compatibility spelling maps to Activate/present Apps and does
not invent a hide/toggle guarantee for a separate application's window.

Presentation handles lack of a service/capability explicitly. Disconnected
Applications1 cannot reorder pins or claim a successful launch. Existing windows
can still be listed by Hyalo, using placeholder identity until matching returns.

## 2. Applications1 identity, epochs and snapshots

Proposed bus **`org.nidara.Applications`**, object **`/org/nidara/Applications`**,
interface **`org.nidara.Applications1`**. Acquire DoNotQueue; a competing owner
is an unavailable interface, never a takeover. Other sessiond services continue.

`DesktopId` is the full, case-preserved desktop-file ID, including `.desktop`,
with the standard directory-to-ID transformation. An exact ID is authoritative;
case-folding is a search/matching aid only. Distinct case-sensitive IDs are not
silently merged. Client display names, exec text, icon names, titles, bus names
and file paths are not app identities or authorization credentials.

Every runtime handle is scoped to the service's **unique owner + epoch**.
`Epoch:t` changes on daemon restart. `Revision:t` covers the coherent public
snapshot; `CatalogueRevision`, `LayoutRevision`, `UsageRevision`, `LauncherRevision`
are separate counters. A one-second usage checkpoint cannot invalidate a drag's
layout edit. Revisions increment only on actual changes, not polling/no-op writes.
`Generation:t` per app changes when its effective launch/action/icon-relevant
entry changes or is removed/recreated. Locale changes also republish labels and
search data. A missing provider never becomes an empty successful snapshot.

Capabilities use this closed vocabulary: `catalogue`, `search`, `window-matching`,
`icons`, `trash-icon`, `icon-overrides`, `layout-apps`, `layout-folders`, `launch`,
`open-directory`, `autostart`, `launch-correlation`, `foreground-usage`, `new-apps`,
`launcher-badges`. A1–A3 advertise only the ones
actually implemented and available; individual app records can further restrict
launch/open/new-window/autostart. Provider loss changes availability/reason, not
an unsupported feature into a successful no-op. A1 starts no app; A2 does not
claim foreground usage or real launch-window correlation before H1/A3.

Subscribe to Changed and NameOwnerChanged **before** GetSnapshot; queue signals
during hydration, apply only this owner/epoch, then reread if any newer revision
arrived. Changed carries invalidations, not image bytes or all records. A signal
gap/reconnect requires a fresh snapshot; owner changes discard pending handles,
menus, launch IDs and mutations. Never retry a mutation after an ambiguous timeout.

| Root member | Wire shape and rule |
| --- | --- |
| Properties | Available:b, UnavailableReason:s, Capabilities:as, Epoch:t, Revision:t and the four domain revisions:t |
| GetSnapshot | `() → (t epoch, t revision, a{sv} state)`; domain revisions, sorted first Apps/WindowMatches pages and continuation tokens, full ordered Layout, DefaultDirectoryApp, ActiveLaunches, capability/availability and launcher metadata |
| ReadSnapshotPage | `(t epoch, s token) → (aa{sv} records, s nextToken)`; immutable Apps or WindowMatches page from that snapshot; empty nextToken means complete |
| CloseSnapshot | `(t epoch, s token) → ()`; idempotently frees that sender's snapshot session and its continuation tokens |
| Changed | signal `(t epoch, t revision, as domains)`; domains catalogue/layout/usage/launches/launcher/matching/defaults/autostart/icons |
| Search | `(t epoch, t catalogueRevision, s query, u limit, b includeHidden) → (t usageRevision, aa{sv} hits)`; limit 1..100, exact stale catalogue → Stale |
| ResolveWindow | `(t epoch, s hyaloEpoch, t windowId) → a{sv} match`; resolves the service's observed window, not caller-supplied identity fields |
| GetIcon | `(t epoch, s desktopId, t generation, u logicalSize, d scale) → (s token, u width, u height, ay rgba)`; bounded on-demand resolved asset |
| Launch | `(t epoch, s desktopId, t generation, a{sv} request) → s launchId`; modes activate/new-window/action/open; request schema closed below |
| OpenDirectory | `(t epoch, s absoluteLocalDirectoryUri, a{sv} context) → s launchId`; context accepts only ActivationToken/RequestId, resolves current inode/directory handler |
| GetLaunch | `(t epoch, s launchId) → a{sv} status`; launch is not a focus acknowledgement |
| EditLayout | `(t epoch, t expectedLayoutRevision, a{sv} edit) → (t newLayoutRevision, aa{sv} canonicalLayout)`; insert/remove/move by stable entry keys, not whole stale snapshots |
| GetTrashIcon | `(t epoch, b full, u logicalSize, d scale) → (s token, u width, u height, ay rgba)`; the Trash's art from the icon theme (`user-trash-full`/`user-trash` and older spellings), never a generic named-icon lookup; Unavailable when the theme has none; capability `trash-icon` |
| SetIconOverride | `(t epoch, s desktopId, t generation, a{sv} source) → t iconRevision`; source file URI or themed name, no destination path |
| ResetIconOverride | `(t epoch, s desktopId, t generation) → t iconRevision` |
| SetAutostart | `(t epoch, s desktopId, t generation, b enabled) → a{sv} confirmedState` |
| AcknowledgeNew | `(t epoch, as desktopIds) → t usageRevision`; acknowledgement is distinct from a failed launch |

Record dictionaries have a versioned, documented allowed key set; reject unknown
request keys and wrong variant types. No raw command, environment dictionary,
working-directory override, window-title assertion, caller-declared role or
arbitrary action payload is accepted. Additive optional result fields grow v1;
incompatible meaning changes require a new interface version. GetSnapshot is
bounded to 2 MiB. Apps and WindowMatches are each paged (at most 256 records and
512 KiB per page), with `AppsNext:s` and `WindowMatchesNext:s` in state. Root
Layout is capped at 256 entries, ActiveLaunches at 32; launcher metadata is carried
on each app record, never an unbounded side collection. All readers can follow
ReadSnapshotPage; there is no truncated-success catalogue. Tokens are opaque,
bound to unique sender/owner/epoch/snapshot/domain/cursor, with 10 s expiry and a
maximum 16 live snapshot sessions per client (256 globally). Later catalogue
updates do not mutate a retained snapshot; expired or lost snapshots return
Stale. Bound retained snapshots to 32 MiB globally; refuse new snapshot sessions
with Busy rather than evicting a live reader without a Stale response. Discard
tokens on sender/owner loss. Hard catalogue admission is 16384 effective entries,
256 KiB per .desktop, 64 actions per app; field budgets cap labels at 1 KiB,
comments/keywords at 8 KiB total and records at 32 KiB. Rejected excess/invalid
entries appear in explicit catalogue diagnostics rather than silently vanishing.
Current catalogue metadata is capped at 32 MiB; retained older immutable versions
share unchanged records and have a further 32 MiB budget. Explicit rejected-entry
diagnostics include the reason; no false complete-catalogue claim at a hard
admission bound. No launch strings or image payloads travel in metadata pages.

Error prefix `org.nidara.Applications1.Error`: Unavailable, Invalid, NotFound,
Stale, Conflict, AccessDenied, Busy, Timeout, Unsupported and Failed. Stale means
an epoch/generation or read snapshot changed; Conflict is the layout CAS. A
launch timeout/owner loss is **outcome unknown**, never proof it did not launch.
Limits bound queued work; a slow icon or activation does not block snapshots,
revocation or the UI. Proposed defaults: eight workers, 64 pending requests per
sender, 256 globally, 32 active launch records, icon reads capped below.

### App, match and icon records

Wire types: identity/label/path/reason/enum fields are `s`; generation/revision/
epoch fields are `t`; flags are `b`; Keywords/Capabilities/Candidates are `as`;
Actions/Layout/WindowMatches/ActiveLaunches are `aa{sv}`; scores and timestamps
in seconds are finite `d`. IconRef/Autostart/status are `a{sv}`; optional text is
empty, never a D-Bus Maybe. DefaultDirectoryApp is an exact DesktopId or empty
with a separate reason. Record fields use the names below; no client infers
types from JSON. Timestamps are explicitly wall time or CLOCK_MONOTONIC per field.

App metadata: DesktopId, Generation, Name, GenericName, Comment, Keywords,
Visible, Launchable, UnavailableReason, Origin, OriginId, DesktopPath,
DBusActivatable, StartupWMClass, Terminal, SingleMainWindow, SupportsOpen,
NewWindowMode (`declared-action`/`relaunch`/`unsupported`), Actions (id/localized name/icon reference), IconRef, RawIcon,
IconRevision, ForegroundScore, NewlyObservedAt, IsNew, Autostart and its
writability/reason. Public data excludes executable argv and private activation
tokens; it is desktop metadata, not a list of file names/windows a user opened.
Origin is flatpak/snap/user/system/unknown: provenance, not a sandbox guarantee.
Flatpak uses X-Flatpak and its exported desktop ID; Snap uses its verified export
root/metadata, not a substring in an app name. No assumption that all Snap apps
have the same confinement.

WindowMatch: HyaloEpoch, WindowId, DesktopId (empty if unknown), AppGeneration,
MatchKind and Candidates. A3 bounds ambiguity diagnostics to 16 candidates/8 KiB,
with CandidateCount:t and CandidatesComplete:b; a partial diagnostic never picks
a winner. Exact current app_id/desktop ID first, then exact
StartupWMClass, verified Flatpak ID, then the ID and StartupWMClass ignoring
ASCII case (a unique hit only, owner 2026-11-02), then initial app_id. Bounded verified PID
ancestry/systemd metadata can disambiguate; title and executable substring alone
never choose an app. Ambiguous matches remain ambiguous. Same-executable web
apps/Steam entries must not steal each other's icons. Matching is presentation,
not permission: kernel peer/Wayland identity still governs window control.
Unknown windows get stable `window:<hyaloEpoch>:<id>` view keys; an exact unknown
app_id may group windows for presentation, never merge unrelated fuzzy hits.

The Applications module subscribes to Hyalo's read-only model and publishes
only derived matching/usage, not a second WM. A Hyalo disconnect changes
matching availability, clears runtime links and stops accrual. Reconnect assigns
a fresh connection epoch even if numeric window IDs recur. Focus/window events
need a gap-free initial snapshot seam or an explicit resync event; there must be
no race between reading Windows and starting EventStream. H1 provides the
coherent observation seam for usage/correlation in A3/D2. Before H1, D1 takes
window truth directly from Hyalo, subscribes before hydrating and refreshes on
invalidation/reconnect; it does not depend on Applications1's later matching
stream or claim timestamped usage/launch-correlation guarantees. Exact catalogue
matching remains available as a pure lookup shared with the dock, without a TS
bridge or a second WM.

## 3. Catalogue, search and icons

Use GLib/GIO's desktop parsing/launch semantics from Rust where possible, with
no GTK dependency in sessiond. XDG_DATA_HOME then XDG_DATA_DIRS supply precedence;
Flatpak user/system exports and Snap exports join once, without changing the
parent bus's environment. A high-priority Hidden entry masks the lower one.
NoDisplay and OnlyShowIn/NotShowIn affect launch-list visibility; legitimate hidden
entries remain available to identity/icon matching. TryExec, locale fallback,
.desktop escaping, desktop actions, Terminal, Path and field codes follow their
specifications; invalid entries do not abort a refresh. Watch missing roots via
their closest existing parent, directory creation/deletion and atomic replace;
coalesce bursts for 100 ms, and full-rescan after watch overflow. Publish an
immutable new catalogue only after indexing finishes; preserve the last good
one while scanning, with a degraded diagnostic if the scan fails.

Search preserves the current score tiers: exact, prefix, word prefix, substring,
word-start/adjacent acronym, then the covered-name rescue tier. Match localized
name/ID/executable basename/keywords, **not full Exec arguments**; retain Unicode
accent folding and the short-query restriction. Foreground usage can break ties
inside a tier, never lift a weak hit over a stronger tier. Empty query returns
visible apps by localized name (the app grid); a separate most-used ordering
uses ForegroundScore. Deterministic final tie-break is DesktopId. Normal search
never lists hidden apps; includeHidden is an explicit diagnostic mode. Return
candidate IDs for ambiguous human names; Launch accepts an exact ID only. CLI
listApps/launchApp can consume Search/records after Applications1 lands, retaining
External consent instead of borrowing the service's identity.

App icons and symbolic interface icons are distinct: nk-icons' monochrome shape
parser is not a full-color app-icon loader. Applications1 resolves app assets
using the user's portal-published icon theme, XDG icon-theme lookup/inheritance,
hicolor, absolute .desktop icons and pixmaps/export roots, plus existing explicit
Nidara overrides. A shared Rust resolver/decoder may serve both Applications1 and
toolkit apps; no per-surface filesystem crawl or GTK process. Preserve the
current raw-icon overlay key normalization, theme-first ordered alternatives,
Chrome-PWA casing and bounded Steam librarycache fallback. Names, paths and
actual decoded content are tested separately; an SVG containing text must be
rendered correctly, never treated as an uncolored nk-icons path.

GetIcon accepts sizes 16..512 logical and scale 1..4; cap physical side at 1024,
source read at 16 MiB, decoded source at 16 megapixels and output at 4 MiB. Decode
SVG/raster off the bus executor, preserve alpha/color, scale to fit without aspect
distortion. Missing/corrupt art returns a versioned generic app icon with a reason,
not an unbounded retry. Clients cache token+size+scale in a bounded LRU (proposed
64 MiB); icon/theme/override changes invalidate tokens. No pixels in broadcast
signals or bulk catalogue records. Persist overrides atomically under the user's
Nidara icon area; import existing raw-key overrides read-only on first lookup.
New per-app overrides win over legacy shared raw-icon keys; Reset removes only
the app's override, exposing a legacy override if present. The UI distinguishes
that from restoring the original theme; explicit legacy removal names its shared
scope so changing one app does not silently alter another sharing Icon=.

## 4. Launch, activation and new-window semantics

Request keys: Mode:s (activate/new-window/action/open), Action:s for a declared
action only, Uris:as for open only, ActivationToken:s optional, RequestId:s
optional client nonce. Limit 128 URIs and 256 KiB combined UTF-8, validate URI
syntax, reject embedded NUL. No shell interpolation. Expand Exec field codes
once through tested desktop parsing; respect %f/%F versus %u/%U and multiplicity.
Unsupported URI schemes/file drops produce Unsupported, not silent omission or
a generic `xdg-open` redirection to a different app. The folder-click path is a
separate default-handler operation, not a file drop on a chosen app.
Trash is the one fixed virtual resource: launch the snapshot's DefaultDirectoryApp
with Mode=open and Uris=["trash:///"]. It must still be the current default,
declare inode/directory and accept URI opening; otherwise return Stale/Unsupported.
OpenDirectory continues to accept only absolute local directory URIs. Do not use
the physical Trash/files folder or an xdg-open fallback.

The initiator obtains a **real xdg-activation token** using its surface, seat and
input serial; it passes the opaque token through Applications1 unchanged. The
service cannot mint user-input authority or accept a claimed serial over D-Bus.
Token absent (e.g. an external CLI) means no focus guarantee. Never fabricate a
serial for accessibility; use a compositor-supported accessibility activation
path or report that focus was not authorized. Tokens are private, one launch
only, not persisted/logged/broadcast. Granting a launch never grants focus or
window-control permission to its caller.

For **DBusActivatable=true**, call org.freedesktop.Application Activate, Open or
ActivateAction on the specification's bus name/path, with activation-token in
platform_data. This deliberately changes the TS behavior that forced Exec.
No fallback to Exec after a timeout, refusal or ambiguous delivery: it could
launch twice. A missing/unusable exported D-Bus service gives a visible failure.
Refresh/activation after installing a Flatpak must be verified on a private bus;
changing XDG_DATA_DIRS in Applications1 cannot repair an already running bus.

For Exec launches, retain the current **systemd-managed lifetime**, specifically
`uwsm app -t service` (not a shell-parented process or an unbounded captured
stdout pipe). Supply the canonical desktop identity and per-launch token to the
transient unit only, preserve Path or default HOME, terminal launch rules and
session environment sanitation. No process inherits GTK_THEME=Empty, shell
INVOCATION_ID, pressure-watch FDs, or an unrelated activation token. Journald owns
output. Use argv, not `sh -c` around client text. Implementation must verify uwsm's
safe argument/token forwarding or call the corresponding systemd transient-unit
API with equivalent properties; it cannot claim a scope around a short-lived
helper contains a D-Bus-activated app.

**DBus activation and scope are not interchangeable.** An already running app
keeps its actual unit; a newly bus-activated app runs in its D-Bus/systemd service,
not the Exec launcher's uwsm unit. Report that actual unit (or unknown) and test
portal identity there. Do not invent portal AppId success or move another
process's cgroup to make the report look consistent. This is an explicit design
tradeoff accepted in the review relayed by #688, not a reason to silently
ignore DBusActivatable.

New-window uses a declared new-window desktop action when available. Otherwise
an Exec multi-window app may be launched again; the application decides whether
it produces another window. DBusActivatable apps lacking a new-window action,
and SingleMainWindow apps, report NewWindowMode=unsupported; do not guess flags
or call Activate while claiming 'new window'. When unsupported, **omit “Nueva
ventana” from the menu**; do not show a disabled row. Middle-click then performs
the same action as primary click (launch, focus/minimize/restore or chooser as
appropriate), without claiming that a new window was requested. Supported apps
use the same new-window capability for the menu and middle-click. A later
app-specific adapter would be explicit data, not dock code.

A Launch reply is admission, **not window shown/focused**. RequestId deduplicates
same-sender repeated calls for 30 s (bounded 64 IDs; argument mismatch → Conflict);
clients still do not auto-retry unknown outcomes. ActiveLaunch status:
accepted → dispatched → window-observed / existing-window-activated / completed
(headless action), or failed / timed-out-unknown. Max visual launch bounce 10 s,
matching Hyalo's activation-token lifetime. Associate new windows via compositor
startup/activation correlation when available; exact app match after launch is
only a weaker fallback and never a claim about which simultaneous request caused
which window. Each launch has a baseline window set. Removal, timeout, service
loss or lock stops the bounce; no infinite animation. D-Bus apps reusing a window
stop it on confirmed activation; lack of focus confirmation is shown as unknown.
Launch status/Changed never exposes ActivationToken or opened URIs.

## 5. Foreground usage, new apps and Unity metadata

Frequency is **foreground active time**, not launch count. Use Hyalo's observed
focus, window mapping and match, plus logind session-active, lock, suspend and
idle status. Accrue only for a matched focused unminimized app in the active,
unlocked session. Follow GNOME shell-app-usage.c's idle-transition rule: the
session becomes idle after 5 minutes, but entering idle credits only a maximum
30 seconds of the **pending uninterrupted focus watch**, not that entire
five-minute wait. GNOME computes its cutoff as watch_start_time +
IDLE_TIME_TRANSITION_SECONDS (30), not idle_event_time minus 30. In our monotonic
accounting, cap that pending watch at min(idle boundary, watch start + 30 s),
without adding another 30 seconds to already committed usage. Resume at a fresh
watch start when active again; focus changes while idle add no usage. Persistence
checkpoints must not prematurely commit the pending watch as five-minute usage;
retain tentative versus committed accounting so the cap remains possible and
cannot double-count or drive the score negative. This adopts GNOME's idle rule,
not its unrelated score-normalization or seven-second focus quantization.

A minimized/hidden/no-focus window adds no time. Monotonic intervals, never
wall-clock deltas; split at every focus/lock/idle/session/suspend boundary. No
accrual through disconnect, process restart or suspend gaps. H1 supplies
timestamped boundaries or usage remains unavailable; client-reported 'I am
focused' is never accepted. Snapshot/replay cannot add an interval twice.

Store aggregated seconds per DesktopId, last decay checkpoint and new-app
acknowledgements in `$XDG_STATE_HOME/nidara/applications-v1.json` with a version,
0600, atomic replace and bounded/coalesced writes (30 s or a state boundary).
Retain the existing 14-day half-life, now in seconds; expose a normalized score,
not browsing history or window titles. No arbitrary conversion from the old
launch counts to seconds: leave app-frequency.json untouched and start the new
metric at zero. No cross-device or network telemetry. A crash may lose unflushed
committed usage and the unresolved tentative watch; restart never credits that
watch using elapsed wall time. Checkpointing must preserve the idle cap rather
than promise at most 30 seconds of lost usage. Decay uses wall time
only between checkpoints, clamps backward clocks at zero and never accrues use.

'New' means **newly observed desktop identity**, not proven package installation
time. The first successful catalogue establishes a baseline without marking every
existing app new. Later new IDs get firstObservedAt and IsNew **without time
expiry**: the marker persists across restart until confirmed first foreground
use or explicit AcknowledgeNew. Name/icon/package updates, user overrides and
locale changes are not new installs. There is no seven-day badge expiry or
30-day tombstone product rule. Preserve the last complete healthy catalogue
while a scan/provider/root is degraded; its recovery is not disappearance and
reinstallation. Replace that baseline only after a complete healthy scan. Thus
a brief unavailable export root does not re-mark apps, without timed tombstones.
An ID absent from a healthy baseline and later genuinely re-added is a new
observation. New IDs discovered while stopped are marked at observation time,
labelled accordingly. Presentation translates the badge; ranking is unaffected.

Unity metadata is ingested by Applications1 once, not independently by every
dock. Listen for the **signal** `com.canonical.Unity.LauncherEntry.Update(s
applicationUri, a{sv} properties)`, keyed by sender unique owner + object path +
exact `application://<DesktopId>`. Do not implement an Update method at a guessed
fixed object path. Recognize count:x (nonnegative), count-visible:b,
progress:d (finite, clamped 0..1), progress-visible:b and urgent:b; unknown keys
are ignored within a bounded payload. quicklist is not required by this block;
remote quicklist execution must not sneak in as an arbitrary-action bridge.

Subscribe before optional DoNotQueue claim of `com.canonical.Unity` so existing
libunity senders can refresh. Never steal that compatibility name; if occupied,
continue passive updates and report incomplete initial hydration. Retire sender
state on disconnect, cap 256 senders/1024 entries/64 KiB update, coalesce visual
updates to 10 Hz per app. The selected effective record is the most recently
updated **whole sender entry**, using a monotonically ordered receive counter;
never sum duplicate counts across processes. Losing a sender recomputes from
remaining entries. Fields absent from that sender retain its prior value;
explicit visibility=false clears the corresponding display. No stale final badge
survives its owner. Launcher URIs are cooperative claims, not authentication;
unknown IDs are ignored, they never create apps or execute anything.

Hyalo's application attention request is a separate, authoritative window flag
plus event with connection epoch/window ID. Rejected activation should be able
to signal attention without stealing focus. The dock combines that with Unity
urgent metadata for display only; focusing the app clears compositor attention
according to Hyalo policy, not a fake local acknowledgement. Repeated urgent=true
updates do not restart a bounce every frame. The running indicator never changes
for attention; reduced motion stops the bounce and leaves no static mark (owner,
2026-11-02), only the accessible description. Attention proposes three gentle cycles over at most 3 s per new false→true edge;
repeat true updates do not restart it. Launch bounce has the 10 s ceiling above;
no sound or forced foreground.

## 6. Pins, folders, default Files and autostart

The ordered layout stores **typed entries with stable keys**: app or folder.
App target is an exact DesktopId or `default-handler:inode/directory`; the latter
resolves to the current default app and otherwise behaves as an ordinary app
(movable, removable, grouped with that app's windows). This follows a future
Rust file manager automatically without a named file-manager list in dock code.
The user can also pin an exact file-manager app separately. Resolve duplicate
app targets to one visible slot deterministically, preserving both stored intent
and a diagnostic; never delete a user's pin because two targets resolve equally.

Apps uses binary `nidara-apps`, desktop entry `org.nidara.Apps.desktop`,
app-id/bus name `org.nidara.Apps` and localized display name “Apps”; it implements
org.freedesktop.Application for activate/opening its own window. It is an ordinary app pin. Neither Home nor
Launcher is a magic dock element. Folder target is an absolute local file URI,
with display name/icon and availability; click opens it through the current
inode/directory handler. Invalid/missing folders remain identifiable and
removable; no silent pruning, remote traversal or stack UI. The future explorer
can reuse this same folder entry for fan/grid stacks without a storage rewrite.
**Trash alone is fixed**, derived at the trailing end, never in reorderable pins.

Native persistence uses separate `org.nidara.dock layout:as` and `layout-version:u`
keys. The TS dock continues to own its legacy `pinned:as` unchanged. Rust reads
`pinned` once for import and **never writes it**, because the TS orphan-pruner
would delete typed tokens and TS bare-ID writes would corrupt a version-1 list.
This engineering isolation preserves coexistence while the TS shell ships.
The native list stores version-1 typed tokens `app:<DesktopId>`, `default-handler:inode/directory`,
`folder:<absolute-file-URI>`, with `layout-version=1`. A zero
version imports old case-preserved bare IDs once, resolves them against the
catalogue, prepends the formerly fixed Files and Apps in that order, then retains
other pins/order. Strip only known old synthetic prefixes, never arbitrary paths
or case-folded IDs. A version-1 empty list is intentional and remains empty.
Fresh default order: Files, Apps, remaining factory app pins; Trash is derived
last. **An uninstalled app pin is removed**, but only after a **complete, healthy
catalogue** proves its exact DesktopId absent. A failed/partial/degraded scan,
provider outage, watch overflow awaiting recovery, unreadable root or unmounted
Flatpak/Snap export root can never trigger pruning. Record root health/availability
and retain the last good baseline; never interpret unavailable roots as healthy
empty directories. Canonical snapshot completeness requires all configured
catalogue roots to have a successful scan or a verified healthy absence, rather
than an I/O or mount failure. If health is uncertain, defer pruning. The same
rule applies to migrated pins: import first, prune only with that evidence, not
against a partial startup cache. A fresh healthy absence removes the pin in the
shared layout transaction and publishes its new LayoutRevision, so an in-flight
drag receives Conflict rather than restoring a stale pin. Folder entries retain
the distinct missing-folder behavior above; a dynamic default-directory pin is
not pruned merely because handler resolution is temporarily unavailable. No
.desktop file or app is fabricated for a missing factory entry; Apps is seeded
only when its binary/entry ships.

Only one module writes this structured home. Applications1 domain EditLayout and
Config1's future structured-layout facade call the **same** transaction helper
and original-caller policy; no service-to-service call that upgrades identity.
Ordinary dock settings remain Config1 keys: icon size 32..96 (default 64), maximum
magnification size 64..128 (128), magnification true, indicators true, autoHide
false, delay0..2000 ms (500), position bottom/left/right (bottom). If both APIs are
exposed, no generic Config1 raw string setter may bypass layout invariants/CAS.
The structured-domain owner and ordinary-preference Config1 boundary were
accepted in the closure relayed by #688.

EditLayout request schema is one of insert-app (DesktopId or the default target,
beforeKey optional), insert-folder (URI,beforeKey optional), move (key,beforeKey
optional), remove(key). Missing beforeKey appends to the pinned section, never
a numeric screen index. Menu pinning inserts at the end of pinned apps adjacent
to their separator: no unshift/jump to the beginning. Dragging inserts at the
dropped position. Existing pin operation is an idempotent no-op. CAS failures
reread and reconcile by stable key; do not write a stale whole list over another
client's change. Preview is local until drop; Esc/cancel leaves storage intact.
Removing a running pin leaves its running slot/windows alive; it does not close
them. All monitors share one durable order. Folder count and pins cap at 256;
invalid/duplicate requests fail before writes. Commit both GSettings keys in one
backend transaction during migration and advertise canonical order afterward.

Autostart is an app preference, not 'pin'. SetAutostart writes/updates the user's
XDG autostart desktop entry, with system precedence/Hidden and OnlyShowIn rules;
it never edits a system entry or changes global service enablement. Preserve
unknown keys in an existing app-matching user file. Validate that the entry being
modified belongs to that exact app; unrelated basename collisions, unsafe paths
or read-only policy return Conflict/AccessDenied, not overwrite. Disabling a
system-provided entry creates the matching user Hidden override. Never remove
arbitrary user files, and never create two autostart files for the same app.
The existing session's single XDG autostart mechanism executes these entries;
Applications1 does **not** start a second autostart loop on daemon restart.
DBus-only and sandbox entries must pass a real session-start fixture (including
portal identity); if the existing runner cannot honor their activation semantics,
the capability is unavailable with a reason until that integration is designed.
Do not advertise 'enabled' as proof the app has already started.

## 7. Access at the original owner

Retain #973's cooperative same-UID consent and pinned kernel identity. Unique
D-Bus sender → GetConnectionCredentials → Peer; cache only live peer handles,
revalidate executable/grants per mutation, discard on owner loss. No credential
from a request body, script name, CLI or well-known name grants trust. A failure
to identify a protected caller fails closed. Errors retain AccessDenied and its
specific missing permission. No role is granted merely by using Applications1.

| Operation | Own native callers proposed | External caller |
| --- | --- | --- |
| catalogue/search/icons/snapshot/matching | public Read | public Read |
| launch, desktop action, chosen-app file-open or default-directory-open | Shell and a new narrowly scoped Launcher role | computer control |
| pin/folder layout editing | Shell, Launcher, Settings | computer control + config-write |
| icon override and app autostart preference | Shell, Settings | computer control + config-write |
| ordinary dock preferences | Shell for **dock keys only**, Settings | computer control + config-write |
| acknowledging the new marker | Shell, Launcher, Settings | computer control + config-write |
| focus/minimize/window close/capture | call Hyalo directly as the original actor | unchanged A policy and specific gates |

Implement explicit operations, not `Shell → Configure everything` or
`sessiond → Spawn anything`. The new installed `nidara-apps` executable gets a
Launcher role which cannot close/control windows, change unrelated configuration
or capture. Its dev identity needs the same administrator-managed access.d
registration as A, never an environment-based trust exemption. That registration
would be implementation code only; neither this design nor checkout tests run
an installer or write /etc. The shared access crate and role inventory change in
the corresponding authorized PR, with denial tests for every unrelated family.

A native dock can perform its own user's gesture through these scoped APIs.
If it exposes a public D-Bus helper for arbitrary app launches/config edits, it
must validate the **original** sender and enforce its consent before forwarding;
prefer not exposing that helper. CLI launchApp talks Applications1 directly.
Public Shell1 opening of the known Settings/Apps surfaces remains a fixed
OpenSurface operation, not a way to supply arbitrary executable/arguments.
No pending queued mutation survives a consent revocation without rechecking at
the final effect; revoke remains unconditional and independent of renderer state.

A desktop file, icon, Unity signal or app_id is user-supplied metadata, not a
security principal. This is not a sandbox against hostile same-UID code.
**Wayland screencopy/image-copy-capture stays outside the socket ACL** per the
owner's prior decision. Thumbnails do not establish general screenshot protection.
No new polkit rule, secret store access or privileged system mutation is needed.

## 8. Dock model, geometry and interaction

The retained dock view is a projection of shared layout + current Hyalo windows
+ Applications1 matching. It contains ordered pinned apps/folders, running
unpinned app groups after a separator, minimized-window slots in their own
trailing section, and Trash last. Empty section separators vanish. A minimized
window is not simultaneously a normal group-choice item; dialogs minimized with
their parent do not produce duplicate slots. App running dots still mean the app
has live windows, including its minimized windows. Maintain one deterministic
running order by first observed live window until its last window disappears;
focus changes do not reorder icons. No file-manager family collapse remains.

All outputs show all apps and all workspaces by default. Future filters
only-this-output and only-current-workspace are independent preferences with
explicit semantics, not silently inferred. Each output hosts one persistent
dock **wl_surface**. Output removal destroys only that output's dock. An output
identity change/reconnect starts a new output instance; do not reuse stale
surface/capture/minimize handles. Fullscreen hides only that output's dock unless
the explicit bar/dock overlay action reveals it; a menu/walk/drop cannot expose
ordinary shell content over ext-session-lock. Lock cancels interactions, popups,
launch/attention motion and capture; unlock reconstructs from current state.

### Fit and magnification

Use the existing `DOCK_SCREEN_GAP` (currently 4 logical px) as the design token;
never hardcode a second margin. Define the **resting** glass bounding box,
including padding, icon slots, minimized thumbnails, separator and Trash. Its
edge distance is g; allowed main-axis extent begins g from each output edge as
well. A left/right dock begins below the bar's authoritative reservation plus
g. All usable geometry is in logical coordinates from Hyalo/output/layer state;
no guess that a toplevel size equals the screen/workarea.

Let L be this allowed main-axis length, and W(s) the retained model's rest width
(or vertical height) with common scale factor s applied to every icon, minimized
thumbnail, Trash, inter-item gap and associated padding. Use the largest
`0 < s <= 1` for which `W(s) <= L`. Thus shrinking starts at the **inner margin**,
before reaching the screen border. It never depends on hover/bounce magnification
and therefore never changes item order or rest positions under the pointer.
Cap local enlargement so the **painted and hit-tested** magnified union also stays
inside the allowed rectangle; near corners/top bar, reduce enlargement rather
than shift the whole resting dock or clip a clickable icon. Respect the configured
maximum size and reduced motion. Every item shrinks uniformly; no exempt Trash
or minimized thumbnail.

There is **no minimum effective icon size and no scrollable dock strip**.
Shrink uniformly as far as needed to fit every item inside the margins;
magnification helps targeting and remains bounded near output/bar edges. The
user's configured preferred size remains subject to its existing setting bounds,
but the fit scale may produce a smaller effective size. Do not clamp it to 24 px,
drop items, introduce an overflow menu or change order to avoid shrinking.
The wheel is used only for cycling windows, never scrolling the dock. Keyboard
and accessibility actions must still reach every item in the shared model.

The current dynamic bar reservation must be available before dock geometry is
placed. Until a Rust bar exists, reserve the configured top-bar design region
explicitly rather than placing the vertical dock through its future area; when
it appears, use its actual reservation. The session must name this reservation
source, not let every dock guess its height. Moving bottom↔left↔right changes
anchors/exclusive zone/input region/geometry **on the same wl_surface**, committed
as one consistent configuration. No scheduleDockRebuild/destroy-and-recreate.
First implementation snaps without position animation. #966 can later transform
that stable shape; this block does not pre-implement its animation protocol.

Hyalo paints material/glass and its glass states. The client paints icon pixels,
text, dots/count/progress and owns input/focus/a11y. Use synchronized content
layers for independent icon movement where available; do not imitate Hyalo's
material transforms or add CSS-style visual hit-test offsets. Model placement,
presented input mapping and semantic bounds agree during enlargement/motion.
Substep any client spring integration as existing DockPhysics does; a stalled
frame cannot explode geometry. Reduced motion keeps enlargement as a state
change but removes travelling springs/bounces. The same frame/layout model
supplies painted pixels, input rectangles, anchors and AT-SPI coordinates.

### Clicks, menus and keyboard

- No live window: launch/present via Applications1. One visible window: focus
  it, or minimize if already focused; restored windows focus through Hyalo.
  If the group has only minimized windows, restore its most recently minimized
  live window. Missing/stale windows reread before another explicit user action;
  never close a replacement window with a reused ID.
- At least two eligible nonminimized windows: primary click opens the bounded
  thumbnail chooser; select one to focus and dismiss. If one visible plus
  minimized windows exists, that single normal window retains single-click
  behavior; minimized entries remain separate. The review accepts this selector
  eligibility: only nonminimized windows, without minimized duplicates.
- When NewWindowMode is supported, middle-click and 'Nueva ventana' share that
  operation. Otherwise omit that menu row and route middle-click through the
  same action as primary click. Wheel over an app cycles
  its eligible windows in stable MRU order, with one accumulated step per notch;
  high-resolution scroll is rate-bounded and never launches/closes. Zero windows
  is a no-op; keyboard equivalents expose the same actions.
- App menu: open, new window only when supported, declared desktop actions, current window list,
  focus/minimize/restore, close window(s), keep/remove pin, and 'Abrir al iniciar
  sesión' with confirmed state/writability. All close actions remain requests
  to the app via Hyalo, preserving save prompts and close consent. Do not use kill.
- Separator or empty-space secondary click opens the dock menu: auto-hide,
  magnification, bottom/left/right, running indicators, 'Ajustes del Dock…'.
  Change via Config1, reflect its confirmed value or show failure; no optimistic
  stuck checkbox. Settings opening uses its real page capability; absent page
  is explicit Unavailable. Full Settings-page implementation is a small dependency
  in the same dock preference PR, not another Settings migration.
- Dragging the separator perpendicular to the edge changes the user icon-size
  preference continuously, clamped32..96. Keep one Apply in flight and latest
  waiting value; cancel restores the pre-gesture setting through a checked Apply,
  failure shows actual committed value. Fit's effective shrink scale does not
  overwrite the stored preferred size. The accessible equivalent is a named
  size adjuster with keyboard steps, not a pointer-only affordance.
- Long-press starts reorder; pointer displacement alone never launches. Drop
  inside commits the preview by stable keys. Drop outside after the remove
  threshold unpins the entry only, with a visible preview; it never terminates
  a running app or deletes a folder. Trash refuses drag/remove. Escape/cancel
  preserves the original layout and releases capture on every exit path.
- Super+Ctrl+D focuses the dock on the focused output. One roving focus, visible
  ring, arrows along the main axis and Tab/Shift+Tab wrap; Enter/Space acts,
  Menu/Shift+F10/outward arrow opens its menu, Escape returns then leaves.
  Opening an app/focusing a window ends the dock's focus grab first. No grab,
  hidden retained menu or stale focus remains after cancel/close/output removal.
  Invoked accessibility actions use the same dispatch as physical input and
  expose results/errors through the live semantic model.

Native app menus reuse #971 bounded action popups with a **real layer-shell
popup parent**, no nested loop starving the dock. Child levels dismiss before
parents; clicks/keys used for dismissal are consumed once, never replayed into
an icon/window. Chooser uses bounded geometry/scrolling, actual configured
popup origin, labelled window options, selected/focused state and keyboard
selection; no monitor-sized mystery overlay. Popups re-anchor on item move,
scale/position/workarea changes or dismiss if the anchor is removed. Tooltip,
menu, chooser and drag/keyboard states have an explicit single interaction owner.

### Drag sources, drops, thumbnails and Trash

Apps publishes a versioned intra-session drag type containing DesktopId and
catalogue epoch/generation. Destination validates against its own current
Applications1 snapshot; MIME data never grants a launch/write privilege. It
commits EditLayout at drop, not at drag-enter. Accept folder pinning via a
validated local directory URI on the strip; no file is silently turned into an
executable .desktop entry. A standard text/uri-list over an app invokes its
Open capability on successful drop; validate limit/types and preserve every URI
or reject visibly. No launch during drag-hover. Successful/failed/cancelled
Wayland actions finish exactly once; ownership/serial and capture are released.
External sources are untrusted data and cannot impersonate the Apps process.

Minimized entries use Hyalo's existing ext-foreign-toplevel-list identifiers
(hex window ID) + ext-image-capture-source/ext-image-copy-capture. Add the native
client to nk-wayland; never instantiate libnidara-wl/GJS or another Wayland host.
Capture only currently displayed minimized slots or open chooser candidates,
with a small bounded cache (proposed32 MiB, max8 concurrent, refresh≤5 Hz for
visible chooser; minimized static thumbnail refreshed on content invalidation).
Frame/capture failure shows icon+title, never old content as a live frame.
Generation/source destruction/output removal/lock invalidate captures; stop and
zero sensitive cached images on lock and discard closed-window pixels.
Capture standard protocols remain the declared policy boundary from §7.

Publish minimize target rectangles per output in the dock's own namespace,
layer-local logical coordinates, and each stable live Hyalo window ID. Targets
follow actual slot geometry (including effective shrink and presented enlargement),
not widget allocation from a prior frame. Each window gets exactly one selected
target across outputs: its current/last-owning output's dock, or a deterministic
remaining output if that output vanished. Clearing an output/slot releases only
its targets; an old publisher cannot erase the new generation's targets. Restore
starts from the thumbnail's current position, and remains correct after position
change or hotplug. Hyalo owns the minimize/restore animation.

Trash remains the fixed last slot, full/empty icon and accessible count/state.
Rust uses async GIO trash:/// monitoring (all volumes) with the existing home-trash
fallback explicitly labelled as partial. Opening uses the default directory
handler; emptying is a named local UI action against the real trash backend,
with reported errors, never shell-command interpolation or arbitrary recursive
path deletion. Do not add destructive trash APIs to Applications1. No generic
public shell request may become a privileged empty-trash proxy. Missing backend
keeps the slot present but disables the unsupported action with a reason. This
preserves current behavior while keeping the later explorer/trash integration
outside the app catalogue.

## 9. Required transport and compositor seams

| Seam | Current source evidence | Required change before its consumer |
| --- | --- | --- |
| Native layer shell | nk-wayland currently hosts xdg toplevels/subsurfaces/popups | reusable layer-shell root, same-surface anchor/exclusive/input reconfiguration, per-output scale/configure, real layer parent for bounded popups |
| Activation producer | nk-wayland activation.rs consumes tokens only; Hyalo activation.rs validates pointer/keyboard provenance and 10 s age | async token request on the initiator's real surface/serial/seat; no forged serial; target app_id; callback cancellation on surface loss |
| Focus/WM stream | existing Hyalo Windows/Workspaces/FocusChanged/LockChanged, no coherent epoch+timestamped bootstrap | connection-scoped epoch, serial/counter, subscribe+snapshot barrier and CLOCK_MONOTONIC timestamps for state boundaries; resync on loss; session-active/suspend/idle provenance |
| Launch correlation | current new windows are focused when mapped; no public launch-observation identity guarantee | correlate startup/activation token to observed window/activation **without exposing token**; make denied/expired outcomes explicit enough to stop bounce, no focus-stealing shortcut |
| Attention | not present in current WindowInfo/Event | durable demands-attention flag and event (native activation denial and X11 urgency), cleared by actual focus/withdrawal; never inferred from window title |
| Capture | Hyalo capture.rs already implements foreign toplevel list + standard copy capture | native client handles, shm/dmabuf lifecycle, invalidation and bounded refresh/cache; do not redesign a screenshot service |
| DnD | nk-wayland currently implements selection/clipboard offers, not full dock drag/drop | real wl_data_device drag source/destination, serial/action negotiation, MIME bounds and correct finish/cancel lifecycle |
| Position/magnification | existing nidara-layers handles synchronized content layers | stable root surface and protocol-correct geometry; reuse compositor transforms, defer #966's additional shape morphs |
| Ordinary Files/Apps | TS has fixed Home/Launcher and a hardcoded file-manager family | Applications1 default-directory target; real nidara-apps desktop app, no hardcoded file-manager name or alias class |

Expose only the minimal required public transport capability; unsupported roles
fail explicitly. A missing toolkit primitive extends nk-wayland once, never a
shell-private connection loop. Capability tests/isolated probes come with the
seam before dock implementation depends on it. No protocol version is declared
supported just because a global binds; paint, input, popup parent, lifecycle and
scale behavior must be exercised.

## 10. Sequential PR order revised by #688

These are implementation boundaries, **not authorization** to start or publish
any of them. Prefix A is Applications work, D is dock work; IPC B and OSD C retain
their existing meanings. Each PR builds on the previous accepted one, avoids
stacked independent branches and reports capability/acceptance limits accurately.

| Order | Change | Concrete completion evidence |
| --- | --- | --- |
| A1 | Applications1 catalogue, immutable snapshots/pages, generations, search, icon resolver/override import, structured pins/migration, scoped access operations | private XDG trees/bus/settings, duplicate/case/Hidden/NoDisplay/locale/field-code parsing fixtures; icons decoded; CAS/restart/role negatives; healthy-only pruning including migrated pins, outage/unmounted-root negatives; no UI or launch claim |
| A2 | Launch/actions/open/default directory, real D-Bus activation, Exec systemd lifetime/env, autostart preference handling; CLI listApps/launchApp routes | fake app bus/systemd/launcher, token/argv/URI fidelity, ambiguous timeout never retries; DBus and Exec unit/portal identity integration in private session; no window-ready claim yet |
| T1 | nk-wayland reusable layer-shell/popup parent, activation-token producer and per-window capture client | headless persistent surface ID across 3 positions, layer-parent menu constraints, real token round trip and capture failure lifecycle, scale1 / 1.25 / 2; only primitives consumed next |
| D1 | Rust shell dock baseline without foreground usage, attention or Unity: per-output surface, pins/running/minimized/Trash, Files default handler, click/restore/minimize, fixed margin/shrink, keyboard/AT-SPI, Shell1 focus:dock | private real Hyalo+Applications1, persistent surface hotplug/position, window readback, correct target rectangles, accessible walk; no full dock completion claim |
| H1 | Hyalo coherent observation/epoch/timestamps, launch correlation and demands-attention | private compositor tests for concurrent startup, stale/foreign token, rejected activation without stolen focus, gap/restart/suspend/lock boundaries; no new capture ACL claim |
| A3 | Foreground-time ranking/new markers, launch completion and Unity count/progress/urgent aggregation | fake monotonic clock/focus/idle/session replay, no launch-count conversion, baseline/new/no-expiry/ack/restart and 30 s idle-cutoff checkpoints, real signal sender loss/restart, bounded traffic; Applications1 service block complete |
| D2 | Native app/window/dock menus, bounded thumbnail chooser, new-window/middle/scroll, indicators/attention/count/progress, dock preferences page/separator resize and magnification | live private popup/a11y tree, input not replayed, multiple/minimized windows, clipping constraints, repeated denial, reduced motion, per-output fullscreen/lock |
| T2/D3 | Native DnD seam and dock reorder/remove/folder/file-drop; same companion PR or transport first if review needs it | real Wayland source/drop/cancel matrix, CAS concurrent edits, no accidental launch/close/delete, URI/identity negative fixtures |
| D4 | Apps as real native desktop app with catalogue/search/new badges/launch, movable/removable pin and drag-to-dock; seed final factory layout; full acceptance sweep | Apps launched via Applications1/activation, listed in itself once, correct Files→Apps→rest defaults, default-manager replacement, no phantom launchers; every row below passes |

D1 starts the visible Rust shell with the dock. D4 is the small launcher companion
required by the approved ordinary Apps entry, not Prism or a full bar migration.
A1/A2 plus the independent transport T1 unblock the visible basic D1 dock.
H1/A3 arrive afterward for D2's usage/attention/Unity features and do not block
D1. T1 depends on no Applications-series PR; its activation producer is a toolkit
primitive against existing Hyalo activation support. T2 can be reviewed before
D3 without changing the sequence. If A2 reveals a needed platform integration
not captured here, close that design delta before writing an ad-hoc workaround.
Keeping A1..A3 separate avoids a single service PR hiding launch policy, catalogue
correctness and UI behavior in one review. No new CI workflow/job; local private
service/compositor probes plus existing checks, selected for each change.

## 11. Acceptance inventory and evidence boundaries

All numbers from the owner's two messages are accounted for; existing behavior
is retained except the explicitly replaced fixed Home/Launcher semantics and
the approved frequency metric. The following is the final block's checklist,
not a claim that any runtime test has been performed for this design.

| Product row | Owner/acceptance |
| --- | --- |
| Catalogue, actions, origin, icons/overrides, watch/search/matching | Applications1 fixtures and private integration; exact IDs/case, hidden matching, Flatpak/Snap/default directories, themed and legacy override assets |
| Existing pins/running separator, minimized separate slots, title/thumbnail/target | dock+Hyalo: deterministic sections/order, dialog treatment, current geometry, reopen/readback |
| Existing glass, position/auto-hide/delay/size/dots/enlargement | dock preferences+Hyalo: configured state, all 3 sides, private screenshots/input and visual review |
| Existing click toggle, per-app menu/reorder/keyboard/per-monitor/fullscreen | live private compositor scenarios; retained focus/a11y and no session-lock bypass |
| 1 count/progress | Unity real Update signal, typed bounds, update coalescing, multiple sender policy, disconnect reset |
| 2 attention | Hyalo real attention event + bounded soft bounce/static reduced-motion indicator |
| 3 launch bounce/token | real initiator token, ordinary and single-instance DBus apps, failed/ambiguous launch, hard 10 s ceiling |
| 4 middle new window | supported apps share NewWindowMode with menu; unsupported apps omit the menu row and middle-click follows primary behavior |
| 5 wheel windows | stable cycle, high-resolution deltas, no accidental launch/close, zero/one/many cases |
| 6 ≥2 window chooser | bounded labelled thumbnail popup, keyboard/AT-SPI, configure-origin bounds, close race/fallback image |
| 7 drag out | preview then unpin only; running app/folder survives; cancel no mutation |
| 8 grid drag pin | real Apps DnD identity revalidated, exact insertion, duplicate no-op, stale/cancel handling |
| 9 file drop on app | explicit chosen-app Open path/field codes/URIs; no hover-launch, partial/silent lost URI or scheme fallback |
| 10 fit | resting margin g on 3 sides, bar reservation vertical, uniform scaling including minimized/Trash, bounded magnification, no effective-size floor/scroll strip |
| 11/12 filters | all outputs/all workspaces default; later independent filters do not silently appear in this block |
| 13 new-window/autostart menu | confirmed capability/state, standard autostart precedence/collision handling and actual private session-start fixture |
| 16 DBusActivatable | exact org.freedesktop.Application methods/platform_data, no Exec timeout fallback, real unit/portal identity |
| 17 foreground frequency | authoritative intervals only; 5 min session idle caps pending watch to 30 s, including tentative-checkpoint tests; no lock/suspend/restart gaps or launch counts |
| 18 new install marker | baseline versus later new IDs; no timed expiry; foreground/ack clears; update/healthy absence/reappearance/root outage/restart cases |
| 19 dock menu/separator resize | correct anchor, Settings page, checked Config1 writes/coalescing/cancel, accessible size equivalent |
| 20 Apps ordinary app | real .desktop/app-id, visible in own grid, movable/removable, factory pin in former launcher's relative position |
| 21 Files default app | inode/directory resolver, replace handler without dock source change, actual app windows grouped, movable/removable |
| 22 Trash fixed | final slot alone fixed, disabled unsupported backend reports why, no reorder/remove/deletion via data payload |
| 23 pin placement/factory | menu pin at pinned-section end, drag at drop, Files→Apps→rest, intentional empty layout survives; uninstalled exact-ID pins (including migrated) pruned only after complete healthy catalogue |
| 24 folders now | typed persistent URI, current default manager opens, missing folder removable, no fan/grid stack yet |
| 25 no surface recreation | same Wayland surface identity and focus/input/material lifecycle across bottom/left/right; snap now, #966 later |

Out of scope: 14 recent documents per app (no service),15 Super+N (workspaces),
USB slots, per-app sound, folder stacks, #966 animation research, complete bar,
Control Center, new lockscreen, explorer and broader Settings migration. None
is smuggled in as a hidden dependency. The settings page needed to operate the
dock and the ordinary Apps launcher are explicitly in this plan.

Use pure state-machine tests for matching/usage/layout/CAS, fake private providers
for bus/systemd/activation/error cases, and headless cage for real Hyalo transport.
Then a **notified, owner-authorized private nested session** for visual/input/a11y
acceptance. No test requires touching the owner's daily session, installing or
sudo. Real monitor hotplug/DRM, installed-package startup/autostart, physical input
and voiced Orca are separate acceptance evidence; compile/headless/libatspi
checks do not prove them. Logs/artifacts in target/ or ~/Nidara/ChatGPT, not /tmp
(the short-lived private runtime socket directory may be temporary).

## 12. Review closure recorded from #688

Claude reviewed ecbb3508 and relayed the owner's closure in Palomar #959 #688
(2026-10-30). The revised document incorporates these decisions for his final
reread. This provenance is coordination information: it does not authorize A1
programming in this chat or expand the owner's standing permissions.

1. **Visible dock earlier:** A1 → A2 → T1 → D1 → H1 → A3 → D2 → T2/D3 → D4.
   D1 has no usage/attention/Unity dependency; T1 is independent of series A.
2. **Accepted:** movable/removable dynamic default-directory app pin, typed
   layout tokens plus version (isolated native keys; legacy pinned read-only
   import), one structured-write owner, ordinary preferences
   through Config1.
3. **Accepted actual D-Bus unit. New-window changed:** unsupported means omit
   'Nueva ventana'; middle-click behaves as primary click, not a disabled row.
4. **Usage/new marker changed:** GNOME's 5 min session-idle transition credits
   only 30 s of the pending focus watch; preserve the 14-day half-life. IsNew has no
   timed expiry and clears on foreground use/AcknowledgeNew. No 30-day tombstone
   rule; retain healthy catalogue baselines across degraded roots instead.
5. **Fit changed:** uniform shrink without a 24 px floor, scroll strip or wheel
   overflow. Magnification helps targeting. **Selector accepted:** nonminimized
   windows only, separate minimized slots preserved.
6. **Accepted:** per-app Reset exposes legacy shared override and shared removal
   is explicit; autostart requires proof from the real runner fixture.
7. **Additional pin amendment (§6):** remove uninstalled app pins only when a
   complete healthy catalogue proves their exact ID absent. Never prune from
   failed/partial/degraded scans, provider loss or unmounted export roots; this
   protects migrated pins too.

The owner subsequently gave the explicit A1 implementation go-ahead in Codex's
chat. That authorization is separate from this relayed review and does not cover
later PR stages, publication, installation, queue or merge.

## 13. Sources checked for this draft

Repository baseline: main `7b775e63`; no current installed session inspected.

- `ui/shell/core/AppService.ts`: catalogue, desktop identity, Flatpak/Snap,
  existing icon overrides/Steam/PWA fallbacks, and `uwsm app -t service` rationale.
- `ui/shell/core/AppFrequency.ts`, `app-search.ts`, `Icons.ts`: old launch-count
  metric, ranking tiers, separation of symbolic interface icons from app art.
- `ui/shell/surfaces/dock/{DockCore,DockItem,DockAxis,DockPhysics,state}.ts*`:
  current pin insertion, synthetic Home/Launcher, geometry/input/minimize/menus.
- `ui/shell/core/TrashService.ts`: aggregate trash versus home-only fallback.
- `crates/nidara-access/README.md`, `session/daemon/src/{tray,power}/README.md`:
  A's credentials/consent, service snapshots, sender/epoch/generation conventions.
- `toolkit/PHASE1.md` revision3, `toolkit/CONTRACT.md` bounded action popups:
  Rust-only separate-session path, single transport, actual popup parent constraints.
- `toolkit/crates/nk-wayland/src/{activation,lib}.rs`,
  `hyalo/compositor/src/{activation,capture,ipc/mod}.rs`: actual current transport,
 10s activation provenance, capture identifiers and missing observation seams.

Primary external specifications (consulted 2026-10-30):

- [Desktop entries and IDs](https://specifications.freedesktop.org/desktop-entry/latest/),
  [Exec field codes](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html),
  [D-Bus application activation](https://specifications.freedesktop.org/desktop-entry/latest/dbus.html).
- [XDG activation XML](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/staging/xdg-activation/xdg-activation-v1.xml)
  (also inspected through its upstream GitHub mirror).
- [Icon theme lookup](https://specifications.freedesktop.org/icon-theme/latest/).
- [XDG autostart](https://specifications.freedesktop.org/autostart/latest/).
- [Canonical launcher-entry signal producer](https://github.com/canonical/launcher_entry/blob/main/lib/src/launcher_entry.dart),
  source blob `cd1e0de4d70625ed6428295ce7896243d3ad725c`: real Update signal and
  property types; app URI and object path are metadata, not a privileged command.

- [GNOME shell-app-usage.c](https://github.com/GNOME/gnome-shell/blob/main/src/shell-app-usage.c),
  `on_session_status_changed` and `IDLE_TIME_TRANSITION_SECONDS`: verified the
  watch-start-plus 30 s idle cutoff; adopted only that behavior, keeping Nidara's
  existing 14-day decay and its monotonic accounting.
