# Crystal Shell — Working as a user's agent: where a change belongs, and contributing it back

Crystal Shell is **AI-native**: it ships this skill so that any user running Claude Code
(or a similar agent) can extend, customize, fix, and improve their desktop — and, when a
change helps *everyone*, propose it back upstream so the whole community benefits.

If you are an agent helping someone with their **installed** Crystal Shell, read this
before making changes. It answers two questions:

1. **Where does this change belong?** — the user's local config, a new Setting, or the
   project's shared code.
2. **Should it go upstream?** — and if so, how to propose it as a PR, with the user's
   consent and almost none of the git/PR mechanics landing on them.

> The golden rule: **classify every change before you make it.** Don't pick a "mode" for
> the whole session — route each change to its correct destination.

---

## Step 1 — Classify the change: personal, setting, or global

Three buckets. Decide which one each change is BEFORE writing code.

### 🟦 PERSONAL — stays on this machine, never PR'd
A choice that reflects *this user's taste, hardware, or workflow*. Belongs in the **config
layer** (`~/.config/crystal-shell/` — see `references/dev-workflow.md` for the ownership
model). Other users would reasonably want it different.

Examples (real):
- Accent colour / theme tokens tuned to taste (e.g. a pink accent).
- Dock pinned apps, dock size/position, magnification preference.
- Keybinds added in `hyprland-user.lua`; autostart entries.
- Wallpaper; keyboard layout (`crystal-settings.lua`); monitor mode/scale
  (`crystal-monitor.lua`) — these are per-machine by definition.
- A widget or script only meaningful to one person's setup.

### 🟩 MAKE-IT-A-SETTING — the capability is global, the value is personal
The user wants *a specific value*, but **other users would want a different value of the
same knob**. Don't hardcode their value — add the knob to the Settings UI (data in JSON),
then their choice stays PERSONAL while the **new knob** is a GLOBAL improvement worth a PR.

This is the most important and most missed bucket. Default here whenever you're tempted to
hardcode a preference.

Examples (real):
- "Make the dock bigger" → if the desired size is outside the slider's range, *raising the
  range / adding the size option* is global; the chosen size stays local.
- "I want this clock format / this icon for app X" → the per-app icon override and format
  options are already Settings features; use them (local), don't fork code.
- A new colour palette the user likes → the palette *is data* (local), but a new palette
  *engine capability* (e.g. a new token slot) is global.

### 🟥 GLOBAL — improves the DE for everyone; propose a PR (with consent)
Correctness, compatibility, performance, accessibility, or a genuinely reusable capability.
Nothing about it is specific to one user's taste.

