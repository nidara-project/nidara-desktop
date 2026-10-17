# Layer-motion sampling investigation (#843)

Base: `95da1139799c44d75902775e543404e90556c882`.

| Historical run | Artifact evidence | Diagnosis |
| --- | --- | --- |
| [38818225572](https://github.com/nidara-project/nidara-desktop/actions/runs/38818225572) | `scale1-retarget/spring-2`: A x=407..486; `retarget-immediate`: x=372..451; `retarget-velocity`: x=55..134. Client records `RETARGETED`, `CANCELLED 1`, `CANCELLED 2`. | The old screenshot velocity oracle sampled after the turn. These images do not date the retarget, so they cannot establish a lost-velocity bug. Current main already uses the deterministic `a_retargeted_spring_keeps_where_it_is_and_its_velocity` unit test for velocity, preserving the end-to-end position/cancellation/done checks. |
| [38835525070](https://github.com/nidara-project/nidara-desktop/actions/runs/38835525070) | `scale1-cursor/cursor-during-0`: green x=127..226, y=118..141. Exact run source samples window y+75 (116 physical), above the popup. IME log ends in `RECT 95 63 3 14`. | A probe coordinate error after candidates moved below the caret, already corrected on main to y+90. Neither missing delivery nor a vanished layer: both are in the uploaded image. |
| [38848709591](https://github.com/nidara-project/nidara-desktop/actions/runs/38848709591) | `cursor-during-1`: solid A width 93 physical px at scale 1; final IME record `RECT 144 62 4 16`. The old expression compares height 16 against 12*(93/80)=13.95 with tolerance 2. | Probe geometry error: integer scanline width and outward-rounded rectangle are different measurements. Main's #841 bounds account for edge sampling and outward rounding. The archived unsequenced IME log cannot prove that its final record belongs to that exact screenshot. |
| [38981448009](https://github.com/nidara-project/nidara-desktop/actions/runs/38981448009) | `scale1/during-3`: A x=189..268, y=81..140. Requested click is its centre (228.5,111), delivered as `PRESS WINDOW 196.500 70.000` (window origin 32,41). `AWAKE PAINTS 3 3` confirms the client did not paint during the block. | **Not yet classified.** Archived logs have no capture/dispatch timestamps. A stale capture is plausible, but a real hit-test defect cannot be excluded from this artifact alone. The draft adds test-session capture/input timing and layer hit-test traces to distinguish them. |

The three older failures are not evidence of three new compositor defects. Their exact source revisions and pictures must be read together. No threshold is relaxed, no scale omitted, and no action retried.

The issue remains open until five consecutive green `hyalo` job attempts at one head are linked, including all preceding red attempts. Diagnostics alone do not meet that gate.
