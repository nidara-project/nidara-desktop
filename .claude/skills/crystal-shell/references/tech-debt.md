# Crystal Shell — Known tech debt

Read this before starting any refactor or before "fixing" something that feels weird. Many of the strange patterns in the codebase are known issues with documented reasons. The items are ordered by impact.

## 1. Dock H/V duplication (~75%)

- `DockHorizontal.tsx` — 1434 LOC
- `DockVertical.tsx` — 1367 LOC
- They share **123 identifiers** that have drifted out of sync.

**Most dock bugs come from divergence** — the vertical-dock-jump issue is the canonical example: a fix landed in `DockHorizontal.tsx` and the vertical version kept the old buggy path.

**Right fix when you can afford it:** extract a `DockCore` + axis adapters. The two TSX files become thin wrappers that wire the adapter and forward to `DockCore`.

**What to do in the meantime:** if you're patching a dock bug, **diff the two files for the relevant function before submitting**. If the function exists in both, fix both. If it only exists in one, ask why.

## 2. `ACCENT_PALETTE` single source of truth — ✅ RESOLVED (2026-05)

The 9 accent colors now live **only** in `ui/lib/accent.ts` (`ACCENT_HEX` + `ACCENT_NAMES` + `hexToRgb` + `accentCssFor`).
- `core/FluidCrystal.ts` derives its `ACCENT_PALETTE` (and exported `AccentKey`) from `ACCENT_HEX`.
- `ui/greeter/app.ts` and `ui/lockscreen/app.ts` import `accentCssFor` instead of their own palette/CSS builder.
- `styles/_settings.scss` swatches read the runtime `--accent-<key>` tokens that FluidCrystal emits.
- `styles/_base.scss` still has a single `--crystal-accent: #0088FF` **startup fallback** (overwritten by FluidCrystal at runtime) — acceptable.

**Going forward:** add/change accent colors only in `ui/lib/accent.ts`.

## 3. Greeter ↔ lockscreen duplication — ✅ RESOLVED (2026-05)

- `loadAccentCss()` → shared via `ui/lib/accent.ts → accentCssFor()` (each app keeps only its own JSON path-reading, which legitimately differs).
- `users.ts` (was byte-identical) → moved to shared `ui/lib/users.ts`; both bundles import `../../lib/users` (and `../lib/users` from each `app.ts`). Old copies deleted. Also fixed a latent bug: the `getDefaultUser()` fallback object was missing `homeDir`.

**Intentionally NOT merged:** `lib/i18n.ts` stays separate per bundle. They diverged for a reason — the greeter runs as the `greeter` system user and reads `/var/lib/greeter/.config/...`, while the lockscreen runs as the logged-in user. Merging would make the lockscreen read the greeter user's prefs path (a bug). The greeter's i18n is also a superset (locale switching + extra keys). Keep them separate.

## 4. `Status.ts` mutual exclusion — ✅ RESOLVED (2026-05)

Replaced the per-setter repetition with a private `closeExclusive(keep, { notif, barExpanded })` helper driven by the static `UIStatus.EXCLUSIVE` map. Each exclusive setter is now one line, and it only emits `notify` for fields that actually changed.

**Going forward:** when adding a new exclusive overlay, add its `_field → notify-name` entry to `EXCLUSIVE` and call `closeExclusive("_field", …)` in its setter — no need to touch the other setters.

## 5. `@mixin glass()` underused

Defined in `_base.scss` with levels `surface`, `raised`, `floating`. **Only 2 call sites currently use it**, while ~20 manual glass blocks exist scattered across components.

**Right direction:** migrate manual glass blocks to `@mixin glass($level)`.

**Don't add new manual glass blocks.** New components should use the mixin from the start.

(For contrast: `@mixin crystal-reset` is well-adopted — ~45 sites use it.)

## 6. Anti-Adwaita resets are still dense in two files

- `_control-center.scss` — 33 anti-Adwaita reset rules.
- `_settings.scss` — 24.

