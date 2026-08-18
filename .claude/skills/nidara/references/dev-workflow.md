# Nidara — Dev workflow, installer, persistence, keybinds

Read this when running the installer, debugging a reload that won't take, looking for where a setting is persisted, or adding a new keybind.

## Installer (`install.sh`)

Arch-only provisioning. Three modes:

- **`--system` (default):** installs Nidara **as a pacman package** (§6): it tries the prebuilt `nidara` package from the `[nidara]` repo — only when the tree IS the release it was built from (clean checkout of the `v$VERSION` tag, or a git-less release tarball) and with a version==VERSION lockstep guard — and on ANY miss (repo down, repo lagging the release, non-release tree) it builds the **same** `packaging/nidara/PKGBUILD` locally: the working tree is packed as the tarball makepkg expects (uncommitted changes included — the escape hatch installs what's here) and `pacman -U`'d. Either way **every installed file is pacman-owned** (upgradeable, removable, `pacman -Qo`-visible); `--overwrite '*'` hands over files that script-era installs wrote untracked into /usr, and known orphans (ags-v3 tree, crystal-shell theme, wallpaper.png, misplaced portal .conf) are cleaned explicitly. First-time setup then runs via `nidara-setup` (below). It keeps **no** persistent source copy and **migrates away** any legacy `~/.local/share/nidara/src` + `.source` from the old per-user model; the user's original download is disposable. **Release channel:** on a clean `main` checkout with `v*` tags available, it jumps to the newest tag and re-execs itself from there, so fresh installs get the latest release (never an unlabelled main snapshot that the first update would silently downgrade). Dirty trees, other branches/commits, and `--dev` are deliberate opt-outs; before the first release exists it's a no-op.
- **`--dev`:** installs system binaries **and** writes `~/.config/nidara/.dev` pointing at the source tree. The UI launcher will then `ags run app.ts` from source instead of running the bundle. Registers the developer's own clone in `.source` (no managed copy). Dev installs keep the **direct-copy** flow (§5 build + §6 copies into /usr) — and **remove the `nidara` package first if present**, so a later `pacman -Syu` can't clobber the dev copies (this also makes the dev↔system toggle safe: going back to system reinstalls the package fresh). **Honours the pin-skip too:** re-running `./install.sh --dev` skips the pacman + Astal/AGS/appmenu rebuild when `/usr/share/nidara/pins` already match this script's pins (only a *positive* match skips — a missing pins file means a fresh machine, so it still builds). So iterating on the shell doesn't recompile Astal. Note you usually don't need to re-run it at all for UI changes — the shell runs from source, so Super+Shift+R reload suffices; re-run only when you touch system files (`bin/`, `config/`, portals, `.desktop`) or the install flow.
- **`nidara-setup`** (`/usr/bin/nidara-setup`): the idempotent first-time/system setup that *packaging can't do* — GI env in `/etc/environment`, per-user config seeding under `~/.config/nidara` plus a default `~/.config/kitty/` (never overwrites), uwsm env files + NVIDIA autodetect, greetd/DM setup (only when recognizably ours or no DM at all), service enablement (pipewire/wireplumber user units, power-profiles-daemon, bluetooth). System-environment detection (keyboard layout / timezone / locale) lives here too, next to its consumers. Reads payloads from `/usr/share/nidara/{defaults,config}` — shipped identically by the nidara package and by install.sh §6, so it behaves the same after `pacman -S nidara` and after a script install. Called by install.sh §7 and by `nidara-update`'s package path; a pacman-only user runs it once by hand: `sudo pacman -S nidara && nidara-setup`. (The old `--dev-repo` flag is gone — it symlinked hypridle.conf into the dev repo, but Settings → Power writes that file now, so UI changes were dirtying the repo working tree; it's seeded as a per-user copy like everything else, with a migration that preserves the old link's content. Idle-suspend default: the hypridle.conf seed gets a 30-min suspend listener appended ONLY when a battery is present — desktops default to never; Settings → Power overrides either way.) **`--user` mode = the first-login bootstrap** (issue #23): runs ONLY the per-user steps (config seeding incl. `.mcp.json`, uwsm env + NVIDIA autodetect, user services) and never touches sudo. `bin/nidara` (the session entry) invokes it at session start whenever `~/.config/nidara` is missing — so a user created AFTER install time (Settings → Users, `useradd`, archinstall, Calamares) gets seeded on first login, before Hyprland loads its config, and a deleted config dir self-heals. Fail-soft by design (`|| true`, log at `${XDG_RUNTIME_DIR:-/tmp}/nidara-first-login.log`): a seeding hiccup must never block the session. GTK/dconf theming for that new user then converges at shell boot (ThemeManager reconciles appearance.json → settings.ini + gsettings).
- **`nidara-update`** (`/usr/bin/nidara-update`): three paths, tried in order.
  **Dev** — a dev install updates from its own registered clone (`.dev`/`.source`): `nidara-update` hands over to `install.sh --update`, which refuses on a dirty tree, fetches, fast-forwards the dev branch, then re-execs `--update-apply`.
  **Package** (system installs since the packaging switch) — when `pacman -Qq nidara` says the package is installed, the update is just `sudo pacman -Syu` (interactive on purpose: it's a full system upgrade) — the `[nidara]` repo serves new releases — followed by `nidara-setup` (re-applies the idempotent setup: new config seeds, greetd refresh, new services) and, only if the package version actually changed, a `nidara.service` restart plus one `hyprctl reload` — the package replace of `/usr/share/nidara/config/hypr/hyprland.lua` kills Hyprland's inode-based config watch mid-extract and leaves a stuck "cannot open … hyprland.lua" banner otherwise (install.sh §6 does the same reload after its package install, covering the handoff/rerun cases; both gated on `HYPRLAND_INSTANCE_SIGNATURE`). **No git anywhere.** This path deliberately sits AFTER the `.patches` guard: a patched install is a locally built package, and a blind `-Syu` would silently replace it with pure upstream.
  **Stateless (script-era installs)** — resolves the newest `v*` release tag on the remote with `git ls-remote`, shallow-clones just that tag (`--depth 1`) into a throwaway temp dir under `~/.cache/nidara/`, runs that clone's `install.sh --update-apply`, deletes the temp. Running this once on a pre-package install **migrates it to the package** (the clone's §6 installs nidara as a package, `--overwrite` takes over the untracked files), so every later update takes the package path.
  The apply pass behaves like `--system` but (a) writes **no** source marker, and (b) skips pacman + the Astal/AGS/appmenu rebuild when the pins (`/usr/share/nidara/pins`) match. It restarts `nidara.service` at the end. Settings → About checks the latest GitHub release and shows an update row (silent if the API is unreachable). **Carried local patches:** if `~/.config/nidara/.patches` exists (an agent keeps not-contributed repo fixes for this user — clone path inside; see `agent-contribution.md`, "Carrying a GLOBAL fix locally"), `nidara-update` refuses both blind paths and defers to the agent's flow (rebase `local/patches` onto the new tag → `install.sh --update-apply`, which builds a local package from the patched tree); `install.sh --update` likewise refuses to `checkout` a release over local-only commits instead of silently dropping them.

### Pinned upstreams

These are bumped + clean-install-tested before tagging:

- `ASTAL_REF` — commit SHA, no tags
- `AGS_REF` — tag (e.g. `v3.1.2`)
- `APPMENU_REF` — commit

**Pins live in TWO places (permanent lockstep):** the same three refs also live in
`nidara-project/nidara-repo`'s `pins.env`. Bump **both** together. This does **not** go away
now that install.sh consumes the repo (below): install.sh keeps its `*_REF` for the
from-source fallback and the update pin-skip record, so the two must stay in sync.

### Binary repo (`nidara-repo`) — consumed by install.sh (source build = fallback)

`github.com/nidara-project/nidara-repo` (public) is a **pacman binary repository** that
ships pre-built copies of exactly the 18 packages `install.sh` would otherwise build from
source (appmenu + 16 Astal libs + ags). CI builds them in an Arch container and publishes to
GitHub Pages: `https://nidara-project.github.io/nidara-repo/$arch` (pacman repo name
`nidara`, **GPG-signed since 2026-07-05**: every package + the repo db are signed in CI;
clients use `SigLevel = Required DatabaseOptional`, and `install.sh` imports + lsigns the
public key bundled at `packaging/nidara-repo.gpg` — it also migrates unsigned-era installs
away from `Optional TrustAll`, in an unconditional block that runs even when phase 1 is
pin-skipped). The committed
PKGBUILDs there are generated from `pins.env` by `scripts/gen-pkgbuilds.sh`; their
`build()`/`package()` are lifted verbatim from `install.sh`'s §2/§4 generators, but their
**`makedepends` deliberately are NOT** — see the box below. Since the packaging switch it also ships
**`nidara` itself**: `build-repo.sh` builds it LAST (the dep loop just installed the whole
stack into the build host) from the release tag pinned by `NIDARA_REF` in `pins.env`, using
the PKGBUILD found INSIDE that tag's tarball (`packaging/nidara/`) — the recipe travels with
the release, so it can never drift from the tree it packages, and a lockstep gate refuses to
publish if tag / `VERSION` / `pkgver` disagree.

**The build toolchain there is DERIVED from the makedepends (2026-08-12), so
`packaging/nidara/PKGBUILD`'s `makedepends` is load-bearing.** `build-repo.sh` runs
`makepkg --nodeps` on purpose — the chain `pacman -U`s each package into the build host, so
makepkg must not resolve anything — which means *nothing* installs a package's build deps for
it. That job used to belong to a hand-typed list in the workflow, and it drifted in silence:
`hyprland-protocols` was declared correctly here and missing there, so v0.7.0 (the first
release to generate Wayland protocol glue) died on
`missing protocol: …/hyprland-focus-grab-v1.xml`. Now `nidara-repo/scripts/build-deps.sh`
unions the `makedepends` of every PKGBUILD it builds — including this one, read out of the
release tag — so **anything `build()` reaches for must be named in `makedepends` or it will
not exist in the build container**. `install.sh`'s own generators keep a minimal list on
purpose (§1's `pacman -S` ran first); the authoritative per-lib lists live in that repo's
`gen-pkgbuilds.sh`, derived from each lib's `meson.build` at the pinned revision.

**A clean-install VM does not cover this, by construction** — there the deps arrive with the
rest of the system. The two test beds are complementary: the VM proves the installer on a
virgin box, the build container proves the dependency chain. nidara-repo builds pull requests
now (unsigned, no publish) precisely so that chain can be proven before it lands.

**Status (validated E2E in a clean VM, 2026-06-21):** `install.sh` §1 registers `[nidara]`
in `/etc/pacman.conf` (idempotent) and `pacman -S`'s the 18 packages **explicitly** —
`aylurs-gtk-shell` only depends on `astal-gjs`+`gjs` and every `libastal-*` declares
`depends=()`, so dep resolution alone won't pull the stack. After `pacman -S` a
**lockstep guard** verifies the installed versions actually encode this script's pins
(Astal/appmenu pkgver = `r<sha7>`, ags = the tag) — because a repo that lags a pin bump
makes `pacman -S` "succeed" with STALE versions, which the source fallback would never
catch on its own. Only on a clean match does it set `DEPS_FROM_REPO=yes` so §2 (Astal) +
§4 (AGS) skip their from-source build. **Any repo miss** (down, missing package, or the
version guard failing) leaves `DEPS_FROM_REPO=no` and falls through to the source build —
the installer still succeeds, just slower. That fallback is exactly why install.sh keeps
its own `*_REF` pins (also recorded to `PINS_FILE` for the update pin-skip). Both branches
validated E2E in a clean VM (repo current → "pins verified" skip; pin bump the repo hadn't
caught up to → guard WARN → source build). See tech-debt #21 and `packaging/README.md`.

### Install steps (in order)

1. `pacman` deps (also registers `[nidara]` in `pacman.conf`).
2. Install the Astal stack from `nidara-repo` (prebuilt). **Fallback** (repo down/incomplete) builds from source: `io`, `quarrel`, `gtk4`, `auth`, `lang/gjs`. Everything else has been absorbed into `core/` — see the Astal row in `architecture.md`; `appmenu-glib-translator` left with `libastal-tray` on 2026-08-18.
3. The `ags` CLI (`aylurs-gtk-shell`) — same: from `nidara-repo`, else source.
4. Build — **dev-like installs only**: `npm install` + SCSS compile + `ags bundle` × 3 (shell, greeter, lockscreen). System installs skip this: the build happens inside makepkg (or comes prebuilt).
5. Install system files — **system**: the nidara *package* (prebuilt from nidara-repo, else local makepkg — see `--system` above). **Dev**: direct copies of binaries/configs/session entry/portals into /usr (package removed first). Pins recorded either way (untracked installer bookkeeping).
6. First-time setup via **`nidara-setup`** (see above): seeds `~/.config/nidara/` (**never overwrites existing user config**), uwsm env + NVIDIA, greetd (**only if recognizably ours or no other DM is enabled**), enables pipewire/wireplumber (user), power-profiles-daemon + bluetooth (system). install.sh itself only writes the install-mode markers (`.dev`/`.source`).

### Detection (no questions asked)

`nidara-setup` detects from the existing Arch install (never asks):
- keyboard layout (`vconsole` → XKB)
- timezone
- locale

### Install targets

- `/usr/bin/{nidara, nidara-ui, nidara-greeter, nidara-lock, nidara-game-mode, nidara-setup, nidara-update, …}`
- `/usr/share/nidara/` — configs, bundles, `VERSION`, wallpaper, plus the setup payloads `defaults/` (minus wallpaper) and `config/greetd/` that `nidara-setup` reads — same layout whether shipped by the package or by install.sh §6
- `/usr/share/themes/nidara/gtk-4.0/gtk.css` — the greeter's **blank** GTK4 theme (zero rules). The greeter starts with `GTK_THEME=nidara` so only its own app CSS applies; **GTK silently falls back to Adwaita if this theme isn't on disk** (a real bite — the install step was missing post-rename). The step also `rm -rf`s the pre-rename `crystal-shell` orphan. Source: `ui/greeter/theme/gtk.css`.
- `/usr/share/wayland-sessions/nidara.desktop`
- `/usr/share/applications/`
- XDG portal config

User config always under `~/.config/nidara/`.

### ⚠️ Anything the installer creates in the user's HOME must be chowned — ancestors included

The installer runs under `sudo`, so every `mkdir -p` into `$REAL_HOME` creates the
**missing parents as root**, and a root-owned dir in the user's home breaks whatever the
user's own session writes there — silently, because the writers swallow the error.

Both known cases are fixed and both live in **`bin/nidara-setup`**, side by side (one
implementation, so the package hook and `nidara-update` repair it too, not just `install.sh`):

- `~/.config` — root-owned meant no `gtk-{3,4}.0` (icon theme + dark never reached GTK apps),
  no `dconf`, no `user-dirs.dirs` (clean-install bugs 1/2/4, VM 06-22).
- `~/.cache` + `~/.cache/nidara` — created by the installer's package build cache
  (`~/.cache/nidara/pkgbuild`, three `mkdir` sites in `install.sh`, all now via
  `ensure_pkg_cache`). Root-owned meant Astal couldn't cache frequents (dock/app-grid
  ordering never persisted), no album-art cache, and **`nidara-update` couldn't create its
  work dir** — an mktemp inside `~/.cache/nidara` — so the update path was broken on a fresh
  install (VM sweep 08-10).

The failing condition is a **first** install on a machine where the dir doesn't exist yet,
and once poisoned a rerun looks fine — so it only ever shows up on a virgin VM base. When
adding an installer path that writes into the home, chown the dir **and its parents**.

### Asset resolution — `SHELL_ROOT`, never the config dir

Code-shipped assets (icons in `assets/icons/`, `style.css`) resolve ONLY against
`SHELL_ROOT` (`core/Paths.ts` = `$NIDARA_SHELL_ROOT`, set by `bin/nidara-ui`):
the source tree `repo/ui/shell` in `--dev`, `/usr/share/nidara/ui/shell` in
`--system`. `install.sh` ships `ui/shell/assets/` into `/usr/share/...`.

Do NOT resolve assets against `~/.config/nidara/` — an old secondary
`${config}/nidara/ui/shell/...` path existed only because the config dir used
to be a symlink to the repo (see footgun below); it was removed from
`Icons.ts`/`app.ts`/`ThemeManager.ts` (2026-06-05). Rule of thumb: **shipped assets →
`SHELL_ROOT`; user state → `~/.config/nidara/`.** They are never the same place.

The greeter/lockscreen bundles have no `NIDARA_SHELL_ROOT` env; when shared code
in `ui/lib/` needs a shipped shell asset (e.g. `avatar.ts`'s Settings-matching
`user-round.svg` glyph), it falls back to the literal
`/usr/share/nidara/ui/shell` — safe because those two bundles ALWAYS run from
/usr/share (their bin wrappers) and install.sh ships `ui/shell/assets` there in
BOTH install modes. Same pattern as the lockscreen loading the greeter's
compiled `style.css` from its installed path. Always keep a theme-icon last
resort for the missing-file case.

## Dev loop

```bash
./install.sh --dev                       # one-time setup
# edit TSX/SCSS in ui/shell/
Super+Shift+R                            # reload UI in a graphical session
tail -f "$XDG_RUNTIME_DIR/nidara-ui.log"  # logs (per-user; falls back to /tmp)
killall gjs                              # nuke stale GJS holding the old UI
cd ui/shell && ags types -d .           # (re)generate @girs/ typings — see below
cd ui/shell && npm run typecheck        # needs @girs/
cd ui/shell && npm run build            # SCSS + ags bundle
nidara-ipc toggleAppGrid                # send an IPC command
```

### ⚠️ The greeter and the lockscreen have NO dev mode — building them changes nothing

`--dev` makes the SHELL run from the source tree (`bin/nidara-ui` sets
`NIDARA_SHELL_ROOT` to `repo/ui/shell`), which is why `Super+Shift+R` is enough for it.
**`bin/nidara-greeter` and `bin/nidara-lock` have no such branch**: both hardcode
`/usr/share/nidara/ui/{greeter,lockscreen}/build/…`, and the lockscreen reads its CSS from
the greeter's *installed* `style.css`. So `npm run build` in either bundle produces a
perfectly good artifact that the running system never looks at.

The failure mode is silent and reads as "my change didn't work": the bundle builds, the SCSS
compiles, `git status` shows the edit, and the screen is identical (2026-08-09 — cost a round
trip on the design-system pass). **Whenever you touch `ui/greeter/`, `ui/lockscreen/` or
anything in `ui/lib/` they consume, the change is not testable until it is installed.** The
three files `install.sh` copies (its lines ~725/727/740) are:

```bash
cd ui/greeter && npm run build && cd ../lockscreen && npm run build && cd ../..
sudo cp ui/greeter/style.css            /usr/share/nidara/ui/greeter/
sudo cp ui/greeter/build/nidara-greeter /usr/share/nidara/ui/greeter/build/
sudo cp ui/lockscreen/build/nidara-lock /usr/share/nidara/ui/lockscreen/build/
```

Then: **the lockscreen** is seen by locking the session (`loginctl lock-session`) — cheap and
reversible with your password. ⚠️ **And only with your password — killing the lock client is not
a way out.** `ext-session-lock` is designed so a client that dies without unlocking leaves the session
locked — that is the security property, not a crash — so `pkill nidara-lock` gets you a locked
screen with nothing drawing on it. In a VM where nobody knows the password (or after a
`faillock`), the only exit is restarting greetd from another TTY or over SSH; and if that greetd
already consumed its `initial_session`, `sudo rm -f /run/greetd.run` first or you land on the
greeter instead of the session. **The greeter** is not cheap either: seeing it means logging out or
restarting `greetd`, which kills the session you are working in. Don't restart greetd to
check a style change; look at it on the next login, in the VM, or offscreen with
`scripts/dev/lock-probe.js` (which needs neither an install nor a session — it reads
`ui/greeter/style.css` straight from the repo).

Note the asymmetry this creates in a review: the greeter and the lockscreen **share one
stylesheet**, so every greeter-visible change ships whether or not anyone looked at it.

### Testing the LOGIN itself, without a VM and without logging out

`lock-probe.js` covers how the greeter looks. For what it *does* — the greetd conversation in
`ui/greeter/lib/greetd.ts`, which the greeter speaks directly (no AstalGreet since 2026-08-17) —
there is a fake daemon:

```bash
python3 scripts/dev/fake-greetd.py /tmp/greetd.sock /tmp/req.jsonl &   # add --big-endian for the control
ags bundle --gtk 4 scripts/dev/greetd-probe.ts /tmp/greetd-probe
GREETD_SOCK=/tmp/greetd.sock /tmp/greetd-probe                        # expect: PROBE-RESULT ALL PASS
```

The probe covers wrong password → `AuthError{isAuthFailure:true}`, right password → resolves, and
no `GREETD_SOCK` → an error the card must NOT show as "wrong password".

🔑 **Read `/tmp/req.jsonl`, not just the PASS lines.** It records the conversation the daemon saw,
and that is the only place some of the contract is visible — a failed attempt must be followed by
`cancel_session`, because greetd refuses the next `create_session` while a failed one is still
under configuration. A client that skipped it would still print PASS.

⚠️ **`--big-endian` exists so you can watch the probe FAIL before believing a green run** (it
byte-swaps the reply's length prefix; a correct client reports a framing mismatch). Worth using:
the bug it models is a real one — AstalGreet writes that prefix native-endian and reads it back
big-endian, and it never surfaced upstream because `read_bytes_async` returns whatever is
available instead of filling the count, so the nonsense length was harmless.

### Rebuilding the Wayland shim (`lib/nidara-wl/`)

TSX changes reload with `Super+Shift+R`; the C shim does not. After editing `nidara-wl.c/.h` the
library and typelib have to be rebuilt **and reinstalled system-wide** — the shell resolves
`gi://NidaraWl` from the default girepository path, so a fresh build sitting in `lib/nidara-wl/build/`
changes nothing until it is installed.

```bash
lib/nidara-wl/build.sh                    # → lib/nidara-wl/build/ (.so + .gir + .typelib)
sudo install -Dm755 lib/nidara-wl/build/libnidara-wl.so.0.0.0 /usr/lib/libnidara-wl.so.0.0.0
sudo ln -sf libnidara-wl.so.0.0.0 /usr/lib/libnidara-wl.so.0
sudo ln -sf libnidara-wl.so.0     /usr/lib/libnidara-wl.so
sudo install -Dm644 lib/nidara-wl/build/NidaraWl-1.0.typelib /usr/lib/girepository-1.0/
sudo install -Dm644 lib/nidara-wl/build/NidaraWl-1.0.gir     /usr/share/gir-1.0/
sudo ldconfig
```

To try it without installing (handy for a throwaway test script):

```bash
GI_TYPELIB_PATH=lib/nidara-wl/build LD_LIBRARY_PATH=lib/nidara-wl/build gjs -m test.js
```

⚠️ **Two things go stale silently.** The `.gir` in `/usr/share/gir-1.0/` is what `ags types -d .`
reads to generate `@girs/NidaraWl-1.0` — skip installing it and the local typecheck reports the new
API as nonexistent. And CI's typecheck uses the **`@girs/` snapshot from the `ci-assets` release**,
which knows nothing about `NidaraWl` until a maintainer refreshes it; the first PR that imports the
shim needs that refresh or typecheck fails on CI while passing locally.

### Adding a widget (auto-registration)

Create ONE file in `ui/shell/widgets/` that default-exports a
`const w: AtomicWidget = {...}` (contract in `surfaces/control-center/Types.ts`;
copy `calculator.ts` as a minimal template). Then:

```bash
node scripts/gen-widget-index.mjs        # regenerates widgets/widgets.gen.ts
# Super+Shift+R — the dev launcher also runs the codegen automatically
```

Commit `widgets.gen.ts` **together with** the new widget file — the CI job
`widgets-gen` fails the PR if the committed file is stale. No registry edit is
needed beyond the widget's required `category` (`"media"`|`"utilities"`|`"system"`,
which auto-places it in the bar) + optional `barOrder` (intra-category fine-tune);
`CC_DEFAULT_ORDER` in `widgets/index.ts` stays editorial (unlisted ids fall to the
end). The codegen hard-errors
on non-widget files in `widgets/` (helpers go in `common/`) and on
duplicate ids — fix what it says and re-run.

If the widget depends on hardware (battery, radios, backlight…), declare
`isAvailable()` (+ `watchAvailable(cb)` if presence can change at runtime) —
without hardware the widget must not exist for the user (see the hardware-gate
rules in `architecture.md`). On a dev desktop, exercise it with the fake-*
scripts above.

### Debugging "the change didn't apply"

When a reload seems to do nothing or styles refuse to refresh, the cause is almost always a zombie `gjs` process still drawing the previous UI. Order of escalation:

1. `Super+Shift+R` again.
2. `killall gjs` — then `Super+Shift+R` once it's gone.
3. `tail -f "$XDG_RUNTIME_DIR/nidara-ui.log"` and re-trigger; look for stack traces.

### Finding CSS that can never reach its widget (`scripts/dev/scope-audit.mjs`)

```bash
cd ui/shell && npm run build          # style.css must be current
node ../../scripts/dev/scope-audit.mjs   # exit 1 if anything is unreachable
```

Every surface sheet is wrapped in its window's selector (commandment 2), which makes the scope a
fact about the TSX — and the TSX moves. When a surface changes windows, the rules that used to
reach it stay in the sheet, stop matching, and report **nothing**: no SCSS error, no GTK warning,
no diff. The symptom arrives months later as "that thing looks like raw GTK now", from a human.

For every class named in `css_classes:` / `add_css_class()` by code that renders into a window,
this looks for at least one selector in the compiled sheet that is either unscoped (the global
kit) or scoped to *that* window. No selector at all is fine — the widget is Cairo-painted or the
class is a marker. Only selectors naming a **different** window is the bug.

It found three on its first run (2026-08-10): the island's whole media panel (`.nidara-media-*` was
inside `_control-center.scss`'s `#nidara-bar` block while `PlayerIsland` shows the same panel —
broken since July), the "Default" audio badge and the slider readout (both scoped to the CC's
detail page while Settings wore them too).

**Pass 2 — a window inside a window (added 2026-08-10, needs no list).** Pass 1 is only as complete
as its hand-kept `WINDOWS`, so it is blind to a window nobody told it about. The
`NidaraAlertDialog` was exactly that: its own toplevel, whose rules #97 swept inside
`window.nidara-settings-window`. Every class in it comes from `../lib/nidara-kit`, which pass 1
attributes to **Settings** — so it found a Settings-scoped selector, called it reachable, and went
green while the whole dialog rendered as raw GTK.

Pass 2 asks a structural question instead: a window scope root (`window.…`, `window#…`, `#nidara-…`)
in a **non-initial** position is impossible by construction, because a `Gtk.Window` is always a
`GtkRoot` and a transient is a sibling root, never a descendant. Zero false positives across the
sheet's 1259 selectors. ⚠️ Match `window` as a whole compound, never as a suffix — GTK4's node name
for a `Gtk.ScrolledWindow` is `scrolledwindow`, and a substring test flags every
`scrolledwindow.apps-list-scroll > viewport` in the sheet.

⚠️ **What it cannot tell you**: whether a *reachable* rule is the one you meant, or whether
specificity lets something else win. It answers "can this rule ever apply here", nothing more. A
clean run is not a substitute for looking at the running shell.

⚠️ **Keep `WINDOWS` in step with the scope table** in `design-system.md` whenever a surface moves
or is added — and note that its `dirs` follow the MOUNT SITE, not the folder name: `widgets/media.ts`
is listed under the island because `PlayerIsland` mounts its panel there. The mount site of a
**transient** is its own root: don't add the alert dialog's classes to Settings just because
Settings opens it.

⚠️ **Verify the tool against a known bug before trusting a green run.** Reintroducing one into
`style.css` (which is generated, so it costs a rebuild to undo) is how the first version was caught
matching only half of it: it anchored `.class` on a preceding space, so every element-qualified rule
— `label.accent-label`, `button.nidara-btn`, `spinbutton.time-spin` — was invisible, and a class
styled *only* that way read as "no CSS at all" and passed.

### Checking the Settings window's geometry law (`scripts/dev/settings-geometry.mjs`)

```bash
node scripts/dev/settings-geometry.mjs                       # default width sweep
node scripts/dev/settings-geometry.mjs --widths 1400,1050,802
```

Drives the LIVE session: for each window width it resizes the Settings window through Hyprland,
walks all 18 pages via `nidara-ipc settingsPage`, and reads each page's real `bounds` out of
`queryUI`. It asserts the three invariants of `WINDOW_LAYOUT` (design-system.md) — same pane width
across pages, same pane width across window widths, and the window's floor holding — and exits 1
on a violation.

It exists because this failure is **invisible one page at a time**: the breakpoint used to be
derived per page, so the sidebar docked on 16 pages and floated on 2 at the same window size, and
the only way to see that is to sweep. It is also how the numbers in `WINDOW_LAYOUT` were measured.

⚠️ Needs a graphical session (it is not a CI gate), and it resizes/floats the user's Settings
window, restoring size and tiling state at the end. ⚠️ It resizes with `hl.dsp.window.resize` —
under this repo's Lua config the classic `hyprctl dispatch resizewindowpixel …` string is a Lua
syntax error, and the shape of that mistake is that it prints an error and keeps going, so a sweep
built on it reports differences that are really the window never having moved (that happened while
writing this one — the first table it produced was noise).

### Driving `hyprland.lua`'s game mode without Hyprland (`scripts/dev/hypr-game-mode-test.lua`) — a CI GATE

```bash
lua scripts/dev/hypr-game-mode-test.lua        # exits 1 on failure
# run it against another copy of the config — e.g. to confirm it can still fail:
git show main:config/hypr/hyprland.lua > /tmp/old.lua
NIDARA_HYPR_CONFIG=/tmp/old.lua lua scripts/dev/hypr-game-mode-test.lua
```

The game-mode handlers only run when **Steam** opens a window, which is not something a test can
arrange — so it fakes **Hyprland** instead of faking a game: a stub `hl` table records what the
config asks the compositor to do, the real `config/hypr/hyprland.lua` is loaded against it, and the
registered `window.open` / `window.destroy` callbacks are invoked directly with a game-shaped
payload. `powerprofilesctl` is intercepted in both directions (`hl.exec_cmd` when the config sets a
profile, `io.popen` when it reads one) and `HOME` points at a fixture holding `gaming.json`, so the
test states its own preconditions and never touches the live session.

What it asserts is that a game session is **undone**: the power profile after it is the one from
before it, across all three profiles, across two windows for one game, when the user changes the
profile mid-game, when they quit from another workspace, and — with the toggle off — that
`powerprofilesctl` is never run at all. That last one is checked by counting commands rather than by
reading the final value; a value can be right for the wrong reason.

It is a CI gate alongside `luac -p` on the same file, and the parse check is the more important
half: the session's whole config is one Lua chunk, so a syntax error anywhere in it means Hyprland
starts with **no Nidara config at all** — no keybinds, no rules, no game mode.

⚠️ The pattern generalises to anything else in `hyprland.lua` that keeps state across events. What
made game mode worth covering is that it has some: what the wallpaper and the profile *were*.

### Do the shipped locales still FIT? (`scripts/dev/text-budget.js`) — a CI GATE

```bash
gjs -m scripts/dev/text-budget.js                    # the gate, as CI runs it
gjs -m scripts/dev/text-budget.js --scales 1.0,1.5   # narrow the sweep
gjs -m scripts/dev/text-budget.js --verify           # cross-check the budget live
gjs -m scripts/dev/text-budget.js --font "Noto Sans 11"
```

The companion to `settings-geometry.mjs` and the opposite kind of instrument: that one drives the
live session and cannot run in CI; this one touches nothing, builds real GTK labels with the real
compiled stylesheet, and measures every string of all **12 locales** at text scales 1.0→1.5. It is
wired into the headless smoke job (the only one with a GDK display *and* `inter-font`).

**Why offline rather than a sweep of the real window**: the locale comes from `$LANG` at shell
startup (`core/i18n/detectLanguage`), so a live sweep of 12 locales means 12 shell restarts.

**What a breach means.** The sidebar label ellipsises, so a breach is not a broken layout — it is a
page name the user cannot read. That makes the rule a product rule: **at scale 1.0 nothing may be
truncated (fails); above it, truncation is graceful degradation (reported)**. `--fail-at` moves the
line. The degradation ladder is the useful half — it is how you see that Japanese goes at 1.25 and
English itself at 1.39, i.e. that the column is tight for the job rather than one locale being long.

Three traps, each of which produced a green run that measured nothing:

- ⚠️ **A `Gtk.Settings` change needs the main context PUMPED.** Without it the sweep measures every
  scale at 1.0 and passes — the first version printed four identical numbers for four scales.
- ⚠️ **The font is PINNED to the shipped default** (read from the line in `core/ThemeManager.ts`
  that seeds it), not taken from the machine — a budget is a property of the product. And the script
  **refuses to run if that family is missing**, because fontconfig substitutes SILENTLY: an
  unavailable font does not error, it just measures a different typeface.
- ⚠️ **The locale files are parsed, not imported** (they are TypeScript, this is gjs). The parse is
  asserted — a locale that yields under 50 keys aborts the run rather than passing vacuously.

🔑 **`--verify` is what keeps the budget honest**, and it earned that on the day it was written:
`sidebar.ts` documented the label budget as 176px and the real allocation measured **170px**. The
comment had missed the capsule's 1px borders and Adwaita's `list > row { padding: 2px }` — the very
padding `.nidara-row` exists to clear, which the sidebar's bare `Gtk.ListBoxRow`s never opted out
of. Six pixels, in the one place already known to be a string over budget. Derive a budget, then
make the machine check the derivation against a real window.

### Proving a selector matches NOTHING (the sentinel probe — a technique, not a script)

`scope-audit` answers "can this rule reach the window?"; `gtk-probe` answers "how big is this?".
Neither answers *"is `window.nidara-dock-window > box` dead?"*, because that is a question about one
bespoke widget tree. **Ask it instead of deriving it from the source:**

1. Declare the selector with a **sentinel** no other rule uses — `padding: 37px` — at
   `STYLE_PROVIDER_PRIORITY_APPLICATION`.
2. Rebuild the exact nesting in question (read it out of the TSX; the dock is
   `win.set_child(overlay)` → `overlay.set_child(layout)` → `layout.set_child(da)` +
   `add_overlay(shim)`).
3. `gtk4-broadwayd :5` + `GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 gjs -m probe.js`, wait one frame,
   walk the tree and print every node whose `get_style_context().get_padding()` carries the sentinel.

~50 lines, and deliberately **not** committed: the tree is different for every question, so a
permanent tool would only ever be scaffolding. The 2026-08-10 run over `&>box` returned 0.

🔑 **A zero proves nothing until a control has produced a one.** Always run a variant whose direct
child really IS the node you are asking about — otherwise a typo'd selector, a provider that never
loaded, or a probe that walks the wrong root all look exactly like "dead". Same lesson as verifying
`scope-audit` against a reintroduced bug, one paragraph up.

🔑 **Once it is fixed, drop the sentinel and read the REAL sheet.** The sentinel proves reachability;
it does not prove the dialog now wears its own stylesheet. Same ~50-line probe, but load
`ui/shell/style.css` and print declared values (`get_padding`, `get_border`, the Pango weight)
against what the SCSS says. Point it at a `git worktree add … origin/main` build via `SHEET=` and
before/after come out of one instrument. The 2026-08-10 alert-dialog run read `4 9` padding and
weight 400 before, `14 16` and 600 after — which also showed the entry had NOT been raw all along:
it was wearing the global `entry` rule from `_components.scss` (2px border, `6 10`), the only part
of the dialog with a global fallback to fall back to.

🔑 **Run the counterfactual too, and doubt the caution as hard as the claim.** The third variant here
was "what if the redundant wrapper were removed?" — because the tech-debt note warned that would make
the selector start matching. It also returned 0 (`layout` is an overlay as well), so the note had
been guarding nothing. **A warning derived from a source read is a hypothesis with the same burden of
proof as the thing it warns about.**

⚠️ **A plain `Gtk.Window` is not a layer-shell surface.** Confirm the shape against the running shell
before acting: `nidara-ipc queryUI <selector>` prints each node's `path` as GType ancestry
(`"GtkWindow.fullscreen > GtkOverlay"`), which settles "what is the window's direct child?" directly.

⚠️ **A widget-tree walk cannot see GTK-internal CSS nodes.** `decoration`, `slider`, `trough`,
`contents` are nodes without widgets — neither this probe nor `queryUI` will ever report them, and
their absence is not evidence they are dead. That is why `decoration` survived the deletion that
removed `&>box` from the same rule.

### Measuring a control's real geometry with no screen (`scripts/dev/gtk-probe.js`)

For any question of the form *"where does this inset actually come from?"* on a widget that
mixes GTK's own boxes with our CSS — the native `Gtk.DropDown` is the standing example. Reading
the three stylesheets failed five rounds in a row on that one; this is what ended it.

```bash
gtk4-broadwayd :5 &                          # offscreen display, once per session
GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 \
  gjs -m scripts/dev/gtk-probe.js /tmp/probe
```

It builds the specimen with `ui/shell/style.css` loaded at the **same provider priority the
shell uses** (`PRIORITY_USER + 10`, as in `ThemeManager`), and prints the CSS node tree with
each node's bounds / padding / border / margin / state, the same deltas `queryUI` reports
(node vs toplevel), and a PNG of the surface — `Gtk.WidgetPaintable` → `Gsk.CairoRenderer` →
`save_to_png`, so you can count pixels of the actual render. `EXTRA_CSS=` loads above
style.css and `LOW_CSS=` loads at the *theme's* priority, which turns it from a dump into an
experiment: "does our declaration really beat the theme's?" is one run, not an argument.

Why offscreen and not the live shell: it is reproducible, it needs nobody to hold a popover
open, and it can answer counterfactuals ("what did the PREVIOUS commit's CSS measure?") that a
live session cannot. That last one is how the dropdown's "13px at the top vs 7 at the sides"
turned out to be a **stale-stylesheet reading** — the card padding and the list margin both
live at once, which no committed state ever had.

⚠️ **`:focus-visible` cannot be reproduced offscreen.** GTK grants it on keyboard traversal
only; `grab_focus()` + `gtk_window_set_focus_visible()` set the FOCUS_VISIBLE *state flag*
(you can see it in the dump) and the selector still does not match. Use `:focus` or `:selected`
as the stand-in when the question is about the CASCADE; anything that genuinely depends on the
focused state is a live check.

⚠️ **Never conclude from one absolute bound.** `compute_bounds` on these nodes is ambiguous
enough that a single number fits two readings; compare DELTAS between nodes measured in the
same run — that rule is why the probe prints the pairs itself.

### Verifying the CURSOR — five instruments lie, and they lie in your favour

Two sessions (2026-08-16/17) went almost entirely into instruments rather than the fix. Read this
before running a single cursor experiment.

**🔑 The law first, because most "it does not work" readings are really this.** Hyprland redraws the
pointer **only when it sees a different shape NAME** — `IHyprRenderer::setCursorFromName` opens with
`if (name == m_lastCursorData.name && !force) return;`. So a crossing between two surfaces that both
say `default` repaints NOTHING, and neither does re-sending the same shape. Leaving a window "works"
only because something on the way out changes the name (a resize border → `left_side`, bare desktop →
`left_ptr`, a text field → `text`). Design every A/B around that, or the control arm will be as dead
as the test arm — which is how a perfectly good calibration was thrown away here.

The five liars:

- **`grim -c` cannot see the cursor's theme or size**, and it fails in the direction that reads as
  "your change did nothing". It refreshes its copy on the pointer-focus path only. Calibrated three
  ways: with the pointer moved but the NAME unchanged it reported an identical 157 px / ink 0.078 for
  a black theme and a white one; only after a name-changing crossing did it discriminate (Adwaita
  112 px vs Qogir-Dark 147 px). A capture also once reported a 24-px box while a person looking at
  that screen saw a cursor four times bigger. **Never conclude from a screenshot.**
- **The TERMINAL refreshes the cursor for free.** It re-declares its cursor whenever it prints, so any
  experiment with the pointer over the terminal you are typing in measures the echo of your own
  commands. An entire session of "works by hand, not from the code" was this.
- **kitty HIDES its cursor when the pointer is still**, and un-hiding re-declares it. A theme change
  tested over kitty therefore "works" no matter what your patch does.
- **`hyprctl dispatch movecursor 469 756` moves nothing** on this Lua config (`')' expected`), and
  worse: even in the correct form (`hyprctl dispatch "hl.dsp.cursor.move({ x = …, y = … })"`) a warp
  produces **no crossing event**, and GTK only pushes a cursor for a device it has a recorded pointer
  focus for. So the standard way to park the pointer **silently disables the mechanism under test**.
  Park it with real motion — `nidara-input move X Y 2560 1440` — and assert `hyprctl cursorpos`.
- **Hyprland's own log stops being written**, three times in one session. `debug:disable_logs` is only
  re-read on `config.reloaded`, and `hyprctl eval` does NOT emit that event — so trying to turn logs
  on by eval leaves them OFF with no way back. Put `hl.config({ debug = { disable_logs = false } })`
  in `hyprland-user.lua` and `hyprctl reload`. Then **bracket every run with a canary** (any `hyprctl`
  call logs `Hyprctl: new connection from pid N`): if your pid is missing at the end, the log died
  mid-run and every count in it is void. A whole "the bug is reproduced!" reading came from a log that
  had frozen seven minutes earlier.

Also true, and each broke a reasonable-looking assumption: **the visible cursor and the setting
disagree indefinitely** (`gsettings get cursor-theme` reports the new one while the screen shows the
old); **portal latency measured in a COLD process is not the warm one** (~1.5 s spawning a probe,
20 ms in the running shell, which inverted an ordering the design rested on); **`nidara-click` applies
the change by itself** (its choreography lands real pointer motion seconds after the command returns,
and it toggles `cursor:invisible`); and **restarting the shell destroys the Settings window**, leaving
the pointer over the wallpaper with no surface of ours beneath it.

**What actually works: the WIRE.** `WAYLAND_DEBUG=1 gjs -m probe.js 2> log`, with a minimal GTK4
window that reproduces the case — for the dropdown bug that meant a window containing one
`Gtk.DropDown`. It shows `wp_cursor_shape_device_v1.set_shape`, `wl_pointer.enter/leave` and
`xdg_popup.destroy` with timestamps, which is the whole causal chain. Building it FIRST would have
saved both sessions. ⚠️ Grep it with `#`, not `@` — `WAYLAND_DEBUG` writes `wl_pointer#31.enter`, and
a pattern with `@` matches nothing and reads as "no events". ⚠️ And assert the ORDER: a `set_shape`
sitting right after a `wl_pointer.enter` is that enter, not your change.

⚠️ **Control your own variables.** One run here showed pointer focus returning "spontaneously" 800 ms
after a popover closed, which reversed a conclusion — it was the user's hand on the mouse. Three
scripted selections with no human input showed it never returns. If a human is at the machine, the
mouse is an uncontrolled variable.

### Measuring what a layer's blur costs (`scripts/dev/blur-arm.sh`)

The harness behind `references/tech-debt.md` §46. Use it for any claim of the form "this surface's
blur got cheaper" — the box ratio a surface declares is easy to read off `dumpState`, but it is not
a GPU number and should never be quoted as one.

One arm = one line. It restarts the shell, parks it on an empty workspace, starts a rectangle that
damages the screen at the monitor's refresh rate (`blur-damage.js`, a BOTTOM layer painting a GSK
color node), puts the shell in the state you name via `nidara-ipc`, samples `gpu_busy_percent` at
20 Hz for 20 s, and prints mean/min/max plus the damage client's fps.

