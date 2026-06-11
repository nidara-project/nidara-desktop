# Contributing to Crystal Shell

Crystal Shell is **AI-native by design**. It ships an agent skill inside the repo
(`.claude/skills/crystal-shell/`) so that anyone running [Claude Code](https://claude.com/claude-code)
— or a similar coding agent — can extend, customize, and fix their own desktop, and propose
globally-useful improvements back upstream. You don't need to be a git expert: your agent
can handle the mechanics, with your consent.

You can of course also contribute the traditional way. Both paths are welcome.

## The one question that decides everything: is your change personal or global?

Before contributing, classify the change:

- 🟦 **Personal** — your taste, hardware, or workflow (accent colour, pinned apps, dock size,
  keybinds, wallpaper, keyboard layout, monitor setup). **This stays on your machine.** It
  lives in the user config layer (`~/.config/crystal-shell/`, `hyprland-user.lua`, or the
  Settings UI) — never in a PR.
- 🟩 **Make it a setting** — you want a specific value, but other users would want a different
  one. Don't hardcode it: add the knob to Settings. Your value stays personal; the **new
  knob** is a global improvement worth a PR.
- 🟥 **Global** — correctness, hardware compatibility, performance, accessibility, or a
  genuinely reusable capability. **This is what we want as a PR.** The highest-value
  contributions are hardware/compatibility fixes the maintainers can't reproduce alone
  (NVIDIA quirks, WiFi/Bluetooth edge cases, per-device workarounds).

When unsure, ask yourself: *would another user reasonably want this different?* If yes, it's
personal (or a setting). If no, it's global.

The full heuristic, with examples, lives in `.claude/skills/crystal-shell/references/agent-contribution.md`.

## Contributing with an agent

If you use Claude Code, just open this repo (or your installed copy) and work normally — the
skill is auto-discovered. When you make a global improvement, the agent will offer to open a
PR on your behalf. It will:

1. Self-review against the project conventions (the "ten commandments" in the skill).
2. Make sure CI passes (`cd ui/shell && npm run build`).
3. Gather evidence — especially your hardware and what you verified.
4. **Ask for your explicit confirmation** before opening anything.
5. Open the PR with the personal bits stripped out, forking on your behalf if you don't already
   have one (you don't need push access to this repo). The `agent-submitted` label is applied
   automatically — you don't need label permissions.

You stay in control: nothing is pushed or opened without your say-so, and nothing is merged
automatically — a maintainer always reviews.

## Contributing the traditional way

1. Fork the repo to your account, then clone your fork. (If you already cloned this repo
   directly, you don't need to re-clone — `gh pr create` will offer to create the fork and push
   your branch to it when you open the PR.) Run `./install.sh --dev` for a source-running dev setup.
2. Read `.claude/skills/crystal-shell/SKILL.md` and the relevant reference under
   `.claude/skills/crystal-shell/references/`. The conventions there are strict and easy to
   violate without context (no `Adw.OverlaySplitView` in Settings, scoped CSS only, no
   hardcoded colours, IPC via `ShellActions`, …).
3. Make your change on a topic branch (it lives on your fork — you can't push branches to this
   repo without write access). Keep personal preferences out of the diff.
4. Ensure CI passes: `cd ui/shell && npm run build` (CI gates the SCSS compile). If you have
   the git-ignored `@girs/` typings, also run `npm run typecheck`.
5. If your change alters behaviour or conventions, **update the relevant skill reference in
   the same PR** — the skill is versioned with the code and is the single source of truth.
6. Open a PR using the template. Provide hardware/environment details and testing evidence.

## Review & merge policy

- `main` is protected; **CI is required; nothing auto-merges.** Every PR is human-reviewed.
- Maintainers triage `agent-submitted` PRs by the evidence in the template.
- Behaviour/convention changes must come with the corresponding skill-reference update.

### Automated triage

Every PR gets a deterministic triage pass (a GitHub Action — no AI reads your PR, and none
of your PR's code is executed). It applies labels and maintains **one** summary comment that
updates in place whenever you edit the PR description or push commits:

| Label | Meaning | What you should do |
|---|---|---|
| `agent-submitted` | Prepared with an AI coding agent (template checkbox or commit trailer) | Nothing — it's informational, applied for you |
| `guardian-files` | The diff touches protected paths (`.claude/skills/`, `.github/`, `CONTRIBUTING.md`, `install.sh`, `scripts/`, `bin/`) | Nothing — just expect a closer, slower review |
| `needs-evidence` | The PR template is incomplete (unticked classification boxes, missing hardware details on a compat fix, missing user approval on an agent PR) | Edit the PR **description** to complete the template — the label and the comment clear automatically |

Complete the template honestly: never tick a box that isn't true. The triage comment is
metadata for the human reviewer, not a gate you need to argue with.

## License

By contributing you agree your contributions are licensed under the project's
**GPL-3.0** license. Commits made with an agent should keep the agent's `Co-Authored-By`
trailer.
