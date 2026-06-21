# Packaging — Nidara's source-built dependencies

Nidara depends on three things that are **not in the official Arch repos** and
that we pin to a known-good revision rather than track upstream HEAD:

| What | Pinned by | Why we build it |
|---|---|---|
| `appmenu-glib-translator` | `APPMENU_REF` (gitlab `vala-panel-appmenu`) | DBusMenu→GMenuModel translator; runtime dep of `libastal-tray` |
| Astal libs (`libastal-io`, `-gtk4`, `-tray`, …, `astal-gjs`) | `ASTAL_REF` (github `Aylur/astal`, no tags → SHA) | the service libraries the shell binds |
| `aylurs-gtk-shell` (the `ags` CLI) | `AGS_REF` (github `Aylur/ags`, release tag) | bundles/runs the TSX → GJS shell |

The pins live in **`install.sh`** (`*_REF` near the top). That is the single source of
truth; bump them there and re-test a clean install before tagging a release.

## Why packages instead of `meson install`

Earlier releases ran `sudo meson install` straight into `/usr`. Those files were
**untracked**: `pacman -Qo` reported "no package owns", so they were invisible,
un-upgradable and un-removable. That blind spot is exactly what let a stale, crashing
`appmenu-glib-translator` sit frozen for weeks with no way to see it.

`install.sh` now generates a tiny **PKGBUILD per component** and installs via
`makepkg` + `pacman -U`. The libraries become first-class pacman packages — `pacman -Qo
/usr/lib/libastal-tray.so` now names the package and version, upgrades replace cleanly,
and removal is clean.

## How the build works (`install.sh` §2 and §4)

- Astal has **no root `meson.build`**: each `lib/*` is built standalone and finds the
  others via `pkg-config`, so they are built **in dependency order** (`io` first) and
  each is installed before the next is built. One package per lib (mirrors the AUR
  `libastal-*` layout).
- `appmenu-glib-translator` is built **first** (`libastal-tray` links it).
- The astal git source is cloned **once** into a shared `SRCDEST` and reused across the
  14 component builds.
- `makepkg` runs as the unprivileged user (it refuses root); `pacman -U` runs via sudo.
- Install uses `--overwrite '*'` for the one-time hand-off from the old untracked
  `meson install` files. `--overwrite` only touches files the new package actually
  ships, so it is scoped and safe.
- `depends=()` is intentional for now: every runtime dep is already pulled in by
  `install.sh` §1's `pacman -S`, and empty deps keep this first packaging pass from
  failing on transient resolution.

## Where this is heading (nidara-repo)

This is the local/dev form. The intended end state for the distributable DE:

1. ✅ **DONE (2026-06-21)** — these generated PKGBUILDs are now **committed** in
   [`nidara-project/nidara-repo`](https://github.com/nidara-project/nidara-repo) and built by
   CI into real `.pkg.tar.zst` artifacts, published to a pacman repo on GitHub Pages:
   `https://nidara-project.github.io/nidara-repo/$arch` (pacman repo name `nidara`, unsigned
   for now → `SigLevel = Optional TrustAll`).
2. ⏳ **NEXT (Phase 3, deferred)** — `install.sh` / Calamares then just add `nidara-repo` to
   `pacman.conf` and `pacman -S` — **no build toolchain on the user's machine**, identical
   pinned binaries for everyone, and dep bumps propagate via `pacman -Syu`. This rewires §1/§2/§4
   (the validated clean-install path), so it lands as its own change re-validated in the VM,
   keeping the source build as a fallback.
3. At that point tighten `depends=()` to real runtime deps and add `provides`/`conflicts`
   so the packages coexist cleanly with any future AUR/official Astal packages.

`install.sh --dev` keeps building from source locally for development either way.

> **Lockstep pins (temporary, until Phase 3):** the pinned revisions now live in **two**
> places — `install.sh`'s `ASTAL_REF`/`AGS_REF`/`APPMENU_REF` (source-build path) and
> `nidara-repo/pins.env` (the repo build). Bump **both** together until install.sh consumes the
> repo, at which point `pins.env` becomes the only source of truth.