```bash
# arm A — the OLD code, checked out from a ref, as the ONLY variable
REF=origin/main FILES=ui/shell/surfaces/island/IslandWindow.ts \
  scripts/dev/blur-arm.sh "old: full surface" setIsland agent
# arm B — the working tree, same scenario
scripts/dev/blur-arm.sh "new: declared rect" setIsland agent
# the floor: the same shell with nothing open
scripts/dev/blur-arm.sh "floor"
scripts/dev/blur-arm.sh --reset          # put back whatever a REF arm swapped in
```

Anything after the label goes to `nidara-ipc` verbatim, so any IPC action can be the scenario
(`toggleCC`, `toggleAppGrid`, `setIsland overview`…). Knobs: `SECS`, `WS`, `SETTLE`, `DX/DY/DW/DH`.

**Reading it:**

- Run the arms **alternated** (A,B,B,A) — the machine drifts across a long sweep.
- 🔑 **Check `fps=` on every arm.** It must be the monitor's rate. A throttled arm carried a
  different load than its partner and means nothing; throw it out rather than averaging it in.
- **Quote the delta AND the floor.** "Opening X now costs nothing" is a claim about the floor;
  "X is 5 points cheaper" is a claim about the delta. They fail independently.
- The number is tied to **where the damage sits**: §46's cost is the intersection of that rect with
  the region a surface declares, so a surface whose region misses it measures as free. Say where it
  was. (This is why the island's Assistant mode reads as free and its overview does not.)

⚠️ **Three ways to get a confident wrong number**, all of them silent, all of them paid for:

1. **Two arms agreeing.** The likeliest failure, and it looks exactly like "my change does nothing".
   Every arm must state the tree it measures; the script restores a previous arm's swapped files when
   an arm names no `REF`, because an arm that inherits the tree re-measures its predecessor
   (2026-08-10: a pair read 8.9 vs 9.4 whose real numbers were 6.1 vs 1.1).
2. **A short window.** The same arm read ~9 % at `SECS=4` and 6.1 % at `SECS=20` — a short sample
   sits on the transient the state change itself causes and inflates each arm differently.
3. **`pkill -f` matching the caller.** The stray-client kill lives inside the script for a reason:
   `-f` matches whole command lines, so any shell whose argv merely *mentions* the damage file kills
   itself. A caller that ran `chmod +x scripts/dev/blur-damage.js && …blur-arm.sh …` died on it
   (exit 144, no output). Invoke the harness with a command line that does not name that file.

### Testing in a QEMU VM (installer / greeter / lockscreen)

The paths CI cannot cover — `install.sh` on a virgin Arch, the greetd→greeter→login
chain, the lockscreen — are tested in a QEMU VM. Working invocation (verified 2026-07-03;
`<disk>` = your Arch qcow2, UEFI via OVMF):

```bash
qemu-system-x86_64 -enable-kvm -machine q35 -cpu host -m 4096 -smp 4 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/edk2/x64/OVMF_CODE.4m.fd \
  -drive if=pflash,format=raw,file=<ovmf-vars-copy>.fd \
  -drive file=<disk>.qcow2,if=virtio \
  -vga none -device virtio-vga-gl -display egl-headless \
  -audiodev none,id=snd0 -device intel-hda -device hda-output,audiodev=snd0 \
  -nic user,model=virtio-net-pci,hostfwd=tcp::2222-:22 \
  -usb -device usb-tablet
```

Gotchas that cost real debugging time:
- **Always emulate a sound card** (the `-audiodev`/`intel-hda` lines): without one, PipeWire
  has no sink, the bar volume icon shows muted, and audio bugs are invisible — the missing
  `pipewire-audio`/`pipewire-pulse` packages (audio dead on every clean install) went
  undetected for weeks because test VMs had no audio device. `-audiodev none` needs no host
  audio; the guest still gets a working sink.
- **`-vga none` is mandatory** with `-device virtio-gpu-gl`/`virtio-vga-gl`: without it QEMU
  adds a default bochs VGA, the guest gets TWO DRM cards, Hyprland picks the 3D-less bochs
  one and dies instantly ("start-hyprland error" at the greeter, greetd hits start-limit).
- `-display egl-headless` renders guest GL offscreen — verify via `grim` over SSH
  (`hostfwd` → port 2222), no window needed. (`gtk,gl=on` / `sdl,gl=on` may fail to create
  a GL context depending on the launching environment; egl-headless is the reliable one.)
- **Offline qcow2 snapshots** (`qemu-img snapshot -c/-a <tag>`, VM OFF) are the iteration
  workflow — restore a clean state between installer runs. Applying one rolls back
  EVERYTHING, including the guest's `~/.ssh/authorized_keys` — snapshot AFTER installing
  your SSH key.
- **Screenshotting the greeter**: it runs as the `greeter` system user, whose Hyprland does
  not inherit `WAYLAND_DISPLAY` — find it with `sock=$(sudo ls /run/user/<greeter-uid>/ |
  grep -x 'wayland-[0-9]')`, then
  `sudo env XDG_RUNTIME_DIR=/run/user/<greeter-uid> WAYLAND_DISPLAY=$sock grim /tmp/shot.png`.
- **Getting a seat session without typing a password** (needed for lockscreen tests over
  SSH): append `[initial_session] command = "/usr/bin/nidara" user = "<user>"` to
  `/etc/greetd/config.toml` and restart greetd — but greetd honors it only once per boot,
  tracked by `/run/greetd.run`, so `sudo rm /run/greetd.run` before the restart. Revert the
  config byte-exact afterwards so the Nidara-owned `/etc/greetd` fingerprint keeps matching
  (`install.sh --update` re-syncs only fingerprint-matching configs).
- Fast deploy iteration without a full `install.sh --update`: `scp` the rebuilt bundle +
  compiled `style.css` over the installed copies under `/usr/share/nidara/` (+ wrappers
  under `/usr/bin/`) and restart greetd / re-lock.

CI gates **SCSS compile + typecheck + widgets-gen freshness + headless boot smoke + Assistant
loop** (`agent-loop`, see below).

⚠️ **`ci.yml` triggers on `pull_request` AND `merge_group`, and dropping the second one breaks
merges silently.** `main` uses a merge queue: the queue builds a temporary `merge_group` ref
(the PR merged onto the current `main`) and waits for the four REQUIRED checks — styles,
typecheck, smoke, widgets-gen — to report against it. Without the `merge_group:` trigger those
checks never start there, so the queue entry waits until it times out and is kicked, while the
PR still shows a full set of green checks from its own `pull_request` run. Nothing reports an
error; a merge just never happens. The workflow the queue runs is the one on the BASE branch, so
this trigger has to be on `main` before any of it works. Adding a new required check means adding
it to the queue's list too, or the same stall returns.

Note that `pull_request` already checks out `refs/pull/N/merge` — the merge RESULT, not the
branch — so a green PR check has always been a statement about the merge, not just the diff.
What the queue adds is that the statement is re-made against the `main` that is actually current
at merge time.

**What `main` actually gates, so a contributor's agent does not assume otherwise** (2026-08-16):
the four checks above, plus linear history, no force pushes, no deletions. It does **not**
require an approving review — that requirement existed until today and was unsatisfiable (one
collaborator, and GitHub does not let anyone approve their own PR), so it produced a bypass on
every merge instead of a review. **CI is the automated gate; the human gate is the maintainer
reading the PR**, and nothing in this repository enforces the second one. Write access is what
keeps `main` safe from outside: opening a PR is open to anyone, merging one is not.

The **smoke job** (`scripts/ci/headless-smoke.sh`, `smoke` in ci.yml) is the only gate that
actually RUNS the shell: the runner loads the kernel's **vkms** module (virtual KMS — needed
because Hyprland cannot boot with zero DRM devices: aquamarine's GBM allocator wants a node,
and `HYPRLAND_HEADLESS_ONLY` is set by hyprtester but read by NOTHING, verified on v0.55.2
and main), then a privileged `archlinux:latest` container builds the pinned
Astal/AGS/appmenu stack straight from `install.sh`'s refs (so a broken source build fails
CI, not a user's clean install), `ags bundle`s the shell, boots Hyprland with the SHIPPED
`config/hypr/hyprland.lua` on the vkms display (seatd session + systemd-udevd for device
enumeration; rendering is kms_swrast/llvmpipe), runs the bundle exactly as production does
(`NIDARA_SHELL_ROOT` + cwd = shell root), and FAILS if the process dies, `nidara-ipc
listActions`/`dumpState` don't answer with valid JSON, or the boot log contains `JS ERROR`.
It then grims a desktop + Control Center screenshot into the `smoke-artifacts` artifact for
HUMAN review — deliberately not a pixel diff (rejected as fragile). The built dependency
stack is cached as a tarball keyed on `install.sh`'s hash **+ `headless-smoke.sh`'s** + a month
stamp (bounds soname drift against the moving `archlinux:latest`); Hyprland refuses root, so the boot phase
re-runs the script as an unprivileged `ci` user (`run` subcommand). Note the smoke job
builds the COMMITTED tree (it does not re-run the widget codegen — staleness is the
`widgets-gen` job's gate).

⚠️ **The list of Astal libs to build lives in TWO files** — `install.sh`'s `astal_pkgs` and the
smoke's `astal_subdirs` — and they must move together. Until 2026-08-17 the cache key hashed
only `install.sh`, which made "we no longer need lib X" **unfalsifiable in CI**: drop X from the
smoke list alone and the restored tarball still contains it, so the shell boots and the removal
looks proven. The key now hashes both files. When you drop a lib, the smoke building the stack
WITHOUT it and still booting is the proof — check the run actually rebuilt (cache miss), or it
proved nothing.

🔑 **A missing Astal lib does not necessarily break the shell, and that cuts both ways.**
astal-gjs's `overrides.ts` imports ~10 `gi://Astal*` modules through a `suppress()` wrapper that
swallows the failure, so an absent lib silently skips its array-getter patches instead of
throwing. Live proof that this path is real, not theoretical: **`AstalPowerProfiles` is in that
list and has never been installed on any Nidara machine** — it is not in `install.sh`'s package
set at all — and the shell has always booted. So (a) removing a lib we do not import is safe by
construction, and (b) you cannot conclude "the lib is needed" from the shell merely *starting*.

The SCSS job is pure JS. The typecheck job can't run
`ags types` (no ags binary / Astal libs on a runner), so it downloads a ~4 MB compressed
snapshot of `@girs/` from the repo's `ci-assets` release and runs `tsc --noEmit` against it —
the repo's own `types.d.ts` declares the `ags/*` modules ambiently, so no `node_modules` is
needed. **If CI typecheck fails on a type that exists locally, the snapshot is stale**: a
maintainer refreshes it with `scripts/dev/publish-ci-typings.sh` (re-run after any GTK/Astal
update that changes the typings).

**Getting a native backtrace from a GLib CRITICAL/WARNING** (proven 2026-06-09 — this is how
the boot-time `g_list_store_remove` CRITICAL was attributed to libastal-tray, which is gone
as of 2026-08-18 — the technique is not): stop the unit,
run the shell once with criticals made fatal so it aborts and leaves a coredump, restore, read
the trace:
```bash
systemctl --user stop nidara
NIDARA_SHELL_ROOT="$PWD/ui/shell" G_DEBUG=fatal-criticals timeout 20 \
  bash -c 'cd ui/shell && ags run app.ts' > /tmp/fatal-crit.log 2>&1
systemctl --user start nidara      # restore the session UI immediately
coredumpctl gdb -1 --debugger-arguments="-batch -ex 'bt 30'"
```
Even with stripped libs the frames name the guilty LIBRARY, which is usually enough to decide
ours-vs-upstream. (`G_DEBUG=fatal-warnings` exists for warnings, but it aborts on the first
harmless warning — see tech-debt #9 — so prefer fatal-criticals.) Astal's Vala sources for
cross-referencing a frame: `https://raw.githubusercontent.com/Aylur/astal/<ASTAL_REF from
install.sh>/lib/<lib>/src/…`.

**`nidara-portal`** (installed to `/usr/bin`, D-Bus-activated as
`org.freedesktop.impl.portal.desktop.nidara`) is Nidara's xdg-desktop-portal **Settings
backend**: it serves exactly one key — `org.freedesktop.appearance accent-color` as the
`(ddd)` RGB of the Nidara accent — so libadwaita/GNOME apps (Calendar, nautilus) follow
the accent under Hyprland (they read the PORTAL, never gsettings; no per-key fallback).
Everything else returns NotFound so the frontend falls through to the gtk backend
(color-scheme/contrast): the Settings portal AGGREGATES backends (verified in x-d-p 1.20
`src/settings.c` — `org.freedesktop.impl.portal.Settings=nidara;gtk` in
`/etc/xdg-desktop-portal/hyprland-portals.conf`; NEVER edit the `/usr/share` one, it's
owned by the hyprland package). Live updates: the daemon watches gsettings
`accent-color` (which ThemeManager keeps in sync) and emits `SettingChanged`. Its accent
table is a deliberate copy of `ui/lib/accent.ts` `ACCENT_HEX` — keep them in sync.
Testing gotcha: `XDG_DESKTOP_PORTAL_DIR` redirects BOTH `.portal` discovery AND
`portals.conf` lookup; GJS gotcha: a bare `v` out-arg needs the `*Async` + manual
`invocation.return_value` pattern (auto-marshalling hangs the reply).

**`nidara-doctor`** (installed to `/usr/bin`) prints a Markdown diagnostic report:
versions, hardware, `hyprctl monitors`, systemd unit state, `nidara-ipc dumpState`, recent
log errors. Run it FIRST when debugging a user's install, and attach its output as evidence
on bug reports and hardware/compat PRs.

**`nidara-mcp`** (installed to `/usr/bin`; registered for this repo via `.mcp.json`, and for installed users via the installer-managed `~/.config/nidara/.mcp.json`)
serves the agent surface — IPC actions, config, state, screenshots (inline images), doctor —
plus the **computer-use** tools (`query_app`, `do_app_action`, `type_text`, `press_key`,
`focus_window`) as MCP tools over stdio. Plain GJS, no Node/npm at runtime; mostly a thin adapter
over `nidara-ipc` (so it needs no changes when IPC commands are added) — the exceptions are the
perception/action/keyboard tools, which run the standalone `nidara-a11y`/`nidara-act`/`nidara-type`
helpers directly because reaching into a foreign app is not shell-self-control (`focus_window` is
the exception-to-the-exception: it delegates back to the shell's `focusWindow`, which owns the
Hyprland binding). Details and governance (`ai.json.allowMcp` / `allowComputerUse` /
`allowComputerControl`, live-read per call) in
`references/state-and-ipc.md`.

**Regenerating `@girs/` (and the trap it sets).** `@girs/` is git-ignored, so a fresh clone / a new
environment has none. Regenerate with `cd ui/shell && ags types -d .` (offline — reads the system
`.gir` files; ~208 `.d.ts`; do **not** pass `-u`, which would rewrite the committed `tsconfig`).
**The trap:** without `@girs/`, `npm run typecheck` doesn't fail loudly — it floods you with ~57
*false* `Namespace '"ags/gtk4".Gtk' has no exported member 'Box'`-style errors. Real errors hide in
that noise, so a regression can sit unnoticed (it did: typecheck silently went 0→32 between work
sessions). **If you see "has no exported member" on GI types, you're missing `@girs/` — regenerate
before trusting any typecheck result.**

**i18n: add every string to BOTH `en.ts` AND `es.ts`, with a real Spanish translation.**
English and Spanish are both first-class working languages, kept in sync by hand at all times —
the maintainer runs the shell in Spanish, so an `en`-only key shows stray English (runtime
fallback is `es → en → key`). Doing es alongside en also validates the wording immediately.
*Other* locales (fr, pt, de…) are the only ones deferred to a single bulk pass at publication —
don't hand-translate them mid-development.

Type-wise, `t()` is typed `key: keyof typeof en` (`en` is the canonical key source), so a missing
`es` entry is **not** a type error — that's a safety net for the bulk-translated locales, not a
licence to skip es. (It used to derive from `es`, which broke the typecheck on every new key —
fixed in `core/i18n/index.ts`.)

#### The translation ledger (`scripts/ci/i18n-check.mjs`) — a CI GATE

```bash
node scripts/ci/i18n-check.mjs                     # report: per locale, untranslated + stale
node scripts/ci/i18n-check.mjs --check             # the gate, as CI runs it
node scripts/ci/i18n-check.mjs --sync              # after adding/rewriting ENGLISH strings
node scripts/ci/i18n-check.mjs --translated de,fr  # after actually TRANSLATING those locales
```

Deferring ten locales to a bulk pass is the policy; having no record of what that pass owes was
the bug. v0.6.0 and v0.7.0 both shipped 82 keys short in those ten, and the number reached 84
with nothing anywhere noting it had moved. `ui/shell/core/i18n/translation-state.json` is the
record — committed, machine-managed — and the gate fails when it no longer matches the catalogs,
so **a PR that adds an untranslated string carries the new count in its own diff**.

It tracks the invisible failure too. A key can be present *and* wrong: translated once, then the
English rewritten underneath it. That renders a confident sentence that no longer matches the
product, which is worse than the English fallback a missing key gives you — and nothing could
detect it, because nothing recorded which English a translation was made from. The ledger stores
a hash of every English string as of the last reconciliation; when one changes, every locale still
holding the old wording is listed as `stale`.

⚠️ **`--sync` and `--translated` are not interchangeable.** `--sync` is bookkeeping and never
claims a translation is current; `--translated <locale>` is the only thing that clears a locale's
stale list, and it is a statement of fact about work you actually did. Equally, never "start
clean" by deleting the ledger and re-syncing — with no prior basis, every translation is declared
current and all outstanding drift disappears silently. It was seeded (2026-08-17) by walking each
locale's git history for the English in effect the last time each key's translated value changed;
rebuild it that way or not at all.

Hard failures, independent of the ledger, because these must always be zero: a catalog that does
not parse or yields < 50 keys, a duplicate key inside a catalog (the later one silently wins), an
orphan key left behind by a retired English one, an `en` key missing from `es`, and a
greeter/lockscreen mini-catalog missing a language or a key (those two are duplicated per bundle
by hand, so their parity is checked rather than assumed).

### Fonts & CJK variants

The UI font is **Inter** (ThemeManager seeds `Inter 11` into the `font-name` gsetting on first
boot only — a user's explicit pick is never clobbered; `syncFont()` turns it into
`* { font-family: "<pick>", "Symbols Nerd Font", sans-serif; }`). CJK and emoji render through
Pango's **per-glyph fallback** — `noto-fonts-cjk`/`noto-fonts-emoji` are hard deps in both install
channels — so there is no per-language font switching and none is needed.

Which **regional Han variant** (SC/TC/JP/KR/HK) serves those fallback glyphs is decided by
`config/fontconfig/65-0-nidara-noto-cjk.conf` (shipped by the pacman package AND install.sh §6 as
`/usr/share/fontconfig/conf.avail/…` + symlink in `/etc/fonts/conf.d/`). **The `65-0-` filename is
load-bearing**: fontconfig's own `65-nonlatin.conf` hardcodes the KR face in its fallback list, and
among fallback families earlier list position wins — renamed to `70-` the rules load but every CJK
locale still gets Korean stroke forms (full story in the file's header). The text language comes
from `LANG` (Settings → Region), so verification is
`fc-match "sans-serif:lang=ja"` → `Noto Sans CJK JP` (and SC/TC/HK/KR for zh-cn/zh-tw/zh-hk/ko).

The **greeter** runs with an empty greetd env (no `LANG` → "C" locale), which used to leave its
clock in English and its kanji on the wrong regional face. It now sets its OWN process locale via
GJS's built-in gettext module (`imports.gettext.setlocale`, reached through the legacy `imports`
global so the bundler never sees a bare specifier): `initProcessLocale()` in
`ui/greeter/lib/i18n.ts` maps the UI language (saved pref → `LANG` → `/etc/locale.conf` → en) to
its glibc locale (`GLIBC_LOCALES`, the exact set nidara-setup generates). **Call-site is
load-bearing**: it must run inside `app.start`'s `main()` — GTK's init calls
`setlocale(LC_ALL, "")`, so a module-level call gets silently reset to "C" before first render.
The language dropdown re-applies it live and `dateNames.refreshDateFormat()` re-probes the date
order/separators (greeter-only export; %x reads the process locale, so a live switch must
re-probe). Strings + dates update instantly; the Han glyph *face* follows on the next greeter
start (Pango caches the process language). Fail-soft: an ungenerated locale leaves setlocale
returning null and everything stays as before.

### Testing Wi-Fi without a Wi-Fi adapter

The Network settings page only exercises when a Wi-Fi device exists. On a wired-only box,
simulate one with the kernel's `mac80211_hwsim` (virtual 802.11 radios that NetworkManager
treats as real). A dev helper lives at `scripts/dev/fake-wifi.sh` (start/stop a WPA2 AP).
The recipe:

```bash
sudo modprobe mac80211_hwsim radios=2     # → wlan0 + wlan1; not persistent across reboot
sudo pacman -S hostapd                    # broadcaster
nmcli radio wifi on                       # radios boot "unavailable" until wifi is enabled
sudo scripts/dev/fake-wifi.sh start       # AP "NidaraTest" / pass nidara123
# Settings → Network → Scan → connect
sudo scripts/dev/fake-wifi.sh stop
sudo modprobe -r mac80211_hwsim           # and delete the NidaraTest profile you just saved
```

**A wired-only box is not a worse rig for this, it is the BEST one** — `modprobe` /
`modprobe -r` on a machine with no real wireless is a hot-plug you can do twice a minute,
which is how tech-debt #22/#71 was finally closed (A→B→A with Settings open and no shell
reload). Watch the bar icon too, not just the page: network presence reaches three surfaces.

