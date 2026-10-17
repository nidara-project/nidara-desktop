# #846 — real text extents and Orca flat review

The old client passed the 25 existing form-walk assertions, but authentic Orca
KP_Up spoke only `日本🙂 `: `word` was missing. Its debug log records unknown
`GetRangeExtents`. With layout-derived text extents, the same action speaks
`日本🙂 word`, and all 26 assertions pass. The wrong-extents control produces
`日本🙂 ` again and fails that same assertion; the control exits successfully
only because application and consumption are proven.

| Focused real Orca case | Complete line assertion | Speech |
| --- | --- | --- |
| Before: frozen #843 client, no extents methods | FAIL | `日本🙂 ` |
| After: real shaped-cluster geometry | PASS | `日本🙂 word` |
| Wrong extents, same full-line assertion | CAUGHT | `日本🙂 ` |

Literal step logs, screenshots, per-case reports, client hashes and the fault's
publication/returned-rectangle records are in [evidence-846](evidence-846/).
The focused after run passes 26/26 baseline assertions. It is not a claim of a
complete 24-control matrix: full local and vkms CI tables/run links are recorded
in #846's draft PR comment once those runs complete.

## Geometry and protocol

Parley's retained shaped runs provide advances, bidi order and line metrics.
`Layout::cluster_boxes` caches their actual boxes in one visual pass per reflow;
no second shaping pass or per-character width estimate is used. The app adds the
same `(field.x + 12, field.y + 12)` origin used by paint, then supplies plain UTF-8
cluster spans to `nk-a11y`. Both new AT-SPI methods have four integer outputs,
matching atspi-common 0.14's `xml/Text.xml`; the provider converts scalar offsets
to bytes, unions clusters and rounds outward. Geometry is WINDOW coordinates,
as requested by the installed real Orca 51 `AXText` implementation.

Several scalars can share one combining/emoji/ligature cluster. A collapsed range
uses its logical leading edge; AT-SPI has no affinity argument. At a bidi soft
wrap Parley's byte-to-caret policy can select the previous visual line for both
affinities, so the geometry regression instead validates the cached leading edge
through native point hit-testing. Native selection rectangles are also compared
where their endpoint affinities are on the cluster's line. This does not change
Editor caret policy. Empty/end geometry uses the retained layout's final caret.
Missing geometry, including a committed document replaced temporarily by an IME
preedit buffer, is explicitly unsupported rather than described by stale boxes.
Password filtering removes all text geometry before snapshot validation.

## Discriminating control

Only the test window mutates geometry. `text-extents` publishes
`(-10000, -10000, 0, 0)` for the Name text, leaving its text and node bounds intact.
`A11Y_FAULT_APPLIED text-extents ... published` is logged after backend update;
the driver waits for publication before pressing the real keypad key. Orca's
own `AXText: Range ... has rect` record must show that wrong response. These are
application/consumption prerequisites, not the speech oracle: the exact same
fresh `SPEECH OUTPUT` full-line assertion must fail. Timeouts, crashes and
unapplied controls cannot count. No production-provider fault switch is added.

## Validation scope

Focused evidence uses real Orca and speech-dispatcher's `sd_dummy` with libao's
null backend in the private bwrap + cage + Hyalo harness on the AMD GPU. It does
not operate the live desktop, and it does not claim tty/vkms presentation. The
fixed #843 compositor is used. No merge or push to main is part of this change.

## Preserved first CI failure: keypad lock state

The first candidate CI run, 39001926759 at f5aecfff, failed the new assertion:
Orca received `KP_8` with Num Lock modifier 16384 and spoke `8`, inserting it into
the field. The earlier shared vkms settings check explicitly enables Num Lock;
the isolated local compositor starts with it off. This was not a geometry pass
or a caught fault. The red run and its reports remain linked in the PR.

The probe now observes a real Shift release before mapping the application,
disables Num Lock only when observed on, verifies it is off, and restores its
initial state on exit. `numlock-setup.log` and the report's environment record
retain the observation. Both original lock states use the same full-line speech
assertion and wrong-extents control, without retrying either assertion.

The preparation was exercised with Num Lock initially off and initially on in
four isolated local sessions: each 26-row baseline passed, and each wrong-extents
run caught the same `Flat review Unicode line` assertion with publication and
consumed-response evidence. Both reports record `normalized: false`; the initially
on sessions also log the final `num lock on` restoration. These focused runs used
the unchanged final client binary and the modified probe before the follow-up
commit; complete matrices at the published head are linked separately in the PR.
