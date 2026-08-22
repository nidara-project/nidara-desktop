# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## First: invoke the `nidara` skill

**Before touching any code here, invoke the `nidara` skill.** It ships inside this repo at
`.claude/skills/nidara/` and it is the authoritative source: conventions, architecture, the
design system, state/IPC, the dev workflow, and the known-debt list — loaded on demand from
`references/`.

This file is deliberately thin. It does **not** restate the skill's rules, numbers, or commands,
because a second copy of a rule is a copy that can disagree with the first one — and only the
skill is checked for that (`scripts/ci/skill-docs-check.mjs`). If you want to know how something
here works, the answer is in the skill, not in this file.

Keeping the skill current is part of "done" for any change that adds a mechanism or a gotcha:
update it in the same change.

## What this is

Nidara is a **full Wayland desktop environment** for Arch Linux — not a theme and not a set of
scripts. It registers as a real Wayland session and is launched by the display manager.
Compositor: **Hyprland**. UI: **TypeScript → GJS** on **GTK4 + gtk4-layer-shell**, styled with
SCSS and custom-painted with Cairo where shapes get bespoke. No AGS, no Astal, no libadwaita —
all three are fully removed, and the application host, the bundler and the C libraries are ours.

⚠️ Widgets are built **imperatively**. There is **no JSX in this repo** despite the `.tsx`
extensions, and none of Gnim's reactive primitives are used. A JSX-shaped contribution will not
match anything here.

It is also **AI-native by design**: the skill, the MCP server, the agent surface and the
contribution rules all live inside the repo, so any user's agent can extend, fix and customize
their own desktop — and propose globally useful improvements back upstream.

## Where things live

| Path | What |
|---|---|
| `ui/shell/` | The desktop bundle → `build/nidara` (bar, dock, overlays, settings) |
| `ui/greeter/` | The login bundle → `build/nidara-greeter` |
| `ui/lockscreen/` | The lock bundle → `build/nidara-lock` |
| `ui/lib/` | Shared code + `nidara-kit/`, the reusable widget kit |
| `lib/` | Our own C libraries with GIR typelibs (PAM auth, Wayland protocols) |
| `bin/` | Session entry, CLI, IPC, agent, MCP server, portal backend, computer-use helpers |
| `config/`, `defaults/`, `packaging/` | Hyprland config, seeded user state, the Arch package |

**The three bundles are separate applications**, each with its own `app.ts`, `package.json` and
build invocation. That is the first thing to internalize; the skill explains what follows from it.

## Two traps that waste real time

- **"My change didn't apply" / "styles won't refresh"** → almost always a zombie `gjs` still
  drawing the previous UI. `killall gjs`, then reload.
- **Typecheck floods you with `has no exported member 'Box'`-style errors** → the git-ignored
  GI typings are missing, not your code. Generate them first; real errors hide in that noise.

## Working on a user's OWN install rather than this repo

If you are helping someone extend or fix their installed copy, read
`.claude/skills/nidara/references/agent-contribution.md` **first**. It decides whether a change
is personal (config layer), should become a Setting, or is a global improvement worth proposing
back upstream as a PR.
