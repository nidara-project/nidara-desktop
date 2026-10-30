# Session IPC access (#959 A)

`nidara-access` is the shared Linux credential and consent policy for the Rust
session. Hyalo checks it before JSON socket effects; Config1 checks it on its
GLib store thread immediately before Set/Apply. It does not change the TS
Shell.Request interface or forward anything to TS.

Read state, open a shell surface, revoke control and reload the existing
configuration are public operations. Hyalo already watches those configuration
files, so public reload preserves nidara-wm/nidara-update without granting a new
configuration-write capability.
Other operations require `org.nidara.ai/allow-computer-control` or an installed
Nidara process authorized for that operation. External configuration writes
also require `allow-config-write`, captures `allow-screenshot`, and window
close `allow-window-close`. Missing schema/keys mean no permission. A bus name,
CLI name, argv, environment variable or script path never grants trust.

The explicit native executable roles are:

| Executable | Operations without external consent |
| --- | --- |
| `/usr/lib/nidara/nidara-settings-native` | configuration, native pin layout and app icons |
| `/usr/lib/nidara/nidara-settings` (dedicated TS host) | activate only a mapped native Wayland window belonging to its authenticated PID |
| `/usr/bin/nidara-sessiond` | configuration, power, night light |
| `/usr/bin/nidara-shell` (future Rust) | windows, close requests, minimize target rectangles, native pin layout and app icons |
| `/usr/bin/nidara-apps` (future native launcher) | native pin layout only (A1); no capture/windows/general config/spawn |
| `/usr/lib/nidara/nidara-shell` (existing dedicated TS host) | windows, close, minimize targets, configuration, capture, output layout, night light |

The installed dedicated TS shell and Settings hosts are explicit compatibility
exceptions; their existing Request/agent gates remain unchanged. Generic interpreters, other
GJS hosts and computer-use helpers do not gain this role.
A known path must match the running inode/device, and the file and every parent
must be root-owned, without group/world write permission or symlinks. Missing,
deleted or replaced executables cannot acquire trust. Checkout builds are external
unless explicitly registered by the administrator as described below. There is no
environment-based trust override. `nidara-hyalo msg` is deliberately
external: the compositor and CLI share an executable. Helpers hosted by GJS
(including native hosts which accept arbitrary JS), MCP and interpreters are
external too. Their non-sensitive reads remain available; protected actions
need consent. These rules must be retained when their Rust routes are added.

Unix socket peers use SO_PEERCRED; D-Bus calls use the unique sender from the
message header and GetConnectionCredentials, never a claimed well-known name.
A pidfd and open /proc directory pin the process lifetime. Config1 caches these
credentials by unique sender, invalidates on NameOwnerChanged and bounds its
cache to 256 clients; it does not repeat GetConnectionCredentials per slider
step. It never caches the executable role. Each protected
request rechecks liveness and executable identity; no cached privilege survives
exec, disconnect or PID reuse. Config1 has no SettingsNative-owner exception.
Hyalo watches GSettings on a private GLib thread and atomically publishes a
consent snapshot, initially denied; changes take effect when that thread
receives the backend notification, without blocking compositor frames.

Hyalo's classification is exhaustive over Request. New variants require a
policy choice. Do is protected even for spawn, quit and unknown/future actions. Spawn requires
external control; no current trusted role needs it. Public quit (including Do
quit) always denies: general computer control does not authorize ending the
session. Physical/internal shutdown paths remain separate;
its close and configuration actions retain their specific gates. Physical
keyboard/pointer bindings execute internally, outside the public socket ACL,
so window shortcuts and Super+Shift+P remain usable with control disabled.
A denial is `{"error":"AccessDenied: ...","code":"AccessDenied"}`, keeps the
connection usable, and has CLI exit status 1. Other legacy errors remain strings.
Config1 returns `org.nidara.Config1.Error.AccessDenied`; reads stay public.

This is cooperative consent within one Unix user, not a sandbox against hostile
same-UID programs (which can launch/inject into another program, edit their own
settings or exercise other desktop protocols). This block protects the Hyalo
JSON socket and Rust Config1 writes. **Wayland screencopy/image-copy-capture
remains outside this ACL by the owner's decision**; tools such as grim can still
capture through those protocols. Existing Display1 D-Bus transaction/lease
rules and other service interfaces are not replaced by this socket policy.
Do not claim screen capture is generally protected or that the installed TS
session has been migrated. Trusted installed executable acceptance requires an
installed-session check; checkout/headless tests alone do not prove it.

