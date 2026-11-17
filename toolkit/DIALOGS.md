# Dialog and alert, #1103 step 6

Owner authorized implementation in the Codex chat on 2026-11-17. Base: main2dcda568.
This records the contract before implementation; acceptance evidence will be appended.

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
alert's default. Restore the original key only if it remains shown/enabled and the same
retained component instance; cancellation/error must also retire the modal namespace.

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
  The owner is being asked about an explicit declaration, not a consent implementation.

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
Alert message is its description. Buttons keep complete localized names and declared
risk. Look/reduced-motion changes reach both windows; there is no nested glass pane for
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
