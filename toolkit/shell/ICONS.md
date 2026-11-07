# Shared application icon memory (#1041)

`icon_memory::Memory` owns decoded app/place and themed tray assets in the shell
process. Dock and Apps/search request keys and keep shared `Arc<Raster>`
references. Tray descriptors reuse unambiguous application artwork or ask the
same memory for themed/pixmap assets. `cycle.rs` currently selects windows without
painting icons. Native Notification Center and desktop/login surfaces are still
missing; this component is their app-icon API. Interface glyphs and album/window
pictures are different resources. No artwork or theme has changed.

Install once after connecting Applications1; subscribe with an RAII callback,
request keys, query readiness, and paint shared assets. Never add a surface-local
GetIcon connection/worker, filesystem resolver or decoded image cache. Application
keys include unique owner, epoch, icon revision, identity/generation, logical size
and scale. A larger texture can serve a smaller size of the same identity. Owner,
theme/revision or generation changes retire old keys and in-flight responses.
Themed tray keys include the local theme revision; pixmap keys include unique
owner, handle, generation and tray snapshot revision. Ambiguous desktop RawIcon
names do not select an arbitrary application.

The normative limits, retry and first-presentation rules are in
[`APPLICATIONS1-DOCK.md`](../../session/design/APPLICATIONS1-DOCK.md#3-catalogue-search-and-icons).
The resident budget is not a whole-process RSS ceiling: current frames can pin
shared assets after eviction, and workers temporarily hold decode buffers. Theme
SVG/raster decoding has the same source/output bounds and rejects external SVG
resources. UI callbacks never decode or wait on D-Bus. Busy retries remain
pending; abandoned retries pause and resume when requested. Terminal absence
and startup timeout use Applications1's existing neutral fallback SVG, shared
once; Trash retains its existing themed/symbol fallback.

The daemon caches resolved paths and rendered pixels after validated reads, with
post-decode stale checks. Publication retires obsolete catalogue generations.
An old decode cannot enter the new namespace or revive a removed app. Cache hits
need no decode permit. Both metadata validation and post-decode freshness use
`session/daemon/src/applications/icon_view.rs`, an immutable committed view. A full
catalogue refresh keeps the previous view available while it traverses disk;
GetIcon, Trash and place reads never queue behind it. New metadata is published
before an actor effect is acknowledged. Managed override writes withdraw the
view before changing files and republish on success or error; concurrent reads
receive Busy. Actor exit retires the view with Unavailable. A captured old Arc
cannot make the final epoch/revision/generation/membership check pass. The
published view holds catalogue metadata in addition to the pixel LRU budget;
readers share it by Arc. It is not a usage/window/launch snapshot. Neither layer has a disk cache: measured process-local
reuse removes reopen traffic without one.

## Reproduce the measurement

Run `check-icons-headless.sh` with `NK_ICON_OWNER_FIXTURE` pointing to JSON with
`theme` and serialized typed dock `layout`, plus `NK_SESSIOND_BIN`, `NK_DOCK_BIN`,
`HYALO_BIN`, `NK_SETTINGS_DATA` and `NK_WIDGETS_LOG`. `NK_ICON_ASSERT=1` requires
complete first visible batches and zero GetIcon on warm Apps reopen. This is a
private bus, catalogue and settings database under software Hyalo, using copies
of installed desktop entries and the real theme. It does not alter the owner's
session. Do not compile concurrently with graphical checks.

`NK_ICON_METRICS=1` emits request/response, open and committed-frame events;
`ICON_DAEMON_METRIC` distinguishes cached reads from decode misses. Cold means
new processes/empty application caches, not flushed kernel disk caches. A new
shell with the same daemon measures daemon reuse separately. Raw first commits
can be transparent while the initial batch waits; reports separately count the
first visible client frame. Material declaration follows the buffer actually
painted, not a readiness value that can change after paint. Open-to-last includes
scheduling and buffer submission, not just decoder execution. Software Hyalo
does not emit presentation-time feedback: captures therefore wait for the frame
callback, capture Cage directly (no late IPC overwrite), and check visible pixels
in every icon rectangle. Pixel-confirmation time includes capture/check overhead
and is reported separately. Record sample variation instead of treating one
software-rendered run as installed-session acceptance.

Before/after evidence and exact results accompany this change. Hardware/live
session timing and visual acceptance remain separate; no installation, CI or
owner-session configuration is part of #1041.

## Diagnostic debug measurements (superseded for package latency)

The following historical comparison uses unoptimized dev binaries, not the
PKGBUILD profile. Keep it for diagnosis only; release measurements are required
for the PR's performance claims.

Base main `1028c79a`, installed catalogue copied into private state, owner's typed
pin layout. Baseline `baseline-2` uses the original serial loaders plus opt-in
measurement hooks. Final samples `after-6`/`after-7` use the implementation here;
`after-7` additionally uses direct Cage captures. No kernel caches were flushed.

| Measurement | Before | After (two final runs) |
|---|---:|---:|
| Dock first commit → complete 10-icon batch | 2971.750 ms | 198.589–208.969 ms |
| Apps open → complete visible batch | 2503.448 ms | 2179.932–2186.527 ms |
| Apps reopen → complete visible batch | 1017.478 ms | 395.955–403.069 ms |
| Apps reopen GetIcon | 30 | 0 |
| Apps first visible frame | 0/18 ready | 18/18 ready |
| New shell, same daemon: dock batch | 356.444 ms | 142.194–155.533 ms |

Both final daemon-warm samples have 22 hits and zero decode misses. Apps cold
requests fall from 30 to 24 including prefetch; some art already belongs to the
dock. The final direct captures confirm all 18 rectangles in cold/warm Apps;
confirmation takes 2587.860/757.202 ms, including screenshot overhead. Early
provisional readiness-only measurements understated Apps presentation and are
superseded by these final samples. This is not installed/hardware acceptance.

Validation: 152 shell tests, Clippy with warnings denied for shell/daemon, daemon
unit and private-bus integration suites, and the complete bar/dock/CC B2.2 checker.
One unrelated pre-existing unit test embeds the checkout path in its Unix socket
and exceeds SUN_LEN here (`config::followers::tests::output_notifications_do_not_reset_the_persisted_cursor`);
the full attempt records that failure, then 112 unit tests pass with that exact
test filtered out. Applications1 A1/A2/A3, Bluetooth, Config1, Network1, native
startup and Tray1 integrations pass. Negative controls detect Busy classified as
absence, loss of cross-surface reuse, daemon cache bypass and an output without
Apps icon pixels. Positive tests cover coalescing, eight-worker bound, generation
and owner retirement, paused-queue saturation, ambiguity, LRU budgets and bounded
SVG decoding. No CI/configuration or session changes accompany this work.

## Apps latency diagnosis and catalogue contention

Opt-in `apps-stage`, `icon-fetch`/`icon-convert`, `ICON_DAEMON_DETAIL` and
`ICON_DAEMON_ASSET` events split catalogue sort, layer/configure, appearance,
paint, resolver, decoder, permits, blocking queue, metadata and final freshness.
Stage spans overlap; do not sum concurrent worker durations as wall-clock time.

The debug diagnostic reproduced 2167 ms cold and 380 ms warm. The largest
individual decode was a 23.6 KiB Chrome-PWA PNG at 46.6 ms, not a giant Papirus
SVG; the next PNG was 43.8 ms, Papirus SVGs at most 12.8 ms. Permit acquisition
was at most 1 microsecond, blocking dispatch 0.266 ms and renderer conversion
1.02 ms; no Busy occurred. Several GetIcon replies instead waited 1.61 s for
Store or its final freshness check. A full refresh measured 1696 ms, including
1633 ms auditing catalogue icon paths. These are debug figures, not package costs.

`NK_ICON_REFRESH_PROBE=1` touches only a copied private desktop entry and opens
Apps during its refresh. In the pre-fix control the exact same refresh ran from
151 ms before Apps to 1463 ms after it, and a metadata read waited 1332 ms.
Another unforced run without that wait opened in 565 ms. This establishes actor
contention separately from decoding speed. The native endpoint regression tests
hold the actor queue unserviced: cached app/place/Trash reads with zero available
decode permits, and a cold decode, must finish before that barrier is released.
Putting only the final freshness check back on the queue makes both tests fail.

During startup the current policy keeps content and material transparent until
the visible batch is ready, bounded at two seconds before neutral fallback.
It does not guarantee immediate visual feedback if icon acquisition stalls;
the first complete buffer also costs paint/submission time after that deadline.
No new partial-batch policy or persistent hidden Apps layer is introduced here.
In the debug warm sample, about 128 ms loads appearance, 126 ms builds content
and 123 ms finishes the CPU canvas; catalogue sorting is below 0.1 ms and there
is no GetApps RPC on reopen. Release results, rather than those unoptimized
costs, determine the remaining user-visible limitation.