Non-obvious traps this setup exposes, all of which bit real code:

- **The shell watches exactly ONE Wi-Fi device.** `NetworkService.pickDevice()` prefers a
  device with an active connection, else returns the **first** of that type (`wlan0`) — the
  rule inherited from AstalNetwork's `get_device()` and kept on purpose. So the *fake AP must
  run on `wlan1`* and `wlan0` stays the managed client — otherwise the page watches the
  broadcaster and sees an empty AP list while `nmcli` on the other interface sees everything.
- **The world regulatory domain `00` sets `NO-IR` on 2.4 GHz**, which silently stops
  hostapd from ever beaconing — the interface stays `type managed` instead of `type AP`.
  Pin a real country first (`iw reg set ES`, also `country_code=` in the hostapd conf).
- **The radio flag lives on the CLIENT, not on the device**: `enabled` is
  `NM.Client.wireless_enabled`. With no wireless hardware at all NM reports it **false**,
  which is why `Net.wifiEnabled()` answers `true` when there is no adapter — absent is not
  off, and the bar must not paint a "radio off" icon on a machine that never had a radio.
- **DHCP lands after the SSID.** `notify::active-access-point` fires well before an address
  exists, so anything showing an IP must also watch the device's `ip4-config` (that is the
  difference between `watchWifiNetwork` and the wider `watchWifi`).

