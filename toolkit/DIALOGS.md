# Dialog and alert, #1103 step 6

Owner authorized implementation in the Codex chat on 2026-11-17. Base: main2dcda568.
The first commit records the contract; implementation and local acceptance follow it.

## Scope and owner decisions

One nk-view modal host owned by AppWindow, content built with kit nodes, title and
buttons from the application. Alert composes that host with a message and optional detail.
One answer: a response button, or cancellation. At most one default and one cancel;
destructive+default is a construction error. Cancel first, default last at the trailing
end. A dialog has only close (cancel); an alert has no window controls. Outside presses
do not dismiss. File/font/colour choosers, Settings' legacy DialogTree, sheets and extra
nested-modal capabilities are outside this step. #1128 and #1130 remain separate.

Enter reaches the focused component first: composition and a row-opening list keep it.
Only an unhandled Enter takes the default. Escape cancels composition first, then cancels
the window. Tab cycles inside. On open focus the first eligible content control, or the
alert's default, else the first enabled non-destructive response. If none exists,
leave response focus empty; a destructive response requires an explicit selection. Restore the original key only if it remains shown/enabled and the same
retained component instance; cancellation/error must also retire the modal namespace.

## System dialogs (#1185)

Every native dialog uses `nk::Dialog` or `nk::Alert` and opens as an
`xdg_toplevel`. App dialogs use the modal parent path above. Independent
dialogs use `Dialog::run_parentless` or `Alert::run_parentless`, supply the
window identity and available size, and can pass the initiating Wayland
activation grant. Hyalo recognizes trusted shell dialogs by their identity,
places them above ordinary and fullscreen windows, grants focus for valid user
activation, and asks for attention on spontaneous requests. The lock screen
takes priority.

The shell uses Dialog for Wi-Fi secrets and Bluetooth PIN/passkey input or
display, and Alert for Bluetooth confirmation, authorization and file consent.
The kit supplies the header, responses, focus and keyboard policy. The service
model supplies body content and response eligibility. An asynchronous response
can keep the window open while the service decides. Failed replies re-enable
the responses, and withdrawal closes without sending another answer. The
explicit Reject button sends a negative reply. Escape cancels the request.

The gallery's System dialogs page opens independent Dialog and Alert examples.
They use the gallery's app ID, so Hyalo places them as ordinary windows.
The Dialog and alert page continues to exercise the parented host.

## Alerts with a countdown

`AlertCountdown` uses a monotonic deadline and a localized message suffix
with `%d`. The number appears inside the alert message. The kit announces it
at the start and when the countdown crosses 30, 10 and 5 seconds. Both the
app-modal and the independent alert use this policy. The gallery has a
ten-second sample on each dialog page.

A timed response names an enabled default button. A key press, pointer press,
reader action or focus loss stops automatic selection. Explicit responses
remain available. Expiry selects the button only while the alert has focus.
The shell uses this for its 60-second log out, restart and shutdown alerts.
Locking or losing the compositor withdraws an outstanding system alert.

Display1 records its deadline once the preview is visible. The shell shows
the countdown in a system alert and returns the person's choice to the
Settings connection that initiated the preview. Revert cancels that lease
and Keep confirms it. The compositor's Display1 service owns the layout,
deadline and automatic rollback. Its deadline remains in force during
interaction and expiry sends no duplicate display write. Loss of the
initiating connection revokes the lease and closes the shell alert.

## Audit findings

- Hyalo wm/mod.rs initially centres over a mapped parent but then cascades off any fully
  covered window. A modal can therefore leave its parent's centre; bypass cascade when
  a valid parent is present, retaining work-area clamping and explicit centre rules.
- nk-wayland run_dialog uses the same connection and set_parent, but does NOT bind
  xdg-dialog or send set_modal. Implement the standard modal hint; do not substitute an
  application-specific protocol. Hyalo already routes modal_target through that hint.
- Its nested loop dispatches only the child queue. Extend the runner to service the
  parent's queue and painting through a restricted parent adapter, while rejecting its
  input and accessibility requests. Old run_dialog callers remain supported.
- No Rust action-risk mechanism currently exists. CATALOG.md labels it a proposal.
  The owner decided directly in Codex to reserve risk for another step (2026-11-17).
  This step therefore adds neither risk annotations nor a consent mechanism.

## Host and lifetime

