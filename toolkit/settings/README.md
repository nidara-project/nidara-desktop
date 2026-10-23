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
The schema-backed builder now supplies notice plumbing; actual app hosting remains pending.
`dropdown-provider-probe` now supplies the separate diagnostic composition of
controller/Tree/Bridge on nk-wayland. `check-dropdown-provider-headless.sh`
reuses the existing private widgets host and runs
scripts/ci/nk-dropdown-provider-check.py with explicit fixed binaries/data/log
paths. The checker covers select/cancel/invalidate, stable IDs, one provider,
configured option bounds, physical grab and focus restoration with three own-value
fault controls. It is NOT EXECUTED on this extracted head: this cut only separates
and compiles the diagnostic. Native baseline/control execution, Config1 builder
integration and real Orca speech remain pending; historical fixed-binary results
are not acceptance of a rebuilt head.
Compilation/CPU tests here do not establish native controller/provider acceptance.


The manifest builder below consumes this controller through the renderer context.


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
Fontconfig stay unnamed. This is the lazy catalogue foundation, not an implemented
FontChooser dialog or font builder; the accessible search ENTRY is still required.


Fontconfig stay unnamed. font_chooser::choose consumes this in the existing modal DIALOG with SearchInput,
an embedded family LIST, point-size SpinButton and retained selected-family sample.
It returns Selection { family, points }, never Apply. Caller supplies the point
range, portal text scale, labels, icon preparation and staged-notice hook. Style
selection, canonical descriptions and Config1 font builders remain pending; CPU
paint/semantic tests are not native chooser or Orca acceptance.