### Testing Bluetooth without a Bluetooth adapter

`AstalBluetooth` talks to **BlueZ over the system D-Bus**, so (unlike Wi-Fi's real
`mac80211_hwsim` radio) you fake the whole `org.bluez` service with **python-dbusmock**'s
`bluez5` template — the same approach GNOME uses for its BT panel. Dev helper:
`scripts/dev/fake-bluetooth.sh` (needs `pacman -S python-dbusmock`; run as root — it
stops `bluetooth.service` and owns `org.bluez`).

```bash
sudo scripts/dev/fake-bluetooth.sh start   # adapter + Keyboard/Mouse (paired) + Phone (nearby)
# Super+Shift+R, then Settings → Bluetooth
sudo scripts/dev/fake-bluetooth.sh stop    # restores real bluetooth.service
```

The bluez5 template has **two quirks the script works around**, plus one hard limit:

- **`StartDiscovery` throws `KeyError: 'DiscoveryFilter'`** — the template reads that
  adapter prop without initialising it. The script seeds it with an empty
  `Adapter1.SetDiscoveryFilter` after `AddAdapter`, so the Scan button works.
- **`Device1.Connect`/`Disconnect` (what the UI buttons call) update an internal
  `device.connected` *attribute* + emit `PropertiesChanged`, but NOT the property store**,
  while the `Mock.ConnectDevice` *control* method does the opposite. Mixing them desyncs a
  device (the guard then raises `AlreadyConnected`/`NotConnected` and the click silently
  no-ops). So the script creates devices **paired-but-disconnected** and never pre-connects.
  Live connect↔disconnect then works within a session, but **after a UI reload a device
  reverts to disconnected** (the store was never updated) and reconnecting can stick —
  `stop && start` the mock to reset.
