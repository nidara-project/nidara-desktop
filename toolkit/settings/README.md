<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Native Settings implementation

The contract is [PHASE1.md](../PHASE1.md) and [CONTRACT.md](../CONTRACT.md).
This library is in progress; native app/Config1 builder integration and acceptance
remain separate from its diagnostic probes. See [EVIDENCE.md](EVIDENCE.md).

`dropdown::show` supplies the shared controlled-popup host. Lend `dropdown::Host`
the parent Tree/Window, text backend, Styles, the application's single Bridge and
mutable publication revision slot,
optional exported panel recipe, physical serial, poll interval and `keep_open` hook.
Publish parent snapshots with `PopupSnapshot::new` to share the modal revision
namespace. The popup projects stable parent ComboBox/Selection IDs at its actual
configured origin. It creates no second provider and does not write Config1.

Stage Config1/appearance/navigation/visibility notices in `keep_open`, without
mutating the borrowed Tree; false cancels before applying staged notices after
return. Invalidation rejects choices and suppresses trigger focus restoration.
Ordinary Escape/PopupDone preserve selection and restore available focus. No panel
recipe forces D5 paint; a supplied recipe resolves at actual configured size.
The manifest builder below consumes this controller through the renderer context.
`dropdown-provider-probe` and `nk-dropdown-provider-check.py` exercise the controller
and one real provider diagnostically, not real Orca or Config1.


`dropdown_builder::register` installs the real schema-backed dropdown builder.
It preserves the combo and surviving option IDs across canonical updates, adds an
unknown current enum value by its own name, and maps Selection changes through
Cx.apply. Reading/notice handling never writes. Opening requires Host.modal and
a parent Window; `dropdown::Native` owns the application's single Bridge, text,
revision and notice staging, implementing render::Modal. Its real Client polling
cancels on any new notice, which the app must deliver from Native.notices after
return. Pure tests use no native host and do not establish that integration gate.

The Config1 integration tests use Client::start with their private bus connection.
Their daemon sockets live under toolkit/target/config-bus-<pid>-<counter>, with
scoped cleanup after exit; they never replace the live session bus address.


`dropdown-builder-probe` composes the actual manifest builder, Client, Rendered and
Native modal context on the existing private provider harness. Set
NK_DROPDOWN_BUILDER=1 with its fixed binary when running
check-dropdown-provider-headless.sh. Optional NK_DROPDOWN_BUILDER_STAGES selects
comma-separated select,cancel,refuse,updated,unavailable,portal cases; default is all.
The checker supplies a real private Config1 service and uses the portal fixture's
private ChangeScale method, so SettingChanged comes from the portal owner itself.
This fixture interface is never installed. Controls sabotage only modal Config1
polling or the external appearance hook and must fail their own Apply-count assertion
after close, pending completion, parent commit and provider publication. Earlier
controller checks are unchanged without NK_DROPDOWN_BUILDER.

The complete native builder matrix is still pending: some local software EGL runs
lose their context and stop delivering parent frames. Such setup timeouts fail the
check; they are never accepted as a control catch. See EVIDENCE.md for the passing
subsets and preserved failed runs. Routing/page unmount and real Orca remain separate.


FontChooser metadata is available through font_catalog::Load: start only on chooser
open with Operation { mount, request }, poll nonblockingly with the current token,
and cancel on hide/unmount or a newer open. A single worker serializes actual
Fontconfig enumeration with one queued job maximum. Catalogue preserves primary
family/style names, exact files and full face indices, and supports family-name
filtering. It reads metadata without loading the font files. Empty style names from
Fontconfig stay unnamed. font_chooser::choose consumes this in the existing modal
DIALOG with SearchInput, embedded family/style LISTs, point-size SpinButton and
retained selected-family sample. It returns Selection { family, points, attributes },
never Apply. Caller supplies the point range, portal text scale, labels, icon
preparation and staged-notice hook. Supported standard style attributes and canonical
point descriptions share font_description with Styles. Unsupported styles/named
instances are disabled, and an unsupported initial style is preserved without
acceptance. Exact face/index selection remains pending;
CPU paint/semantic tests are not native chooser or Orca acceptance.

