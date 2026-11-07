# Dock popup re-entry diagnosis (#1040)

The owner authorized #1040 directly in the Codex chat. Investigation base: main
2903b277. No dock implementation, CI/configuration, install or live-session changes.

## Cause and history

The failing check clicked `(10,10)` to dismiss the dock menu. With `--bar`, that
point is the bar's System menu button. The screenshot and Wayland trace show the
new bar menu open and receiving a grab; the dock receives no enter/motion when
the pointer returns. Not magnifying during another menu's grab is correct.
The same unmodified main binary passes the full bar/dock suite when the outside
click lands on blank space. There is no demonstrated product regression to patch.

Source bisection from 9541a30d^ (6473cb68) through 2903b277 identifies 9541a30d
(#1032) as the first commit introducing this invalid test coordinate. This is a
predicate about the faulty test, not a claim to have bisected a spring bug.
A valid product bisection needs a bad endpoint; main is good with the corrected
probe. Retain #1030's pointer reconciliation rather than removing it.

## Corrected coverage

The shared `popup_presence()` probe chooses a point left of the bottom dock and
below the bar, using the current surface extent. It refuses a run that opens a
second modal bar menu. Resting bounds are sampled with the pointer away. It
checks initial magnification, outside dismissal, re-entry, popup-local Escape,
closing over the root by click/Escape, and later leave. Failed re-entry retains
geometry and a screenshot. `NK_DOCK_POINTER_TRACE=1` adds client Wayland logging.

The full `check-bar-headless.sh` invokes those same assertions. The shorter
`check-dock-popup-headless.sh` starts the bar and dock with private Applications1,
Config1, bus and settings, then runs just those assertions. Set HYALO_BIN,
NK_DOCK_BIN, NK_SESSIOND_BIN and NK_SETTINGS_DATA to the intended builds/exports.
It neither installs anything nor uses the owner's desktop. Never build while a
headless check runs. Evidence belongs under ~/Nidara/ChatGPT.

## CI proposal for owner review

No CI changes in this PR. Propose the short probe for the nightly animation group
(`HYALO_ANIMATION_CHECKS`), with its deliberately broken reconciliation control.
It measures an animated result and depends on software frame delivery, so it does
not belong in a required PR job merely because it is short locally. Use the same
installed Rust shell/Hyalo/sessiond, export data, and private service environment;
account for Cage, libatspi/Python GI, schemas and theme fonts. Keep the full suite
as a broader nightly/local check. A later CI change needs separate owner approval.
The probe took 21–22 s locally. The exact pre-#1032 binary (6473cb68) fails
"outside dismissal restores resting bounds"; 9541a30d and unchanged main pass.
That historical binary is the negative control: the corrected test still catches
missing popup-pointer reconciliation. Full-suite results and source provenance
are recorded with the evidence.
Physical-display pointer/refresh-rate/Orca acceptance is separate.