- **Pairing is "just works" only** — the template's `Pair` never calls back into a
  registered `Agent1`, so the passkey/PIN dialogs (the shell's pairing agent in
  `BluetoothService`) can't be exercised with this mock. Test those by calling the agent
  directly as root (`sudo busctl` recipe in `architecture.md`) or with real hardware.
- **`RegisterAgent` errors `AlreadyExists: Another agent is already registered`** after the
  first shell (re)load — the mock remembers the first registration forever and never cleans
  up on disconnect (real BlueZ tracks the sender and auto-unregisters). Benign, but it means
  agent registration can only be observed on the first load after `start`.
- **The mock outlives dev sessions.** It's a root daemon; nothing stops it when you move on,
  and every BT (and battery — `fake-battery.sh` mocks UPower the same way) symptom you debug
  afterwards is the mock's, not the real stack's. When BT/battery behaves oddly, FIRST check
  who owns the name: `busctl --system status org.bluez` (a `python3 -m dbusmock` PID = mock
  still up → `sudo scripts/dev/fake-bluetooth.sh stop`).

This setup surfaced a real latent bug, fixed in `BluetoothService.setPowered`:
`AstalBluetooth.Bluetooth.is_powered` is **read-only** (writing it throws "not writable"),
so the old `bt.is_powered = state` toggle flipped the switch visually but never powered the
radio. Drive `bt.adapter.powered` instead.

### Testing media players (MPRIS) without making a sound

`scripts/dev/fake-mpris.js` registers a minimal `org.mpris.MediaPlayer2.<name>` player on
the session bus (plain GJS, no deps, no audio). Use it to exercise `core/MediaService`'s
selection heuristic, the source-selector pin menu, and the cover-art chain:

```bash
gjs scripts/dev/fake-mpris.js fakeA "Aurora" "Red track" "Artist A" "<data:-URI>" Playing kitty
gjs scripts/dev/fake-mpris.js fakeB "Boreal" "Blue track" "Artist B" "https://github.com/nidara-project.png" Playing
playerctl -p fakeB pause      # drive status flips (Playing beats Paused in the heuristic)
```

Recipes for generating the `data:` art URI are in the script header. Its `Position` advances
with the clock while Playing, `Seek`/`SetPosition` move it and emit `Seeked`, and
`FAKE_MPRIS_NO_TRACKID=1` drops `mpris:trackid` — the case where `SetPosition` is a documented
no-op and a client has to fall back to a relative `Seek`. All art now resolves through
`core/MediaService`'s own chain into `~/.cache/nidara/media-art/`; the `player.vala … Failed to
cache cover art` CRITICALs that used to accompany every `data:`/`https:` track were AstalMpris
and are gone with it (2026-08-17).

**The layer underneath has its own probe.** `core/mpris.ts` talks to the session bus, so it can
be exercised without the shell:

```bash
ags bundle --gtk 4 scripts/dev/mpris-probe.ts /tmp/mpris-probe
/tmp/mpris-probe            # from the repo root; spawns its own fakes → PROBE-RESULT ALL PASS
```

It asserts the roster (appear/leave + the listener MediaService subscribes with), the metadata
and root-interface reads, both seek paths, and — the one that is a measurement rather than a
check — that **3 s of playback emit zero `notify`**. Position is extrapolated from an anchor
instead of polled, so a playing player is silent; if that check ever counts signals again,
something started polling. ⚠️ `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent /tmp/mpris-probe`
is the negative control — it must report FAIL.

### Exercising BlueZ without a Bluetooth adapter

`core/bluez.ts` talks to `org.bluez` on the SYSTEM bus, so it can be driven without
the shell — and without hardware:

```bash
ags bundle --gtk 4 scripts/dev/bluez-probe.ts /tmp/bluez-probe
/tmp/bluez-probe                                  # roster half only
sudo scripts/dev/fake-bluetooth.sh start          # python-dbusmock bluez5
/tmp/bluez-probe                                  # -> PROBE-RESULT ALL PASS (19)
sudo scripts/dev/fake-bluetooth.sh stop
```

Two halves. The **roster** half runs anywhere and asserts the contract that holds
with nothing plugged in: empty lists, false `is_powered`, a null adapter, and
subscribe/dispose that does not throw. The **device** half needs the fake and
asserts the paired/nearby split, a per-device `notify` firing exactly once, and
the power round-trip through `adapter.powered`.

WARNING: the negative control is `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent
/tmp/bluez-probe`, and the FIRST version of this probe did not survive it: "no
adapter" and "no system bus" both produce an empty roster, so all nine roster
checks passed identically either way. Reaching the bus is now a PRECONDITION that
fails hard and stops the run. If you add a check here, ask which of those two
worlds it can tell apart.

**The strongest test is not in the probe.** With the fake up and the shell
running, flip a property from outside and watch the UI move:

```bash
python3 -c "import dbus; dbus.SystemBus().get_object('org.bluez',
  '/org/bluez/hci0/dev_AA_BB_CC_00_00_03').UpdateProperties('org.bluez.Device1',
  {'Paired': dbus.Boolean(True)}, dbus_interface='org.freedesktop.DBus.Mock')"
```

Settings -> Bluetooth must move that device from "Detected" to "Paired" on its own.

### Exercising WirePlumber (`core/wireplumber.ts`)

Unlike the BlueZ/MPRIS probes there are no fakes: PipeWire is running on any
machine with sound, so the probe drives the REAL graph and puts it back.

```bash
ags bundle --gtk 4 scripts/dev/wp-probe.ts /tmp/wp-probe
/tmp/wp-probe                                     # -> ALL PASS (24)
/tmp/wp-probe --linear                            # negative control #1
PIPEWIRE_REMOTE=nonexistent /tmp/wp-probe         # negative control #2
```

It changes the machine's volume and briefly plays silence through `pw-cat`; the
last check asserts the restore landed. It imports `core/wireplumber` and nothing
else from the shell — importing `core/AudioService` would pull in `AppService`,
which needs a display open BEFORE the import (see apps-probe).

🔑 **The check that matters most is the boring one: our volume equals what `wpctl`
prints.** `mixer-api` starts in LINEAR scale and AstalWp set it to CUBIC — measured
on the same sink at the same instant, 0.6361 vs 0.8600. A module that forgets
`scale` is not broken in any visible way; it just reads 64 % where the system says
86 %. That is why control #1 exists: `--linear` makes the probe compare `wpctl`
against a linear reading, and that check MUST go red. Control #2 takes the graph
away, and the precondition must fail hard — an earlier version of the module let it
pass, because a failed connect and a machine with no sound card both look like an
empty roster (the same trap bluez-probe caught).

⚠️ **`Wp.init(Wp.InitFlags.ALL)` takes the whole shell's log away, and nothing
reports it.** `ALL` includes `SET_GLIB_LOG`, which routes ALL GLib logging — every
`console.log` in the shell, not just WirePlumber's — through WirePlumber's writer,
which applies its own level filter. With `WIREPLUMBER_DEBUG` unset (the normal
case) that filter drops MESSAGE level, so from the moment the audio graph comes up
`tail -f nidara-ui.log` goes silent: the last line of every session was
"[ThemeManager] Global Styles READY!", and `[IPC] serving org.nidara.Shell` — a
line that had been there for weeks — simply stopped appearing. `print`/`printerr`
keep working, which is what makes it look like the shell is still logging. The
module therefore passes `PIPEWIRE | SPA_TYPES | SET_PW_LOG` and leaves
`SET_GLIB_LOG` out; the flag exists for CLIs like `wpctl` that want one log format
for their own output. **Symptom to recognise: the log stops mid-startup with no
error.** Confirm with `WIREPLUMBER_DEBUG=M` — the missing lines come back in
WirePlumber's format.

⚠️ Two more GJS facts about libwireplumber, both of which cost a debugging round:
`Wp.init()` installs that writer, so calling it TWICE in one process aborts
(`g_log_set_writer_func() called multiple times`) — the probe must not re-init what
the module already did, and that stays true with the narrower flags. And
`Wp.Core`'s `connect`/`disconnect` are PipeWire's, not
GObject's: `core.connect("disconnected", cb)` does not throw, does not warn, and
does not attach the handler. Use `GObject.Object.prototype.connect.call(core, …)`.
That is the exact case `watchDevices` exists for — `notify::devices` covers only
add/remove, so an in-place pairing change would otherwise leave the device in the
wrong list until a full rebuild.

### Exercising the notification server (`core/notifd.ts`)

The shell IS this desktop's notification daemon, so the probe has to BE the server
too — it brings the module up and then talks to it over D-Bus exactly as
`notify-send` does.

```bash
ags bundle --gtk 4 scripts/dev/notifd-probe.ts /tmp/notifd-probe
XDG_CACHE_HOME=$(mktemp -d) dbus-run-session -- /tmp/notifd-probe    # 32 checks
```

⚠️ **Both wrappers are load-bearing and the probe refuses to run without them.**
`dbus-run-session` gives it a private bus — on the real session bus the running
shell owns `org.freedesktop.Notifications` and the probe would lose that race and
test nothing. `XDG_CACHE_HOME` points the store somewhere disposable — without it
the probe writes its test notifications into the user's own
`~/.cache/nidara/notifd/state.json` and they appear in the NC.

Three controls, each failing on a DIFFERENT line (an empty roster looks identical
in all of them, which is the whole reason they are separate):

```bash
XDG_CACHE_HOME=$(mktemp -d) DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent /tmp/notifd-probe
    # → "the session bus is reachable" fails
