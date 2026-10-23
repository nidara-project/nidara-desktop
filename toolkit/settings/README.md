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
The real manifest builder/notice plumbing still need integration.
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
