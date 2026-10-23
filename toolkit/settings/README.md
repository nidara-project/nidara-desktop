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
The separate provider diagnostic is not included in this production extraction.
Compilation/CPU tests here do not establish native controller/provider acceptance.