XDG_CACHE_HOME=$(mktemp -d) /tmp/notifd-probe        # no dbus-run-session
    # → "we own org.freedesktop.Notifications" fails: the shell holds it.
    #   Same state a user gets with dunst or mako left running.
dbus-run-session -- /tmp/notifd-probe                # no XDG_CACHE_HOME
    # → refuses outright rather than writing into the real store
```

⚠️ **A probe that is also a server must call the bus ASYNCHRONOUSLY.** The first
version used `call_sync` and deadlocked on its own first `Notify`: the call blocks
the main loop that has to dispatch the method being called. ⚠️ And start `main()`
from a `GLib.idle_add`, not directly — the precondition checks run before the
first `await`, so a failing precondition called `loop.quit()` on a loop that had
not started, and the probe hung instead of refusing.

To watch the real thing instead, `notify-send` covers every branch:

```bash
notify-send -a Discord -u critical "Critical" "never auto-expires"
notify-send -t 3000 "Expires" "server-side timeout"                 # gone in 3 s
notify-send "Transient" "banner only" --hint=int:transient:1        # no NC row
notify-send "Hero" "" --hint=string:image-path:/path/to.png
python3 -c '...'   # image-data: raw pixels, decoded to ~/.cache/nidara/notifd/images/
cat ~/.cache/nidara/notifd/state.json | python3 -m json.tool
```

### Exercising the system tray (`core/tray.ts` + `core/dbusmenu.ts`)

The shell IS this desktop's StatusNotifierWatcher, so — like the notification
probe — this one has to BE the watcher, and it brings its own tray app
(`scripts/dev/fake-sni.js`, a real SNI item with a real dbusmenu).

```bash
ags bundle --gtk 4 scripts/dev/tray-probe.ts /tmp/tray-probe
dbus-run-session -- /tmp/tray-probe            # from the repo root → 35 checks
```

⚠️ **`dbus-run-session` is load-bearing and the probe refuses without it.** On the
real session bus the running shell owns `org.kde.StatusNotifierWatcher`, so the
probe would quietly become a mere host and measure the SHELL instead of itself.

Three controls, each failing on a DIFFERENT line:

```bash
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent /tmp/tray-probe
    # → precondition 1: no session bus at all
/tmp/tray-probe                                 # no dbus-run-session
    # → precondition 2: the watcher name is already owned
dbus-run-session -- /tmp/tray-probe --astal     # the library being replaced
    # → 6 RED. It is evidence, not just a control (see below).
```

🔑 **What `--astal` turns red is the changelog of this replacement**: a
`visible: false` row is DRAWN, a submenu arrives with NO children (and a third
level never at all — the translator walks `GetLayout` one level at a time,
asynchronously, so a consumer that flattens the model on render sees an empty
submenu), `ItemIsMenu` defaults to true, `ItemsPropertiesUpdated` emits no
`items-changed`, and killing an app that published TWO items from one connection
leaves the first icon stuck in the bar forever.

The fake is also usable by hand — run it inside a live session and an icon appears
in the bar:

```bash
gjs scripts/dev/fake-sni.js --deep      # extra submenu level
gjs scripts/dev/fake-sni.js --pixmap    # no IconName, only ARGB32 pixels
gjs scripts/dev/fake-sni.js --two       # one app, two icons
```

⚠️ **A GVariant already built cannot be a member of a format string.** Writing
`new GLib.Variant("(ia{sv}av)", [id, propsVariant, kids])` in the fake threw
INSIDE the D-Bus method handler, so the handler never replied and the module under
test saw a plain TIMEOUT — indistinguishable from "the host never called". Tuples
containing built variants go through `GLib.Variant.new_tuple`. That cost a full
debugging round, which is why every handler in `fake-sni.js` now runs inside a
`guard()` that turns a throw into a D-Bus error: **a fake that fails silently is
worse than no fake, because its silence is attributed to the code you are
testing.**

### Checking app search without opening the launcher

`core/app-search.ts` decides what the app grid and Prism show for a query, and eyeballing a
launcher proves nothing about the 55 apps that did NOT come back.

```bash
ags bundle --gtk 4 scripts/dev/apps-probe.ts /tmp/apps-probe
/tmp/apps-probe             # from the repo root → PROBE-RESULT ALL PASS
```

Two halves. The **fixture** half states the ranking rules against a hand-written catalogue, so no
installed app can quietly satisfy them. The **live** half runs the same questions over this
machine's real `.desktop` files, including a sweep asserting that every installed app's own name
ranks it first, and the check the whole replacement is about: **no result may be justified only by
its `Exec=` ARGUMENTS**.

⚠️ Two negative controls, and this probe is worth nothing without them:

- `/tmp/apps-probe --astal` answers the live half with `gi://AstalApps`, the library we removed.
  It must FAIL the one-character checks (it returns 56 of 56) and the `Exec=` checks. Keep the
  mode as long as the lib is still installed anywhere — it is the evidence, not just a control.
- `XDG_DATA_HOME=/nonexistent XDG_DATA_DIRS=/nonexistent /tmp/apps-probe` takes the desktop
  files away: the live half must go red while the fixture half stays green. If both stay green,
  the live half is reading nothing.

Note `scripts/dev/gtk-init.ts`: a probe that imports `core/AppService` needs a GTK display open
BEFORE the import runs (the service builds an icon theme in its constructor), and `Gtk.init()`
written inline is too late — ES import declarations all execute first. Import that module first.

### Exercising the compositor state layer WITHOUT restarting the shell

`core/HyprlandState.ts` is the shell's model of Hyprland, and reloading the shell to test it
means blinking the user's desktop. `scripts/dev/hypr-state-probe.ts` runs the same module in a
process of its own:

```bash
ags bundle --gtk 4 scripts/dev/hypr-state-probe.ts /tmp/hypr-probe
/tmp/hypr-probe 15      # then drive Hyprland from another terminal
```

⚠️ **Drive it with `hyprctl dispatch "<lua>"`, not `hyprctl dispatch workspace 2`.** With the
Lua config the classic syntax dies as `')' expected near '2'` — and the other near-miss is
silent: `hyprctl eval "hl.dsp.focus({ workspace = 2 })"` prints **ok and does nothing**, because
`hl.dsp.*` BUILDS a dispatch descriptor and `eval` throws it away. `hyprctl dispatch` wraps the
argument in `hl.dispatch(…)`, which is what actually performs it — the same call `_dispatch`
makes. Both wrong forms were mistaken for a broken state layer for a while.

What the probe is for is telling the two signals apart:

- `"changed"` = structural (focus, workspace, open/close, geometry, **FSMODE**),
- `"title-changed"` = a window renamed itself and nothing else.

Measured live 2026-08-17: a terminal running a spinner produced **14 `title-changed` and 0
`changed`** in 14 s — a rename must never repaint the bar and dock. And driving
maximized → fullscreen → none → maximized produced a `changed` for every FSMODE transition,
including the one where the window already filled the monitor and **did not move a pixel**.
That case is why `fullscreen` is in the state signature.

🔑 **The negative control is `HYPRLAND_INSTANCE_SIGNATURE=nope`**: the IPC layer must report
`[HyprIPC] event socket connect failed` rather than quietly showing an empty desktop. Silence
there is the tech-debt #71 failure mode wearing compositor clothes.

### Testing the battery widget on a desktop (no battery)

`core/BatteryService.ts` reads UPower's composite **DisplayDevice** (through
`UPowerGlib`, direct — AstalBattery was dropped 2026-08-17), so on a
desktop (`is_present = false`) the battery tiles only render a dim fallback icon and the
Cairo glyph can't be seen. Fake it with python-dbusmock's `upower` template via
`scripts/dev/fake-battery.sh` (run as root — it stops `upower.service` and owns
`org.freedesktop.UPower`):

```bash
sudo scripts/dev/fake-battery.sh start 72              # 72% discharging (neutral fill)
sudo scripts/dev/fake-battery.sh start 10 discharging  # low → red fill + "low" warning
sudo scripts/dev/fake-battery.sh start 45 charging     # green fill
sudo scripts/dev/fake-battery.sh start 100 full        # fully charged
sudo scripts/dev/fake-battery.sh stop                  # restores real upower.service
```

