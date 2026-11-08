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

## Package-profile before/after (Papirus, software Hyalo)

Use the PKGBUILD options: stable `cargo build --release --locked --offline`,
`audio-native` for sessiond and release Hyalo (`--frozen --release`); both
manifests retain their release `line-tables-only` debug information. Baseline is
main `1028c79a` plus measurement hooks only; after is `c0205141`. Each checkout
has its own target directories. Alternate two cold before/after runs with the
same theme, copied catalogue, typed layout, exports and compositor. Cold means
new processes, not flushed kernel caches. These are client-buffer times; they
are not hardware presentation or installed-session acceptance.

| Measurement | Before, two runs | After, two runs |
|---|---:|---:|
| Dock first commit → complete 10-icon batch | 2878.795–2898.307 ms | 70.880–74.083 ms |
| Apps open → complete visible batch | 1703.534–1712.663 ms | 190.757–195.230 ms |
| Apps reopen → complete visible batch | 474.519–476.864 ms | 120.983–127.179 ms |
| Apps cold GetIcon, including prefetch | 30 | 24 |
| Apps reopen GetIcon | 30 | 0 |
| Apps first visible client buffer | 0/18 ready | 18/18 ready |

Direct Cage captures after the frame callback confirm art in all 18 cold/warm
icon rectangles. Report pixel-confirmation time separately: the checker includes
a deliberate 300 ms prefetch settle and screenshot/check overhead. It does not
add that delay to buffer-submission measurements.

### Where Apps spends time

The second release after-run opens cold in 195.230 ms. Sorting 105 catalogue
records takes 0.031 ms; starting workers 0.030 ms; the layer reaches configure in
5.042 ms. Appearance loading takes 113.336 ms. The 24 concurrent calls include
at most 25.927 ms resolving a path, 1.737 ms decoding, 1.096 ms dispatching to a
blocking worker, 0.038 ms reading published metadata and 0.017 ms validating and
constructing the reply. Decode permits take at most 0.001 ms; no Busy occurs.
Stages overlap across workers; they are not additive wall-clock components.
The first complete paint starts at 184.888 ms, takes 9.909 ms and is committed
at 195.230 ms. Earlier commits are transparent, including their material.

Warm reopen takes 127.179 ms: sort 0.057 ms, worker startup 0.019 ms, configure
starts at 2.441 ms, appearance 113.413 ms, then paint 9.082 ms (content 7.701,
canvas finish 1.038). There is no new GetApps call or icon RPC. This attributes
the remaining cost to appearance and paint, not an assumed 400 ms cost to create
a Wayland layer. Keeping Apps alive or changing its lifetime is outside this
change. Appearance's internal operations are not split further by these spans.

### Refresh-overlap and daemon-warm controls

`NK_ICON_REFRESH_PROBE=1` touches a private copied desktop entry before Apps.
The release baseline's refresh occupies 1288.863 ms and Apps needs 1518.273 ms.
After the correction, a 1342.236 ms refresh still runs from 151.003 ms before
Apps until 1191.233 ms after opening, yet the complete Apps buffer is submitted
at 191.086 ms while that refresh remains busy. Metadata reads take at most
0.039 ms and final checks/reply construction 0.030 ms. Reopen remains 125.789 ms,
zero GetIcon. No shortening of the two-second fallback policy is needed to remove
this queue delay; the normal visible batch completes well before that limit.

A new shell must still hydrate its catalogue. In the ordinary end-of-scenario
restart, baseline measures 142.146–155.604 ms and after 327.065–328.058 ms.
The latter has 22 daemon hits, zero misses, and its catalogue reaches the client
only 303.769 ms after the first dock commit. Faster earlier Apps steps restart
the shell in a different background-refresh phase; this row cannot be presented
as an unconditional daemon-warm speedup. `NK_ICON_RESTART_QUIET=1` instead triggers
and waits for an explicit private refresh before restarting both versions:
154.457 ms before, 43.679 ms after, again 22 hits/zero misses. GetSnapshot/initial
catalogue hydration can still wait on the actor; this change bypasses that queue
only for valid icon reads, not usage/window/launch/catalogue APIs.

Release evidence: `release-before-{1,2}`, `release-after-{1,2}`, the refresh and
quiet controls, `release-summary.json`, baseline instrumentation patch and binary
hashes. The complete release bar/dock/CC B2.2 graphical checker passes. The native
held-actor tests and negative queued-check control separately prevent the icon
read contention from returning. No compilation overlaps a graphical measurement.

## Diagnostic debug measurements (superseded for package latency)

The following historical comparison uses unoptimized dev binaries, not the
PKGBUILD profile. Keep it for diagnosis only; the package-profile section above supplies the PR's performance claims.

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

## Notification artwork (B3.1)

The banner card is another consumer of this same memory. App art first uses
`current_app` for desktop-entry or one unambiguous registry match, then the
non-generic declared name, then a neutral glyph. Generic placeholders never
replace a registry icon. Thumbnail and absolute-path app art use `Key::Image`
(namespace, content generation, path, side): replacing a file in place must not
reuse its old pixels. These keys use the existing eight workers, size checks,
64 MiB budget and interest/LRU eviction; cards own only shared Asset references.
No disk cache, independent image loader or per-notification worker pool is added.