The font-description integration test requires Python 3 and installed libpango-1.0
for an independent metadata oracle. No Pango dependency was added to production
rendering or startup; all glyphs still come from the shared Parley Layout.

font_builder::register installs both controlled font rows against their real
Config1 keys and exported i18n. Cx.open_font calls the existing Native modal context;
configure Native.font before use. The caller supplies FontsArc, translated dialog
labels, window/list/point constraints and icon-theme preparation; Styles supplies
the actual portal text scale and the row supplies its title. Native shares its one
Bridge/revision and stage_modal_notices with Dropdown. Drain notices after return.
Accepted changed descriptions Apply once; cancel/same/invalidation do not. Canonical
replies and refusal errors remain visible. Captions follow live text scale without
writes or continuous repainting. Private-bus tests use actual exported font items
and real Config1/Client with a headless modal decision seam; native end-to-end,
main configuration and real Orca remain separate pending gates.


Local extraction status (cuts23–33): provider/controller and builder diagnostic
sources were compiled and static-checked; their checkers were NOT EXECUTED on
these reconstructed heads. Tests use the complete search-input-data export from
cut27. Native baseline/control, full Config1/modal lifecycle, real Orca speech,
performance and owner live acceptance remain pending. Historical fixed binaries
prove only their recorded original source/hash. The exclusive parent borrow is
bounded to short menus, with no concurrent parent servicing; adaptive foundations/
Settings polling still needs a real caller and causal test.


Use page::Mounted to own a renderer and the roots it created under the content
Scroll. Failed builds unmount partial builder work and remove only newly-created
roots. A replacement is built before retiring the old page; consuming unmount
runs all callbacks before node removal even when cleanup fails. This is the page
lifecycle prerequisite for the app, not yet its native main or wallpaper builders.


image_load::Load supplies bounded off-UI wallpaper decoding. One worker and four
queued requests; queue-full is retryable Busy. Callers supply absolute path,
physical target, Contain/Cover, mount/request token and input/output byte budgets.
Cancel on hide/unmount/replacement. Only target pixels survive completion; obsolete
results are dropped. PNG/JPEG/GIF(first frame)/WebP/AVIF decode here; AVIF links
dav1d. Decoder-internal allocations are not a hard memory guarantee. Native
wallpaper parity, colour-profile/HDR validation and startup/PSS remain pending.

wallpaper::register supplies the real wallpaperPreview/wallpaperGallery decorations
using wallpaper.current/catalogue, retained images/thumbnail choices and the lazy
image loader. It requires explicit host Budget and complete wallpaper token exports.
No file scan or decode at build; only showing pictures start work from idle.
Same value does not Apply, unknown path selects none, and canonical refusal/error
handling reuses Session/Cx. Empty/error rows use Builder::row_visible under the
renderer's own predicates. wallpaper_picker::register supplies the separate real picker consumer; omitting
it remains a missing-builder error rather than silently substituting it. No native or full wallpaper parity.

file_chooser::Chooser is the asynchronous OpenFile transport over Editor's existing
connection. Supply nonzero Operation and translated Open labels plus the actual
Window portal-parent identifier. It never Applies. Poll accepts only the current
mount/request; cancel/Drop requests Close. One process worker, Busy retryable.
Subscribes before OpenFile, pins the portal unique owner, checks the returned path
and owner before acceptance, and rejects multiple/remote/malformed URIs. Local
file URI escapes decode before returning the absolute UTF-8 path. Config1 remains
the image validator. The caller must enforce mount/visibility/write/baseline guards,
focus restoration and parent accessibility; these are not transport acceptance.
Protocol references: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html
and https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html