The high reset count is a signal these surfaces are fighting Adwaita widgets they shouldn't be using. The longer-term answer is migrating those internals to pure GTK4 + `ui/lib/crystal-ui/`. The shorter-term answer is **don't add more resets** — use `@mixin crystal-reset` or switch the offending widget to base GTK.

## 7. Repo weight — ✅ RESOLVED (2026-05, history rewritten + force-pushed)

The original assumption ("bloat = re-committed bundles") was **wrong**. The real weight was **accidental junk
committed then removed**, still living in history:
- `ui/ags-v3/recording.mkv` (70 MB screen recording)
- `ui/ags-v3/isolated_config/` (a whole Chrome/Antigravity profile — model.tflite, Safe Browsing, caches)
- `plugins/` (hyprglass `.so` binaries) and `vendor/` (Astal/GTK source deps)
- `ui/ags-v3/astal-local/` (compiled `.so`/`.typelib`/`.gir`), `ui/ags-v3/artifacts/`, **52 loose `*_verify.png` screenshots** in `ui/ags-v3/`
- an entire pre-restructure tree: `themes/`, `config/{dock,waybar,wallpaper.jpg}`, `ui/{dock,topbar,menu}`, `just-perfection.zip`, top-level `assets/`/`core/`/`system_root/`/`skills/`

**Done:** `git filter-repo` (run as the standalone script via `python3`, filter-repo isn't packaged here)
purged all of the above across all 811 commits; force-pushed `main`. Result: **.git 342 MiB → 95 MiB**.
A safety backup bundle was written to `../crystal-shell-backup-<ts>.bundle`. The 3 release bundles were kept
tracked (distribution model unchanged) — they're the bulk of the remaining ~95 MiB.

**In the meantime / going forward:** anyone with an old clone must re-clone (SHAs changed). Don't commit
binaries beyond the 3 release bundles; the screenshot-verify pngs and build artifacts must stay git-ignored.
Remaining optional trim (not done): strip historical *versions* of the release bundles while keeping current
ones — would need strip + re-add, and the bundles are rebuilt fresh at release anyway.

## 8. Dead `crystal-launcher` layer rule — ✅ RESOLVED (2026-05)

Removed the dead `layerrule`/`layer_rule` for `crystal-launcher` from `hyprland.lua` and the stale comment in `app.ts` (the launcher is embedded in the Dock).

## 9. i18n has no hot-reload

`detectLanguage()` runs once at startup. Changing the system locale while the shell is running won't update strings until `Super+Shift+R`. Out of scope for most PRs, but worth knowing when testing locale changes.

## 10. Architecture / skill docs are intentionally git-ignored

Two local-only docs exist for us, **deliberately kept out of git** (`.gitignore`):
- `CRYSTAL_SHELL_ARCHITECTURE.md` — full architecture reference.
- `docs/crystal-shell-skill-brief.md` — the dossier this skill was generated from.

This is by design (owner's decision), not debt. If you write down architectural decisions while working,
update those two docs and/or this skill's `references/` — not a tracked repo doc.

## 11. Vestigial regreet config — ✅ RESOLVED (2026-05)

`config/greetd/regreet.toml` and `defaults/regreet/style.css` were removed — greetd launches the custom
`crystal-greeter` AGS app directly (via `hyprland-greeter.lua`), regreet was never wired.

---

## Meta: how to interpret "tech debt" here

The list above is **not** a list of bugs. These are conscious tradeoffs that the project has decided are not blocking but should be paid down opportunistically. The pattern when working in this repo is:

1. If you're touching a file already, prefer aligning it with the "right fix" direction listed above — but only when the change is small and self-contained.
2. If aligning would balloon your PR, leave the existing pattern in place and add a comment that links to this file.
3. **Don't refactor as a side-effect of an unrelated change.** Reviewers will push back, and the tech-debt items are large enough that "drive-by" fixes tend to be partial and create more drift.