Reuse AppWindow's content, component host (lists, clipboard, IME), layout, look and paint
for the dialog, with modal chrome rather than sidebar/navigation. A restricted parent
adapter keeps protocol events, paints and appearance alive, and ignores pointer/keys.
The parent model remains its owner's; changes are applied on the next normal layout.
No new Bridge: publish parent and dialog through the parent's one bridge. Parent nodes
are unavailable and expose no actions while modal. Queued actions require the current
publication and the live modal namespace. An old object cannot target a later modal.
Map all semantic relations/selection targets consistently, retire them on every exit,
and restore parent publication/focus even after a transport or content error.

Dialog/alert root roles differ, but both are modal and active only on actual focus.
Alert message is its description. Buttons keep complete localized names. The original
risk requirement is explicitly deferred by the owner; destructive colouring is not an
agent-risk declaration. Look/reduced-motion changes reach both windows; there is no nested glass pane for
its own sake. The root owns the glass and content uses ordinary kit nodes.

## Size and tokens

Measure the actual expanded content, title and response row using existing kit metrics.
Minimum comes from the mandatory header/buttons, not a new pixel constant. Maximum is
the parent's available client size, with the existing form preferred width as a cap.
Height is content-derived and capped by the parent; its content scrolls before the
header/buttons lose space. Missing metrics or impossible mandatory content is an error.
Do not copy run_inner's fixed400x300 minimum into the dialog. No new numeric bound is
approved here. If measurements show a further bound is needed, bring it to the owner.

Normal/default/destructive button looks reuse the existing kit CSS recipes and exported
colours, preserving the normal recipe. Any token/checker addition is prepared for direct
owner approval before changing CI. The shared focus outline from5b stays unchanged.

## Acceptance

CPU tests cover response validation/order, ownership, namespace retirement, eligibility,
size constraints, Enter/Escape policy and destructive-default rejection. Hyalo gets a
centering regression. Private graphics at1/1.25 exercise field+list dialog, two-response
alert and destructive alert, keyboard and AT-SPI, real modal parent/refusal, close and
outside press, focus restoration, portal appearance/reduced motion and geometry.
Negative controls independently catch default Enter, Escape, Tab confinement, return
focus, parent refusal and destructive-default validation. Existing stable gallery pages
keep their pixels. New checks stay local until any tracked checker patch is approved.
Physical-session/Orca and vkms evidence are reported separately, never inferred.

## Local acceptance record

Evidence directory: `evidence-1103-dialogs` in the owner's ChatGPT workspace. Full toolkit
workspace: 748 tests passed, with the existing wallpaper timing benchmark ignored. Hyalo:
170 tests passed; toolkit and compositor Clippy pass with warnings denied. The generated
button recipes pass the token checker in all four mode variants; three broken exports
(missing primary recipe, invalid fraction, unresolved colour) are rejected.

The private headless Hyalo runs use real libatspi and a scripted input-method probe,
never the installed session. At scales 1 and 1.25, 71 dialog checks cover initial focus,
composition/default/list Enter, composition/modal Escape, Tab traversal, restoration,
parent refusal, outside press, compositor close, modal roles, centering and portal updates.
Six independent source mutations are rejected by explicit wrong-state oracles, with the
original source restored after each. The historical cascade fails the centering regression.
The existing gallery passes 119 assertions per scale and its 13 negative controls; the
measured run took 428 seconds. All 26 selected stable component captures match two fresh
main references byte for byte. The final binary passes the modal checks again; two accepted reader responses yield one
first answer, and header dragging moves through the compositor. Evidence is beside the
screenshots. Physical-session/Orca and vkms validation remain pending.

Settings tests need the complete fresh export: run both `scripts/export-tokens.mjs` and
`scripts/export-settings-data.mjs` into the same directory and pass `NK_SETTINGS_DATA`.
The gallery's token-only export is insufficient for Settings' manifest/page tests.

The #1133 focus review adds `[Delete, Keep]` with no declared default or cancel:
initial focus chooses Keep, and no safe enabled response leaves focus empty. The
old fallback is caught by the CPU regression (Delete != Keep). The updated nk-view
suite passes 199 tests; 14 targeted real-lib-atspi/keyboard checks at both scales
confirm initial Enter keeps the sample, while explicitly focusing Delete still permits
that response. These focused checks follow the initial 71-check modal matrix above.