wallpaper_picker::register connects wallpaperPicker to the real Window parent
export and file_chooser transport. It owns one pending operation, a process-wide
nonzero request number, the mount, epoch/value baseline and cancellation lifetime.
Normal cancel/same chooses do not Apply; changed accepted results call Cx.apply
once. Hidden/unmounted/stale/unavailable results are retired without focus return;
ordinary completion restores the eligible launcher. Raw current path/help/error
are in its existing description/subtitle; canonical failures survive cancel.
The picker suggests HOME through current_folder filesystem bytes plus NUL; the
portal can ignore the suggestion. No Window becomes an explicit row error.

Rendered::idle drains Editor.poll BEFORE async builder completion and returns the
applied Vec<Notice>. Hosts must observe that return for dependencies outside rows,
and stage portal/routing/visibility changes first. external_modal_active exposes
pending external portal operations: host must reject parent accessibility actions
and publish inactive parent semantics during them. That host/provider integration
and native focus/dialog acceptance remain pending. Button secondary/pill visual
parity is still provisional; this consumer reuses the shared native Button.


The first local application entry point is now src/main.rs/application.rs, the
nk-settings binary. It assembles the actual exported Appearance page, all five
builder modules, Shell, Client, Portal, Native-mode Router and one shared Bridge.
It does not install a launcher or replace the current Settings. Development build:

```sh
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo build -p nk-settings --bin nk-settings
```

Run only in an explicitly selected graphical test environment, with complete
NK_SETTINGS_DATA from both real exporters. NK_ICON_REFERENCE can name the actual
reference icon directory for development. No native run was made for this cut.
The binary connects to the selected session bus; this is not a fixture mode.
Startup shows a loading row until Client's real Snapshot. CONTENT_READY commit=N
means the root commit contains the mounted authoritative page, not a presentation
or performance result. Real Configure precedes provider/layer publication.

The application stages portal/native routes, retires pending external choices
before acceptance, handles Native and Renderer idle notices, and applies actual
Config1 interfaceIconTheme to parent/transient trees. Fresh snapshots rebuild
mounted roots so formerly unavailable generic rows appear. Pending file selection
masks parent semantic actions/focus and physical input; CPU tests verify this
policy without faking Window or provider. Full-page activation is also checked
through the actual Client/Router-owned connection on a private bus.

Remaining: queryUI explicitly unsupported, native activation/focus acceptance,
sidebar search/results, direct
forwarded-route/modal cancellation, long-modal parent servicing, adaptive polling
(still16ms), provisional window/font geometry/chrome and all native/Orca/installed
performance/live gates. This is a compiled local executable, not full parity or
native acceptance. New twelve-locale strings require new complete native-app-data;
older cut38 data does not contain this application's labels.


Native activation now accepts the launcher's actual XDG_ACTIVATION_TOKEN and
transfers it to an existing native instance via the existing Request(as) optional
trailing --xdg-activation-token pair (routing::with_activation). main removes the
environment entry before starting threads; no tests mutate the process env.
The app waits for its first painted root, takes the token once, and uses the
standard nk-wayland consumer. Responses distinguish request submitted, missing
token and unavailable protocol; none asserts confirmed focus. Native queued
navigation invalidates pending modals first. No self-issued token or fake serial.
Legacy forwarding keeps its original arguments; tokenized legacy activation,
queryUI and real native validation remain pending. Private-bus handoff tests do
not exercise the actual Window or the main-entry environment mutation.

For an explicitly opaque diagnostic view, set NK_SETTINGS_OPAQUE_PREVIEW=1 before
launch. It uses the same real application/data/builders through the existing D5
paint path, masks material/layer capabilities in the existing host and omits the
window-background declaration. It is a launch opt-in, not a persisted preference.
Controls still edit real Config1 if operated; simply opening makes no Apply.
This mode does not establish that the normal D7/material path is stable.
