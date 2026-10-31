# nidara-ipc (#959 B)

Native Rust command-line client, built with the session workspace:

```sh
cargo build --manifest-path session/Cargo.toml --workspace --release --locked
nidara-ipc --session=rust listActions
```

Only exact `NIDARA_SESSION=rust` selects native routing. Unset or `ts` preserves
the installed TS route; any other environment value warns on stderr and selects TS:
`org.nidara.Shell /org/nidara/Shell org.nidara.Shell.Request(as) → s`, exact argv
and verbatim reply plus newline. One leading `--` remains accepted. The explicit
`--session=ts|rust` option wins over the environment without warning about an
unused environment value. An invalid explicit option still fails with usage exit 2. `HYALO_SOCKET` does not select Rust: the TS shell also uses Hyalo.
`scripts/dev/rust-session.sh` sets `NIDARA_SESSION=rust` and puts this checkout's
built CLI first on its private PATH. It rejects an old C-only installed client.

No service is auto-activated: D-Bus names resolve to a unique owner before a call.
No call is retried, no fallback sends a native command to TS, and a timeout never
implies that a mutation did not happen. D-Bus and socket replies have 15-second
deadlines; socket replies are bounded to 4 MiB. Exit 0 means a reply (TS retains
its historical textual-error semantics); native failures exit 1 and include
`AccessDenied`, `Unavailable`, `Invalid` or `Failed` on stderr. Success payloads
stay on stdout. CLI usage errors exit 2.

| Commands | Rust route |
| --- | --- |
| describeConfig, getConfig, setConfig | Config1 Describe/Get/Apply; type from authoritative schema; Apply returns revision/canonical value |
| setWallpaper (set-wallpaper), settingsWallpaper set/transition | Config1 wallpaper.current/transition; existing follower applies awww |
| listWindows/listWorkspaces, window/workspace actions, modes, reloadCompositor/reloadHyprland, screenshot | Hyalo socket; owner authenticates this CLI as External |
| toggleCC/NC/Prism/AppGrid/Overview/Player/Agent/About/BarOverlay and aliases, focusBar/Dock, setIsland, openSettings/toggleSettings/settingsPage/settingsApp | Typed Shell1, only with matching available capability |
| disableComputerControl | Local GSettings revocation only, always allowed; writes only false and syncs |
| listApps, launchApp | Applications1 catalogue/Search/Launch/GetLaunch; External caller, dispatch confirmation only |
| listActions | Native route catalogue, no service needed |
| dumpState | Live Hyalo state and Shell1 state/capabilities; absent renderer is available=false/state=null |

Window targets accept a hexadecimal address from listWindows, decimal Hyalo id,
or an unambiguous app/title substring. Ambiguity fails instead of choosing an
arbitrary window. Focus is read back before reporting success. Native window
lists retain the CLI's address/class/workspace/at/size shape. Workspaces retain
id/name/monitor/windows/active/special. Screenshot uses the focused output and
an absolute destination. Its default remains `/tmp/nidara-shot-…png`, preserving
the TS default in `ui/shell/app.ts`. `/tmp` can be tmpfs/RAM; callers needing a
persistent file should supply an absolute on-disk destination. Relative wallpaper paths are resolved in the caller;
file:// URIs remain accepted by Config1. Wallpaper transition then current are
two separate Apply calls: a later failure does not roll the transition back.
Omitting transition retains the current choice.

`listApps` lists visible launchable entries with full desktop IDs. `launchApp
<name-or-id> [--new-window|--action=ID|URI...]` prefers an exact case-preserved ID,
then its stem, then a unique Search/name match. Ambiguity asks for an exact ID.
It keeps the original authenticated process alive while waiting at most 12 s
for dispatch, never for a window or focus. JSON success explicitly leaves
windowConfirmed/focusConfirmed false. An ambiguous timeout never retries.
See `session/daemon/src/applications/A2.md` for launch policy and limitations.

Wallpaper preview is Unavailable: no ephemeral follower API exists, and no config write simulates it.
queryUI, widgetCatalog, settingsMonitor, takeNetworkCancel, agentNewConversation,
notifyComputerAction, agentPointer, yieldInput, openWindowMenu, hideForLock,
showAfterLock, toggleGroup, moveWindowOutOfGroup and setLayout are explicitly
Unavailable. There is no generic dispatch escape hatch. Helpers/MCP are not
promised fully operational in Rust by this change; their specific migrations
remain separate. A capability lacking a renderer fails, rather than inventing
closed surface state. `dumpState` is a native snapshot, not a promise of the full
TS diagnostic/assistant schema. No production Shell1 server is started in B.

`nidara-ipc` gets no trusted role. Hyalo and Config1 enforce computer-control,
config-write, screenshot and window-close gates from A at the point of effect.
The common policy remains cooperative consent within the same UID. **Wayland
screencopy/image-copy-capture is outside this ACL**; this does not generally
protect screenshots by other protocols. No installation, access.d change or
live-session validation is performed by these checks.

Install.sh and PKGBUILD build/install the Rust binary from session/target/release.
The old `bin/nidara-ipc.c` is retained solely for the unchanged legacy TS headless
smoke fixture, which still compiles it; neither installation path uses it.
Retiring that fixture-only C copy needs a separately queued follow-up; do not
remove it while headless-smoke still depends on it.

Local validation, no new CI job:

```sh
cargo test --manifest-path session/Cargo.toml -p nidara-ipc --locked
cargo clippy --manifest-path session/Cargo.toml -p nidara-ipc --all-targets --locked -- -D warnings
cargo build --manifest-path session/Cargo.toml --workspace --locked
cargo build --manifest-path hyalo/Cargo.toml --locked
scripts/dev/check-shell-ipc-headless.sh
```

The integration tests create private D-Bus daemons and sockets. The headless
check runs real Hyalo and Config1 inside cage with private HOME, runtime, bus,
keyfile settings and a nonexistent system bus. It tests grant/revoke and the
specific gates, workspace readback and a PNG; logs stay in target/shell-ipc.
This is not installed or live-session acceptance, hardware or accessibility QA.

Startup spot-check (2026-10-30, this machine, release build, private bus/fake TS
Request handler, 100 measured invocations after five warmups): median C 2.853 ms,
Rust 3.270 ms. This checks the keybind client overhead, not live-session latency.

## Installed TS-session acceptance (pending, before merge)

Both installation paths replace the daily C client. Private/fake-service checks
do not validate that installed transition. After an explicitly authorized
installation, the owner should check in the real TS shell session:

1. Super+C, Super+N, Super+Space and Super+S still open/close their expected
   surfaces/settings. Super+Ctrl+B/D still move keyboard focus correctly.
2. With NIDARA_SESSION unset (or ts), `nidara-ipc dumpState` and
   `nidara-ipc listActions` preserve the TS replies and exit successfully.
3. `NIDARA_SESSION=typo nidara-ipc listActions` warns on stderr and returns the
   same TS action list; `nidara-ipc --session=typo listActions` exits 2 without
   dispatch. Exact rust continues to select native routes.
4. During an owner-controlled shell-down test, a TS request exits 1 with
   Unavailable rather than activating/retrying another shell. This document
   does not authorize stopping the daily shell or installing the client.

No installed/live-session result has been obtained for B yet; carry this
acceptance status and checklist into its PR description.