Development grants live only in `/etc/nidara/access.d/*.conf`. Format is one
`role<TAB>uid<TAB>/absolute/executable/path` per line; blank lines and lines
starting with `#` are ignored. Roles are `legacy-shell`, `legacy-settings`, `shell`, `settings` and `session`,
with exactly the permissions above. UID is decimal and applies only
to that Unix user. Paths are exact, with spaces allowed, no glob/alias/dot/dotdot
components, and no interpreter/script inference. The directory and its parents
must be root-owned, not group/world writable and not symlinks. Files must be
regular, root-owned, mode 0644, opened with O_NOFOLLOW. Reads are bounded to 32
files of 16 KiB each. Invalid/unsafe files or conflicting roles for one UID/path
fail closed. Directory enumeration uses an open directory fd, not a path that
can be substituted. The policy is reread per protected operation: deleting a
grant or changing its UID revokes it even on an existing peer connection.

An explicitly registered development executable may be writable by its UID,
but must be regular/executable, match the live inode/device and have no symlink
or ancestor writable by other users; ancestors belong to root or the registered
UID. This is an administrator's explicit grant to code that developer controls,
not a claim of isolation against the developer's own processes. Replacing or
deleting the running executable fails closed; restart that process after a build
which replaces it. Unknown paths, missing access.d, another UID or another
worktree remain External. Hyalo logs the denial and the registration command.

`install.sh --dev` and `--update-apply` invoke
`scripts/dev/register-ipc-access.py` to atomically replace only `dev-UID.conf`
after installing sessiond. They register this checkout's exact dedicated TS shell/Settings hosts,
release nk-settings and release sessiond paths, including paths not built yet.
The helper validates root directory/file ownership and modes without following
symlinks, writes/fsyncs an exclusive temporary file, sets 0644 and renames it.
It never follows a user HOME marker or environment variable as authorization.
`--print --repo PATH --uid UID` previews the file without root or writes.
Changing checkout via the dev installer replaces that user's grants; restart old
clients as part of switching the dev session. Packaged installs ship no dev
entries and use the built-in installed identities. This change does not run the
installer or update an existing machine's access.d automatically.

Local checks (no new CI job):

```
cargo test --manifest-path crates/nidara-access/Cargo.toml
cargo test --manifest-path session/Cargo.toml --test config
cargo test --manifest-path hyalo/Cargo.toml
scripts/dev/check-ipc-policy-headless.sh
scripts/dev/check-access-list-namespace.sh
```

B (typed Shell1/CLI routing), C (Rust OSD only), Applications1 and the Rust bar
are separate work. There is no OSD above ext-session-lock until the Rust lock
screen paints its own in step 2.

Current client inventory (source review, no live-session inspection):

| Client/source | IPC it sends | Required role |
| --- | --- | --- |
| TS `HyaloState.ts` | windows/workspaces/version/cursor reads; Do focus/workspace/move/minimize/float/tile/pseudo/pin/fullscreen/maximize/center/float-all/tile-all/set-workspace-mode/special/refocus-pointer/cursor-visible/set-cursor; minimize_targets; reload_config; screenshot | LegacyShell |
| TS `hyalo-settings.ts`, `hyalo-ipc.ts` | config/outputs/event_stream reads; settings patches (cursor/input/effects/etc.), night_light, set_output | LegacyShell (these modules execute in the shell) |
| sessiond `config/followers.rs`, `hyalo.rs` | config/events reads; cursor and idle settings patches; night_light | Session |
| sessiond Power1/brightness | power_info/events/cursor reads; power_lock, power_wake | Session |
| native Settings | Config1 Set/Apply; Display1 bus transaction methods (no direct JSON socket requests) | Settings for Config1 |
| display selector | Display1 bus Validate/Preview/Confirm/Cancel; no direct JSON socket requests | existing Display1 lease/transaction rules |
| legacy TS Settings (`ui/settings/app.ts`) | Do focus-window of its own mapped native Wayland window on relaunch | LegacySettings; PID from Wayland credentials must match IPC peer, never app-id/title/X11 PID |
| nidara-wm/nidara-update | ReloadConfig (or Do reload-config); manual DPMS | reload public as file watcher already reloads; DPMS needs consent |
| CLI, GJS helpers, MCP | any public entry they call | External (read or explicit consent) |

No client in this inventory needs public quit or Do spawn without consent.
The TS host is trusted only at its dedicated installed executable path, never
by the JS entry file, SettingsNative owner name or generic interpreter identity.

Applications1 A1 adds EditPins and AppIcon operations. External callers require
computer-control plus config-write for both, checked at the effect. The native
Launcher role is distinct from Shell and permits only EditPins in A1; A2 must
explicitly design/add its launch operation. `launcher` is accepted as an exact
dev-grant role, but no launcher grant or system entry is installed by A1. The
actual future launcher path must be registered explicitly when its binary ships.
See `session/daemon/src/applications/README.md`; no CLI/interpreter/bus-name trust.