Examples (real, straight from this project's history):
- **Hardware compatibility:** NVIDIA GPU autodetection; a fix for WiFi/Bluetooth widgets
  when no adapter is present; a per-GPU workaround. *This is the highest-value category —
  the maintainer often cannot reproduce it without the user's hardware.*
- **Bug fixes:** the vertical-dock hover/leave jump; Cairo fractional-rect truncation in
  the input region; the Settings `.desktop` being shadowed by a dangling symlink; a Pixman
  warning on dark/light toggle.
- **Missing capability that benefits all:** a portal backend so libadwaita apps follow the
  accent; a new reusable `crystal-*` component.
- **Performance / robustness:** reducing redraws, fixing a crash, de-duplicating logic.

### When unsure → ask the user, default to PERSONAL
Phrase it plainly: *"Is this a personal preference for your setup, or a fix/feature other
users would want too?"* If still unsure, keep it local. A missed upstream contribution
costs nothing; a noisy or taste-specific PR costs the maintainer review time and trust.

---

## Step 2 — Route it

- **PERSONAL** → write to the config layer (`~/.config/crystal-shell/`, `hyprland-user.lua`,
  Settings UI). Never edit shared repo code for a personal preference. See the config
  ownership model in `references/dev-workflow.md`.
- **MAKE-IT-A-SETTING** → add the knob (follow the widget-registry / Settings conventions),
  set the user's value through it, and treat the *new knob* as a GLOBAL change.
- **GLOBAL** → make the change in repo code following all conventions (the ten commandments,
  scoped CSS, `Status.ts`/`ShellActions`, no hardcoded colours…), then go to Step 3.

---

## Step 3 — Proposing a global change upstream (PR protocol)

The aim: the **user** barely has to know what a PR is, while the **maintainer** receives a
clean, reviewable, conventions-respecting contribution. You do the mechanics; the user gives
informed consent.

**Never** open a PR without explicit user confirmation in this session. **Never** assume
auto-merge — every PR is human-reviewed.

1. **Self-review FIRST.** Re-read the ten commandments (SKILL.md) and the relevant reference.
   Confirm the change violates none. If it touches the dock, edit `DockCore.tsx` / `DockAxis.ts`
   (not the thin H/V wrappers), and account for any area flagged in `references/tech-debt.md`.
2. **Make CI-passable.** CI gates the SCSS compile. Run `cd ui/ags-v3 && npm run build` and,
   if `@girs/` is present, `npm run typecheck`. A red PR wastes everyone's time.
3. **Gather evidence.** Especially for hardware/compat fixes: what hardware (GPU, adapter,
   `lspci`/`lsmod` excerpts), what was broken, what you verified after. The maintainer likely
   can't reproduce it — your evidence IS the test.
4. **Ask the user.** Summarize the change, that it's a general improvement, and that you'd
   like to open a PR to `github.com/fluid-crystal/crystal-shell` under their GitHub account.
   Proceed only on a clear yes.
5. **Branch, fork, PR.** The user almost certainly cloned the upstream repo directly and has
   **no push access and no fork** — so you cannot push a branch to `fluid-crystal/crystal-shell`.
   Create the branch locally, then fork explicitly (don't rely on `gh pr create`'s interactive
   fork prompt — it hangs a non-interactive agent), push to the fork, and open a cross-repo PR:
   ```bash
   git checkout -b fix/nvidia-cursor-glitch
   git commit ...                              # end body with the project's Co-Authored-By trailer
   gh repo fork --remote --remote-name fork    # creates the user's fork + adds it as remote 'fork'
   git push -u fork HEAD
   GH_USER=$(gh api user --jq .login)
   gh pr create --repo fluid-crystal/crystal-shell \
     --head "$GH_USER:fix/nvidia-cursor-glitch" \
     --title "fix(nvidia): …" --body-file <PR body>
   ```
   Fill the PR template fully and **tick its "prepared with an AI coding agent" checkbox** — a
   GitHub Action applies the `agent-submitted` label from that (or from the `Co-Authored-By`
   trailer). Do **not** pass `--label agent-submitted`: an external contributor lacks the triage
   permission to set labels, so it would error. If the user already has a fork, `gh` reuses it.
6. **Keep personal bits out.** Strip the user's accent, wallpaper, pinned apps, keybinds,
   layout — anything PERSONAL — from the diff. A global PR contains only the global change.
7. **Hand back the link.** Give the user the PR URL and tell them a maintainer will review;
   it is not merged automatically.

---

## For maintainers (how this lands on our side)

These PRs arrive from many users' agents, of varying quality and origin. Treat the skill as
a funnel that *shapes* contributions, never as a merge gate:

- **Branch protection on `main`**; CI required; **no auto-merge, ever.**
- Triage via the `agent-submitted` label; require the PR template's hardware/testing evidence.
- Reward the high-value long tail: hardware/compat fixes the maintainer can't reproduce solo.
- When a contribution changes behaviour or conventions, the PR must also update the relevant
  skill reference — the skill is versioned with the code (single source of truth).

See also: `references/dev-workflow.md` (config ownership model — the personal/global seam),
SKILL.md (the ten commandments), `references/tech-debt.md` (known-issue checks).