**Policy gotcha (why not `SetupDisplayDevice`):** UPower's D-Bus system policy
(`/usr/share/dbus-1/system.d/org.freedesktop.UPower.conf`) whitelists `send_interface` to
Introspectable/Peer/Properties/UPower[.Device] — the dbusmock control interface
`org.freedesktop.DBus.Mock` is **not** in it, so the template's `SetupDisplayDevice` method
is **"Access denied"** (bluez5 works only because `org.bluez`'s policy is permissive). The
script instead seeds the DisplayDevice via `org.freedesktop.DBus.Properties.Set` (whitelisted),
which dbusmock honours. Re-running `start` with new values **re-seeds live** (the glyph
updates without a reload — `Set` emits `PropertiesChanged`). Only the **first** `start` flips
`is_present` false→true, which `buildContent` reads at build time — so reload once
(Super+Shift+R) after the first start, then change values freely.

**Range gotcha:** UPower's `Percentage` is **0–100**, and every consumer here is written
against a **0–1 fraction** — `Battery.fraction()` does that division (AstalBattery used to,
which is why the convention exists). Reading `device.percentage` straight renders a 47%
battery as a full one; an earlier `Math.round(bat.percentage)` in the detail panel was a
latent "0%/1%" bug of the same family, hidden only because desktops never showed it.

⚠️ **Prove the notify path, not just the numbers.** A service that reads its device once
looks perfect in a screenshot and is frozen from boot (tech-debt #71). `gjs
scripts/dev/battery-probe.js [seconds]` prints the DisplayDevice and then logs every
`notify::` it receives; re-seed the mock while it watches and expect
`PROBE-RESULT LIVE — n notify tick(s)`. With no mock and no battery it correctly reports
`NO TICKS` — nothing is changing — so run it against the mock or the result means nothing.

🔑 **AstalBattery had no `charged` property**, only `charging`, which was true at
FULLY_CHARGED *as well as* CHARGING. `widgets/battery.ts` read `bat.charged` anyway, so the
"Charged" branch was dead and a laptop at 100% on AC read "Charging" forever.
`BatteryService` keeps `charging()` and `charged()` strictly apart; callers that meant "not
draining" (the critical-battery activity, and the glyph's bolt, which means *on AC*) ask for
both explicitly.

### Testing the built-in Assistant (`nidara-agent`) without a key or network

`bin/nidara-agent` is the assistant's brain (BYOK LLM tool-use loop over stdio — see
`state-and-ipc.md`). Exercise it headlessly with `scripts/dev/fake-brain.py`, a scripted
OpenAI-compatible SSE mock (same spirit as the other `fake-*` helpers) that plays exactly one
tool-use round-trip:

```bash
# 1) point an ISOLATED config at the mock (don't touch the real ai.json — the daemon
#    reads $XDG_CONFIG_HOME/nidara/ai.json, but `nidara-ipc` still hits the live shell):
mkdir -p /tmp/tc/nidara
printf '{"brainBackend":"openai","brainModel":"mock","brainEndpoint":"http://localhost:11435/v1"}' \
  > /tmp/tc/nidara/ai.json
# 2) run the mock (default = a harmless read: get_config appearance.accent):
python3 scripts/dev/fake-brain.py &
# 3) feed the daemon a user message, keeping stdin open, and read the event stream:
{ printf '{"t":"user","text":"what accent am I using?"}\n'; tail -f /dev/null; } \
  | timeout 15 env XDG_CONFIG_HOME=/tmp/tc gjs -m bin/nidara-agent
# expect: state thinking → acting → tool get_config → toolresult {...value:"blue"} →
#         thinking → delta "Done." → done{usage} → idle
```

Env on the mock scripts the tool call: `FAKE_BRAIN_TOOL` / `FAKE_BRAIN_ARGS` (JSON) /
`FAKE_BRAIN_FINAL`. Two gotchas (both proven 2026-07-20):
- **The write gate is enforced by the SHELL, not the daemon.** The shell checks its OWN
  `allowConfigWrite` (from the REAL `ai.json`), so a test config with `allowConfigWrite:false` does
  NOT stop a `set_config` — the daemon's tool hits the live shell and really writes (a `set_config`
  mock DID toggle night light for real; revert with `nidara-ipc setConfig … false`). To prove the
  daemon **surfaces a rejection** without mutating anything, script an **invalid value** (e.g.
  `nightlight.enabled=banana`): the shell's validator refuses, the daemon relays the error string,
  the model reports it, nothing changes.
- **Don't drive the daemon over a plain `subprocess` pipe with Python `readline`** — gjs's stdout
  buffered oddly there; the `{ printf …; tail -f /dev/null; } | gjs` shell form is what worked. The
  `timeout` killing the still-alive daemon (exit 124) is expected — it waits for more stdin.

**Reading what happened.** Both halves log into `nidara-ui.log` (the daemon over the shell's
inherited stderr), so one grep replays a whole session:

```bash
grep -E '\[(nidara-)?[aA]gent' "$XDG_RUNTIME_DIR/nidara-ui.log"
# spawn → turn start (provider/backend/model) → step N POST host → step N ok=… text=…c tools=…
# → tool <summary> → ok/FAIL → turn end (steps, tokens, ms) → daemon gone (exit N | signal N)
```

Prompts and replies are deliberately NOT logged (length only), so this is safe to paste into an
issue. When a report says "it did nothing", this is the first thing to ask for.

**Testing the abnormal ends** (the "a turn must never end in silence" invariant): point the config
at a dead port for a curl failure; `FAKE_BRAIN_FINAL=""` for an empty completion; a mock that always
streams a `tool_calls` chunk for the `MAX_STEPS` cap; `pkill -f nidara-agent` mid-turn for the
shell-side death path. Each must land a visible line in the island — never an empty bubble.
**Gotcha that cost real time here:** `pkill -f fake-brain.py` **kills the calling shell too** — the
tool's own command line contains the pattern. Use a pattern that can't match itself
(`pkill -f 'python3 .*brain[.]py'`) or kill by PID.

**CI gate (`agent-loop` in ci.yml → `scripts/ci/agent-loop-test.py`).** The manual walk above is
now also a hermetic regression test — the every-serious-bug-was-a-wire-shape-bug lesson turned into
a gate. It spawns the real daemon (gjs) against an in-process OpenAI-compatible mock under a temp
`XDG_CONFIG_HOME` **and a temp `XDG_STATE_HOME`**, with a stub `ags` on `PATH` so a tool call returns
a value with no live shell (an empty `brainProvider` keeps it off the keyring/D-Bus).
**Both temp dirs are load-bearing, and the second one was learned the hard way.** The daemon restores
its session from `XDG_STATE_HOME` at startup, so leaving that one real made "spawn a fresh daemon" a
lie: the earlier scenarios' history arrived in scenario 3's *first* request, the stub `curl` reads
"this is round 2" off a `tool_result` appearing **anywhere** in the messages, and the round-trip under
test silently never happened (`session restored: N entries` in the failure telemetry is the tell). It
was also reading and overwriting the developer's own conversation on every local run. **Anything you
teach the daemon to persist needs its directory isolated here in the same change.** It asserts the tool-use loop end to end (tool
call parsed, split args accumulated, tool dispatched, final text streamed) **and both halves of the
transient-failure policy**: a scripted **503 is retried** past, a **4xx surfaces without retry**.
Runs on `ubuntu-latest` with only `gjs` + `gir1.2-secret-1` (no Arch container). When you add a wire
quirk worth locking in (the next Gemini-shaped surprise), add a scenario to the mock rather than
trusting a live session to catch the regression.

**Scenario 3 tests the ANTHROPIC lane with a stub `curl`, not a mock server.** `buildAnthropicReq`
hardcodes `api.anthropic.com` on purpose — an env-settable base URL would be a place to redirect a
user's API key — so there is nothing to point at a local socket. A stub `curl` on `PATH` (same trick
as the stub `ags`) reads the body off stdin, **writes it to disk**, replays a canned Anthropic SSE
stream, and mirrors the `nidara-http:` marker on stderr. The assertions then run against the captured
**bytes**: thinking block echoed first and unmodified, signature identical, no `cache_control` on it,
`tool_use` still present, `tool_result` in the follow-up. That is how a lane with **no key available**
gets real end-to-end coverage — and it is checkable: remove the echo in `toAnthropicMsg` and the
scenario fails with `thinking block not echoed first`.

**Transient-failure retry (the daemon, `streamCurl`/`runTurn`).** A 5xx, **429/408/409**, or a
dropped/refused connection is retried up to `MAX_HTTP_ATTEMPTS`, because it is usually transient and
tools run only AFTER the stream closes, so nothing was half-applied. **429 was missing until
2026-07-25** and it is the single most likely transient failure for a user on a new key or a free
tier — it used to arrive as a hard error mid-conversation. The retryable set matches what the
providers document (Anthropic: 408/409/429/5xx + connection errors; the OpenAI-compatible endpoints
use the same codes), so all three lanes share one policy. Guards, all load-bearing: retry only
**before any delta was streamed** (else the reply double-renders — `deltasEmitted` is the guard);
never retry any other **4xx** or a **full timeout** (curl exit 28 — re-running a 120 s hang thrice
just triples the wait); and **honour `retry-after`** when the provider sends it, except past
`RETRY_AFTER_MAX_MS` (15 s), where sitting silently is worse than showing the provider's own message.
Status and `retry-after` both come back on curl's **stderr** via
`-w '%{stderr}nidara-http:%{http_code} nidara-retry:%header{retry-after}'` (000 → network-level
failure; the header's HTTP-date form simply won't match the digit regex and falls back to linear
backoff), kept off the SSE stdout stream on purpose. Handler is re-created per attempt (a failed leg
may hold partial state).

### Re-syncing a wire lane against its provider (the defined procedure)

The three lanes in `bin/nidara-agent` are **our** code speaking someone else's protocol, by choice
(zero runtime deps). The cost of that choice is exactly one recurring chore: when a provider moves,
we re-sync. Doing it as a defined pass is the difference between an afternoon and a week — the
Gemini episode of 2026-07-21 cost three defects in one day because the protocol was inferred from
error responses instead of read. **Never diagnose a provider by trying things.** The order is:

1. **Read the authoritative source, not the error.** Anthropic → the bundled `claude-api` skill,
   plus the docs pages with a `.md` suffix for clean markdown (`streaming.md`, `thinking*.md`,
   `handling-stop-reasons.md`). Gemini → the Interactions **OpenAPI JSON**
   (`curl -sL https://ai.google.dev/static/api/interactions.openapi.json` + `jq .components.schemas.X`;
   WebFetch truncates the 331 KB). OpenAI-compat → `openai-python`'s stream accumulation, which is
   the de-facto spec every compat endpoint is written against.
2. **Diff six things per lane**, in this order — they are where every bug has been:
   request shape · stream event/delta **names** · **opaque state the provider demands back verbatim**
   (thought signatures, thinking blocks — the most expensive class, twice now) · usage field names and
   whether cached tokens are inside or outside the input count · stop/finish values *and* what the
   loop keys off · the retryable status set.
3. **Transcribe, don't adopt.** Port the behaviour into the GJS handler; keep the comment that says
   which documented rule it implements, so the next reader can re-verify without re-deriving.
4. **Lock it into `agent-loop`** as a scenario, then prove the scenario earns its place: break the
   fix on purpose and watch it fail. A test that passes with and without the fix is worse than none.
5. **Say what is still unknown.** A lane verified against a reference is not a lane verified in
   production; write that down rather than implying coverage that isn't there.

Symptoms that mean a lane has drifted: follow-up turns come back **empty** (dropped opaque state),
tool calls **vanish** (keying off a status field instead of presence), a **400 on the second step**
of a tool turn (rebuilt assistant message), usage that looks too **cheap** (unread sub-buckets).

**CI girs note:** the daemon + `Settings → AI` import `gi://Secret` (libsecret). It's already
installed (transitive) so `@girs/secret-1.d.ts` exists locally, but if CI typecheck ever complains
about `gi://Secret`, the `ci-assets` girs snapshot needs a refresh (`scripts/dev/publish-ci-typings.sh`).

### Testing the Assistant's PERCEPTION of a live app (the terminal bench)

`agent-loop` covers the wire; the mock cannot cover whether the model **looks** when it should.
That failure is invisible in the island — a stale answer and a fresh one render identically — and it
is what this bench exists to catch. Setup: a coding agent runs in a terminal, the Assistant is asked
to read that terminal, and the operator at the keyboard is the other side of the conversation. It
earned its place by finding a real defect (PR #66: with an earlier `query_app` in history the model
answered a live question from a dead screen, `steps=1 tools=0`), and the procedure below is what made
that measurable rather than anecdotal.

**Use a terminal that publishes a tree.** `gnome-terminal` (VTE) exposes the visible screen as one
`role: "terminal"` text node; **kitty publishes nothing at all** — it is absent from the registry, not
empty. The tree comes from the EMULATOR, never from the program inside it. `--ax-screen-reader` on
`claude` is **not** needed; the raw TUI reads fine.

**Mint the token inside the test, and put it in the terminal's INPUT LINE.** The check is always "can
it read something it cannot have known", so the value must not exist before the run. It cannot be
printed as prose either: a TUI collapses tool calls to one line and flushes prose at the **end** of a
turn, so the operator's messages are not on screen at the moment the agent reads, and earlier ones have
scrolled past the cap. The prompt box is the only region that is both visible and stable.

**Verify each hop before the next one, or the run proves nothing:**

```bash
# 1) the token is where the agent will look — through the SAME path it uses
nidara-a11y org.gnome.Terminal | jq -r '.nodes[]|select(.role=="terminal").text' | grep -q "$TOKEN"
# 2) the question actually landed in the island (see below) — BEFORE pressing Return
nidara-ipc queryUI .agent-entry     # its `text` must be your question
```

**Driving the island needs `wtype` directly.** No keyboard verb points at it: `nidara-type` demands an
`<app>` and verifies focus via `hyprctl activewindow`, where a layer surface never appears. In agent
mode the island holds a **compositor focus grab** (`IslandWindow.ts`, via `common/FocusGrab.ts` — it
takes one for every open mode), so synthetic keys reach it — which is also
why hop 2 is mandatory: if the grab wasn't there, you just typed your question into the operator's own
prompt. Clean up with the island **closed first**, then `ctrl+u` — an open island eats the clear.

**Run the whole thing as ONE command.** Every separate tool call that raises a permission prompt
**closes the island**, which is how the first attempt typed into the wrong window. (Auto-accept mode
avoids it, but one script is what makes the run repeatable.)

**Read the verdict from the log, never from the bubble** — `grep -E '\[(nidara-)?[aA]gent'`:
`steps=2 tools=1` means it re-read; `steps=1 tools=0` means it answered from its context and the text
in the island is a coincidence. State is `$XDG_STATE_HOME/nidara/agent/`: `transcript.json` is
`{version,updated,transcript:[{role,text,tools}]}` (the UI's view — poll it for the answer) and
`session.json` holds the daemon's `history` (the model's context — check the stale copy is really in
there). Guard the run by asserting that shape before touching anything.

**To test a fix for a VOLATILE read, the stale copy has to still be in `history`** — same conversation,
same question, changed screen. Best case: the source the old read described is **gone** (the terminal
was closed), which leaves the dead copy as the only possible origin of the old answer.

**Every other run needs a NEW conversation** — a carried-over conversation answers from context and
proves nothing. One verb, no shell restart:

```bash
nidara-ipc agentNewConversation      # "conversation ended — N turns dropped"
```

It refuses while a turn is in flight (`a turn is in flight — nothing was discarded`); poll
`nidara-ipc dumpState` → `ai.assistant.busy` and retry. **Deliberately unreachable from the
Assistant itself** (`HIDDEN_ACTIONS` in the daemon) — see `state-and-ipc.md`; you drive it, it
cannot drive itself.

**Do not "reset" by deleting the two state files under a live shell — that does nothing.** The shell
holds the conversation in memory and rewrites both at the next turn end, so the deletion is silently
undone and the run you thought was fresh is not. (The old stop → delete → start dance worked for that
reason, not because the shell writes on exit — it does not.) If the shell is already down, deleting
the files is fine.

**Do NOT judge a fix by the turn's total step count — it is dominated by model strategy variance.**
Measured 2026-07-31, same model, same question, three runs: removing four forced steps left the
total at 13, then 16, because the model spent the slack differently (run 1 typed `1847` with
`type_text`; runs 2 and 3 clicked eight digit keys one at a time, one API round trip each). The
metric that isolates OUR cost from the model's choices is **how many steps pass before the first
productive action** — the four wasted steps went to 0 and that number does not move with strategy.
A structural fix should also be proved OUTSIDE the model, deterministically, by driving the verb
from a shell (which is what actually settles it); the live turn only shows it holds in situ.

**Write the deterministic table BEFORE the live re-run — it is where the fix's own bugs are.** On
2026-08-01 the run-3 fix (one tolerant `sameApp` shared by perception and action) was verified first
against a hand-written table of name pairs, positives *and* negatives, asserted symmetrically. It
failed 3 of 11 immediately: the new matcher lowercased its inputs before tokenizing, destroying the
capitals that mark the word breaks in `WidgetFactory` — the exact class of bug it existed to fix. A
live re-run would have shown "still broken" and cost an API turn to say less. Keep the negatives in
the table: a name matcher gets loose long before it gets wrong, and the PWA class
(`chrome-…-Default` vs `google-chrome`) is the cheap canary.

**A subtlety this cost: removing a refusal can remove an affordance.** Before the fix, the focus
refusal pushed the model through `focus_window`, whose description happens to say it is "the
precondition for the synthetic keyboard" — so the model learned `type_text` existed and used it.
With the refusal gone, nothing mentioned the keyboard and both later runs clicked glyph by glyph.
Suspect this whenever an error path is deleted: check what the error was teaching.

**Bring the app up in a known state, and clean up your own contamination.** Two false findings came
from the environment, not the product: gnome-text-editor **restores its session** (it reopened two
of the repo's real files, which a computer-use agent could then type into — disable
`restore-session`, or pick an app with no user data), and a leftover second window makes every node
match twice, which reads exactly like a resolver bug. Count the windows before believing an
"ambiguous" result. `hyprctl dispatch closewindow address:0x…` **fails on this config** — Hyprland's
config is Lua here, so the dispatch is parsed as Lua and errors with `')' expected near 'address'`;
use `nidara-ipc closeWindow` (or `hl.dsp.*` form), and never discard the output of a dispatch you
depend on, or you will read the unchanged state as the app "ignoring" you.

⚠️ **The same Lua trap invalidated a whole A/B on 2026-08-13**, so it is worth stating as a rule
rather than an anecdote: `hyprctl dispatch movecursor 469 756` errors with `')' expected near '469'`,
prints it, and continues. The pointer never moved, the precondition of the experiment ("the cursor is
over the OTHER window") never held, and **both the broken and the fixed build passed**. The form is
`hyprctl dispatch "hl.dsp.cursor.move({ x = 469, y = 756 })"` (verified in
`LuaBindingsDispatchers.cpp` for the exact tag). **When a test depends on a dispatch, assert the
EFFECT and abort when it is missing** — `hyprctl cursorpos` here — instead of assuming the setup
took. See `tech-debt.md` #67.

### Arming the island's region trap (intermittent dead chips)

For "the island's icons sometimes stop taking mouse input". It cannot be reproduced on demand (see
`tech-debt.md` #68 for the paths already ruled out), so the tool is a trap left in the running
session rather than a sweep:

```bash
systemctl --user set-environment NIDARA_ISLAND_REGION_TRACE=1
systemctl --user restart nidara.service
grep -n "island-region" "$XDG_RUNTIME_DIR/nidara-ui.log"     # every stamp; STALE = the bug, caught
```

Each stamp logs `rects=` (rectangles actually unioned) and `hitTargets=` (clickable targets the
stamp could see). A CRITICAL `STALE after #N` means a stamp captured fewer targets than are live
600 ms later with no stamp in between — the dead-chip state, with the sequence that produced it
sitting directly above it in the log. Off by default and free when off. Disarm with
`systemctl --user unset-environment NIDARA_ISLAND_REGION_TRACE` + a restart.

### Testing a live resolution / scale change

The bed for anything that derives a number from the monitor (regions, layout budgets, the overview's
card width). **CI cannot do it** — the smoke boots at one resolution and never changes it — and you
do not do it on your own session either, so it is a VM with a `virtio-gpu-gl` output.

```bash
# NOT `hyprctl keyword monitor …` — "can't work with non-legacy parsers. Use eval."
hyprctl eval "hl.monitor({ output = 'Virtual-1', mode = '1280x720@60', position = 'auto', scale = 1 })"
```

- **Go BOTH ways.** Small → large is the more dangerous direction: a stale *small* clamp cuts a
  large surface, while a stale large one is intersected away harmlessly.
- **Read numbers, not only pixels.** `nidara-ipc dumpState` → `overlays.islandBounds` prices the
  overview against the screen (8px `WO_EDGE_MARGIN` each side: 1903 on 1920, 1263 on 1280), and the
  region trap above prints the stamped rect per target, which is the only way to see the INPUT
  region — a screenshot cannot show you where clicks land.
- **Expect one `TORN` per change, and read it as healthy.** The geometry notification arrives before
  GTK has re-allocated, so the immediate stamp is stale by construction and #138's 50 ms verify is
  what corrects it (`capsule=899` → `TORN` → `capsule=579`).
- ⚠️ **`install.sh --update-apply` on a VM that has no `.git` installs the PREBUILT release** and
  your branch never runs (`tech-debt` and the VM harness README both say it; it is still the easiest
  way to waste an hour). `git init` in the served tree first, then confirm the bundle really moved:
  the shell binary is base64 inside a shell wrapper, so `sed -n 5p <bundle> | base64 -d | grep -c …`,
  never a plain `grep` on the file.

## Persistence

All persistent state lives in `~/.config/nidara/`:

| File | Purpose |
|---|---|
| `theme_settings.json` | Theme engine state |
| `nidara.json` | Token engine config |
| `appearance.json` | Appearance state (+ world-readable mirror at `/var/tmp/nidara/appearance.json` for the greeter) |
| `dock_settings.json` | Dock layout/behavior |
| `dock_pinned.json` | Dock pinned apps |
| `cc_layout.json` | Control Center layout |
| `widgets.json` | CC widget registry/metadata |
| `bar-settings.json` | Bar config |
| `region.json` | Time/date/timezone |
| `gaming.json` | Game-mode config |
| `night-light.json` | Night light schedule |
| `wallpaper` | Current wallpaper path + transition (JSON; reserves a `surfaces` block for per-surface wallpapers — schema in `ui/lib/wallpaper.ts`) |
| `greeter-prefs.json` | Greeter preferences |

### Hyprland config ownership model (settled 2026-06-05 — do NOT re-litigate)

There were multiple conflicting approaches across past sessions. This is the final,
verified-live model. Two tiers, cleanly split:

**SHARED (one for all users, in `/usr/share`):**
- `/usr/share/nidara/config/hypr/hyprland.lua` — the base config. Same for
  everyone; ships with the shell. In `--dev` it's a **symlink → repo**
  (`config/hypr/hyprland.lua`); in `--system` it's a real copy. **Never edit the
  installed copy directly** — edit the repo, it says so in its own header.

**USER (per-user, in `~/.config/nidara/`):**
- `hyprland-user.lua` — personal overrides, **never overwritten** by updates.
  `safe_require`'d LAST so it wins. The `@autostart start/end` marker block inside
  it is managed by **Settings → Apps → Autostart** (`Autostart.tsx`); everything
  outside the markers is the user's free space — but anything hand-written *inside*
  the markers that isn't an `hl.exec_cmd` line is dropped on the next UI write
  (managed-block semantics).
  Resolution caveat: `package.path` in `hyprland.lua` lists `~/.config/nidara/`
  BEFORE `~/.config/hypr/`, and Lua `require()` loads the FIRST match only. The
  Settings page mirrors that order (`resolveUserConf`): it edits the nidara file if
  present, else a legacy `~/.config/hypr/hyprland-user.lua` (pre-2026-07 installs
  wrote there), else creates the canonical nidara one — so the UI always edits the
  file Lua actually loads. Legacy files are edited in place, never migrated.
- `nidara-settings.lua` — UI-generated input/keyboard config (sensitivity,
  `kb_layout`, repeat, touchpad), written by `InputConfig.ts` from the Input page.
- `nidara-monitor.lua` — UI-generated monitor config (output/mode/scale/vrr),
  written by `MonitorConfig.ts` from the Display page.
- `hypridle.conf` — idle config, WRITTEN by Settings → Power (user state; seeded by nidara-setup, suspend listener only on battery hardware).

One seeded config lives OUTSIDE both dirs: `~/.config/kitty/` (from `defaults/kitty/`,
kitty ships no config of its own). `kitty.conf` sets the padding that keeps text clear
of Hyprland's 24px rounded corners, names the shipped JetBrains Mono (kitty doesn't
read the gsettings monospace pref), and enables glass (`background_opacity` +
`dynamic_background_opacity`); the `{dark,light,no-preference}-theme.auto.conf` trio
makes kitty follow the Appearance dark/light toggle live via the settings portal
(kitty ≥0.38 reads `org.freedesktop.appearance color-scheme`, which ThemeManager keeps
as `prefer-dark`/`prefer-light`). Seeded ONLY when the user has no `kitty.conf` at all —
an existing kitty setup is never touched, not even to add the theme files.

**NOTHING goes in `~/.config/hypr/`.** Mainline Hyprland defaults to
`~/.config/hypr/hyprland.lua`, but Nidara deliberately keeps that directory
empty and loads the shared config explicitly via `-c` (see load mechanism below).
A stray `~/.config/hypr/hyprland.lua` is a leftover from older approaches — remove it.
(One tolerated exception: a legacy `~/.config/hypr/hyprland-user.lua` from pre-2026-07
installs keeps working — `package.path` includes that dir as a fallback and the
Autostart page edits it in place when it's the only one. New files are always
created in `~/.config/nidara/`.)

`nidara-settings.lua` / `nidara-monitor.lua` are **live UI-generated config, not
junk** — deleting them is technically safe (`hyprland.lua` uses `safe_require`/pcall,
so missing files don't break boot) but you'd lose real settings (e.g. `kb_layout`)
until the user re-touches that Settings page, which regenerates the file. Don't tell
users to delete them.

### How the shared config actually loads (`-c` through `start-hyprland` — subtle)

Session chain: `nidara` (launcher) → `uwsm start … hyprland.desktop` →
`start-hyprland` (stock hyprland pkg watchdog) → `Hyprland`. To make `Hyprland`
load the `/usr/share` config instead of the `~/.config/hypr` default, the launcher
passes a **DOUBLE `--`**:

```
uwsm start -e -D Hyprland hyprland.desktop -- -- -c /usr/share/nidara/config/hypr/hyprland.lua
```

Why two: `uwsm` forwards args after *its* `--` onto `start-hyprland`; `start-hyprland`
only forwards args after *its own* `--` to `Hyprland`. A single `--` yields
`start-hyprland -c <path>`, which `start-hyprland` swallows → Hyprland silently falls
back to `~/.config/hypr/hyprland.lua`. Don't "simplify" the double dash away
(`bin/nidara`, commit d03c9f1).

Verify which config is live: `cat /proc/$(pidof Hyprland)/cmdline | tr '\0' ' '` →
must show `-c /usr/share/nidara/config/hypr/hyprland.lua`. (Hyprland 0.55.2
logs it as `[cfg] Config is either explicit or special`, NOT the literal phrase
"lua config <path>".)

### Config dir is a real directory, not a symlink (historical footgun)

`~/.config/nidara/` must be a **real directory** holding only runtime config
(the `.json` files + the three `.lua` + `wallpaper` + `.dev`). It is **separate** from
the repo checkout (e.g. `~/Dev/nidara`). Historically it was once a manual symlink → the repo,
which fused the config dir and the git tree and caused a delete incident (an
"organize the config dir" sweep wiped the live checkout). If you ever find it's a
symlink, that's the bug — make it a real dir.

### Env vars

- `~/.config/uwsm/env` + `~/.config/uwsm/env-hyprland` — toolkit/NVIDIA env. **This is where env vars live, NOT in the Hyprland config.** A new contributor's first instinct is to drop env vars in `hyprland.lua`; that's wrong.
- Session-wide env (Wayland backend, `QT_QPA_PLATFORMTHEME=xdgdesktopportal`, GI paths) is exported by the `bin/nidara` launcher itself.
- **GOTCHA — sourcing order:** uwsm **sources** `~/.config/uwsm/env` as a shell, and it does so AFTER the launcher's own exports, so the env file WINS on any conflicting var. (A stale `QT_QPA_PLATFORMTHEME=qt6ct` in the env file was silently overriding the launcher's `xdgdesktopportal` — fixed in `defaults/uwsm/env` + an idempotent migration in install.sh.) Because it's sourced, values with shell metachars must be quoted: `export QT_QPA_PLATFORM="wayland;xcb"` (a bare `;` truncates the var and runs `xcb` as a command).
- **NVIDIA autodetect:** `install.sh` detects NVIDIA hardware + active driver (`lspci` + `lsmod`) and uncomments the GPU env vars in `~/.config/uwsm/env` ONLY for the proprietary/open driver (never nouveau — those `nvidia-drm`/GBM vars break a nouveau/mesa session). It warns (never auto-edits boot) if `nvidia_drm modeset` is off, and informs on hybrid graphics. AMD/Intel need nothing.

### The login keyring — why it must be PAM's daemon, not systemd's

**Symptom when this breaks:** the session comes up fine, then the first thing that wants a secret
(browser, the built-in Assistant, git) prompts for a keyring password the user already typed at
login. Settings → AI still shows a key saved, because the key IS there — the keyring holding it is
locked. The fix is NOT to store the key somewhere else.

The unlock is a two-part handshake, and Arch ships a third party that breaks it by default:

1. `pam_gnome_keyring` (wired into `/etc/pam.d/greetd` by `nidara-setup`) starts
   `gnome-keyring-daemon --login --daemonize` holding the login password. Per the man page,
   `--login` "does not complete actual initialization" — the daemon parks, waiting.
2. `hyprland.lua` runs `gnome-keyring-daemon --start --components=secrets`, the documented
   completion step. **The unlock happens here, not in step 1.** Treating that line as boilerplate
   and dropping it leaves a session whose secrets nobody can read.
3. But before parking, the `--login` daemon probes `$XDG_RUNTIME_DIR/keyring/control` to check
   whether a daemon is already running — and on Arch that exact path is the `ListenStream` of
   `gnome-keyring-daemon.socket`, **enabled by preset**. The probe is what starts the rival
   daemon, so discovery always succeeds: the PAM daemon logs `discover_other_daemon: 1`, prints
   its environment and exits *before* reaching `gkd_login_unlock()` (that call lives only on the
   initialize path in upstream `daemon/gkd-main.c`). The socket-activated daemon that survives
   never saw the password. On first login it is worse than a failed unlock: no `login.keyring` is
   created at all, so the user gets a *create-a-keyring* dialog whose password is then whatever
   they typed — and PAM can never open it again.

So `nidara-setup` **masks** `gnome-keyring-daemon.socket` for the user — **and stops it**, which is
not the same sentence twice. `mask` only refuses *future* starts; it never touches a unit that is
already running, and `user@$UID.service` outlives the session whenever lingering is on
(`loginctl enable-linger`, which plenty of tooling sets). A daemon socket-started before the mask
therefore survives logout after logout still owning `$XDG_RUNTIME_DIR/keyring/control`, every later
login repeats `discover_other_daemon: 1`, and the mask reads as inert: the user logs out, logs back
in and reports "nothing changed" (2026-07-26 — only a reboot cleared it). Stop the **socket** first,
because the `.service` `Requires=` it and follows it down, whereas stopping the service alone leaves
the socket listening for the next probe to re-activate. If D-Bus activation re-spawns a daemon
afterwards, that machine needs a **reboot**, not a logout; `nidara-setup` checks for exactly that and
says so instead of reporting success.

**It has to be `mask`, not `disable`** — the trap that eats an afternoon. The socket is routinely
enabled in *global* scope (`/etc/systemd/user/sockets.target.wants/`), and against that a
`systemctl --user disable` is a silent no-op: it reports success, `list-unit-files` still says
`enabled`, and the socket starts anyway. systemd does warn ("enabled in global scope … will still
be started automatically"), which is easy to scroll past. Mask wins in user scope and also survives
`systemctl --user preset-all` (the Arch preset for it is `enabled`). Mask the **socket only**: the
`.service` is only reachable through it, and masking that too would break other desktops sharing
the account that start it deliberately.

**This cannot leave a session without a Secret Service**, which is the objection to check before
touching it: `--start` starts a daemon when it finds none (that is exactly what
`/etc/xdg/autostart/gnome-keyring-secrets.desktop` does), and `org.freedesktop.secrets` stays
D-Bus activatable underneath. The only thing removed is the racer.

Verifying is a **logout/login** (a **reboot** if a rival daemon was already running), not a reload —
nothing about this path is reachable from `Super+Shift+R`, and the CI smoke does not cover it (the
headless boot has no PAM login). Read it back from the journal of the new session:

```bash
gdbus call --session -d org.freedesktop.secrets -o /org/freedesktop/secrets/collection/login \
  -m org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked
# healthy: (<false>,)    broken: UnknownMethod: Object does not exist at path
pgrep -a -f gnome-keyring-daemon      # healthy: ONE, and it is `--daemonize --login` (PAM's)
                                      # broken:  `--foreground --components=pkcs11,secrets` (systemd's)
systemctl --user status gnome-keyring-daemon.service   # must be dead — a running one IS the rival
journalctl -b --since "-5 min" | grep -iE "keyring|discover_other_daemon"
ls -l ~/.local/share/keyrings/login.keyring   # must exist, born at the login minute
```

**`discover_other_daemon: 1` on its own does NOT mean broken** — do not read it as the tell, it
appears in a perfectly healthy session. It is logged by whichever daemon loses the discovery, and in
the working flow that is `hyprland.lua`'s `--start` finding PAM's daemon, i.e. the handshake
succeeding. What distinguishes the two cases is *which daemon survives*, hence `pgrep` above:
`--daemonize --login` in a `session-N.scope` cgroup is PAM's and correct; `--foreground
--components=pkcs11,secrets` under `user@$UID.service/app.slice` is systemd's and is the bug. A
healthy boot reads:

```
greetd[…]: gkr-pam: gnome-keyring-daemon started properly and unlocked keyring
systemd[…]: Started gnome-keyring-daemon.          ← the uwsm scope for hyprland.lua's --start
gnome-keyring-daemon[…]: discover_other_daemon: 1  ← that --start finding PAM's daemon: correct
```

Ignore anything logged for the **greeter's own uid** (`/run/user/955`, `greetd[…]: gkr-pam:
couldn't unlock the login keyring` before the user logs in, plus a `Started GNOME Keyring daemon.`
that stops when the greeter exits). Different user, different runtime dir, unrelated to this.

A `login.keyring` whose birth time is *later* than the session's start was created by a prompt
dialog, not by PAM — its password is not the login password and PAM will never open it. Move it
aside and let the next login recreate it.

**Do not verify with the service's `Collections` property.** It lists `/collection/login` — and
`ReadAlias default` resolves to it — even when that collection was never loaded, which is exactly
the broken state; ask the collection object itself, as above. `Object does not exist at path` is the
signature of *listed but not loaded*, and it fails **asymmetrically**, which is why it gets
misfiled as a UI bug: reads answer instantly ("not found" — there is nothing to search), so
Settings → AI enables its buttons, while the first write must unlock, spawns `gcr-prompter` and
hangs forever (`timeout 12 secret-tool store …` exits 124, and the journal shows the prompter dying
on its own 10-second inactivity timeout). Two causes produce it: a rival daemon (above), or a stale
`user.keystore` whose password is not the login one — `couldn't initialize slot with master
password: The password or PIN is incorrect` in `journalctl --user -u gnome-keyring-daemon`. For the
second, move `user.keystore` and `login.keyring` aside and log in again; PAM recreates both. Only
PAM can, so restarting the daemon by hand never fixes either.

## Default keybindings (from `hyprland.lua`)

| Keys | Action |
|---|---|
| `Super+S` | Settings |
| `Super` (tap) | App launcher (grid) |
| `Super+Space` | Search (Prism) |
| `Super+W` | Workspace Overview (keyboard-navigable: ←/→ move, Enter switch, Esc close) |
| `Super+A` | Assistant (the built-in agent island; Esc closes) |
| `Super+T` | Kitty |
| `Super+E` | Nautilus |
| `Super+L` | Lock |
| `Super+B` | Bar overlay (bar above fullscreen) |
| `Super+Shift+G` | Game mode |
| `Super+Shift+R` | Reload UI |
| `Super+Q` | Close window |
| `Super+F` | Float |
| `Super+Shift+F` | Fullscreen |
| `Super+P` | Pseudo |
| `Super+1–5` | Switch workspace |
| `Super+Shift+1–5` | Move to workspace |
| `Super+Scroll` | Cycle workspaces |
| `Super+arrows` | Focus |
| `Super+Shift+arrows` | Resize |
| `Super+LMB drag` | Move window |
| `Super+RMB drag` | Resize window |
| `Print` | Region → clipboard |
| `Shift+Print` | Region → `~/Pictures/` |

### Adding a new keybind that triggers UI

The pattern is: keybind in `hyprland.lua` → `nidara-ipc <cmd>` → `requestHandler` in `app.ts` → `ShellActions.<action>()` → `Status.<setter>()`.

Don't shortcut this. Every step is there for a reason (Hyprland reload-safety, IPC visibility from CLI, typed registry, central state).
