<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Real input methods on the new Settings fields

`nk-settings-ime-check.py` drives the production retained SearchInput and the
FontChooser's actual View, filter, lazy font catalogue and Composition host. Its
opt-in `ime-gates` binary observes committed/display/preedit state after actual
Wayland input; it does not send synthetic editor requests or run Config1 Apply.
The probe is not acceptance of the complete Settings application.

Rows: Mozc, Pinyin and Hangul, at 1 and 1.25, on both search and font search.
Each checks real preedit, committed text, cancellation retaining the preceding
query, and the cursor rectangle against classicui candidate pixels. Hangul's
candidate row opens its real Hanja list with F9; ordinary Hangul composition has
no candidate list. Candidate placement uses the existing phase-0 pixel oracle.

Each row has a separate applied fault: ignore preedit, drop commit, retain
composition across cancellation, or displace only the transmitted cursor by 80
logical pixels. A control passes only when its own ordinary predicate fails and
the actual branch reports it applied. Process exits, missing panes, setup errors
and deadlines fail the run. All 48 baseline and 48 control target rows must pass;
controls also rerun their prerequisite assertions. Missing required rows prevent
`complete_matrix`.

The fresh fcitx5 profile/theme/startup is shared with phase 0 through
`nk-real-common.start_ime`. Snapshot barriers wait for received IME batches and a
fresh idle after seat dispatch; clipboard seeds require a new offer with exact
bytes. Nothing injects text through AT-SPI or private model setters.

CI builds and runs the new binary only when `HYALO_ANIMATION_CHECKS=true`, which
ci.yml already sets only on schedule/workflow_dispatch. This gate has no PR
baseline or control cost. It adds no workflow step. Artifacts include the
assertion table, both wire logs, state snapshots and candidate screenshots under
`hyalo-out/toolkit-settings-ime`. Existing phase-0 rows retain their scope policy.

Local disposable container, using the #945 runner (also present on main):

```
scripts/dev/real-gates.sh settings-ime
```

It uses the same cage → nested Hyalo and portal fixture as the widgets checks,
on a private bus/runtime; neither the live compositor nor the host input method
is used. `REAL_GATES_CONTROLS=0` is diagnostic only; it cannot claim the complete
matrix. This headless run is not the live D7 oracle or the owner's acceptance.

The real rows exposed an engine ordering case: Hangul commits its preedit then
forwards Escape. Search keeps a one-shot finished-composition boundary until the
next ordinary key, so that Escape does not also clear the query. A following
Escape can clear it normally. FontChooser uses the same boundary before deciding
to close the dialog. The focused SearchInput still owns preedit cancellation.
