# User hooks

The second of the desktop's two extension points that need no rebuild. `hyprland-user.lua` reaches
the compositor; this reaches the shell.

    ~/.config/nidara/hooks/<event>.d/*     executables, run in order, on a named desktop event

Everything about it is deliberately small: no third-party code inside the shell's process, no
transpiler on the user's machine, and no public API that has to stay frozen. The contract is only
*"we execute your file and pass it these arguments"*, which survives any refactor behind it.

## The contract, in five lines

- A hook is any **executable** file in `~/.config/nidara/hooks/<event>.d/`. Not executable = not
  run, which is the documented way to disable one in place (`chmod -x`).
- They run **sequentially, in C-collation order** — `10-` before `20-`, the same on every machine.
- Arguments arrive as `$1…$n`; the event's own name is in `$NIDARA_EVENT`, so one script symlinked
  into several directories can tell which event it is answering.
- A hook that fails, or hangs past `NIDARA_HOOK_TIMEOUT` (30 s), is logged and the rest still run.
  Their stdout and stderr are the shell's, so a `echo` lands in `$XDG_RUNTIME_DIR/nidara-ui.log`.
- `nidara-hook <event> [args…]` fires an event by hand. That is how a user tests a hook without
  waiting for the real thing, and it is worth telling them.

⚠️ Hooks fired **by the shell** inherit the shell's systemd cgroup (`nidara.service`), so anything
long-lived a hook starts dies at the next UI reload. Such a hook must hand the work to
`systemd-run --user` or `uwsm app -s`, exactly like a launcher does.

## The event list is not in this file

`bin/nidara-hook` holds the table, and `nidara-hook --list` prints it. **Do not copy it here, into
`SKILL.md`, or into a user manual** — a second copy is a copy that can disagree, and the reason
this one place works is that everything else asks it: `nidara-setup` derives the directories to
seed from `--list`, and `scripts/ci/hook-events-check.mjs` fails the build when the table and the
call sites disagree in either direction.

Both directions matter, and both fail silently without the check:

| break | what the user sees |
|---|---|
| fired but not declared | the runner refuses the name; the event never happens, and `nidara-setup` never even creates its directory |
| declared but never fired | a documented directory, a correct script, and nothing ever runs it |

## Where each event is fired from

The shell fires through `fireHook()` in `ui/shell/core/Hooks.ts` — a fire-and-forget
`Gio.Subprocess`, never awaited, never throwing. `bin/nidara-update` fires its own event directly,
because it is bash and runs outside the shell's process; that is precisely why the runner is a
separate binary rather than a loop inside `Hooks.ts`.

Two of the six are not a one-line call at a setter, and both traps are worth knowing before you add
an event:

- **`session-started` is not "main() ran".** `main()` re-runs on every UI reload (Super+Shift+R), so
  a bare call there would fire on reloads too — the same trap that got the DnD seeding block deleted
  from `app.ts` in 2026-08-16. A stamp in `$XDG_RUNTIME_DIR` is what makes the name true: that
  directory is born with the user's first session and destroyed with their last, so it cannot
  outlive the session that wrote it and needs no cleanup of ours.
- **`battery-low` has no natural firing site**, because nothing in the shell *decides* a battery is
  low. `initBatteryLowHook()` watches UPower and fires on a downward crossing only, armed from the
  level it finds at startup — a shell reloaded on an already-flat laptop must not announce a
  crossing it never saw — and re-armed above 25 % or on AC, which is also what stops one discharge
  firing twice while the reading jitters.

One gap, stated rather than hidden: `update-completed` does **not** fire on the DEV update path.
`nidara-update` `exec`s the registered clone's `install.sh` there — deliberately, so the updater
updates with the repo — and an `exec`d process has nothing left to run afterwards. The package and
stable paths both fire it.

And one rule for the easy ones: fire at the **specific setter**, never on `ThemeManager`'s generic
`"changed"` signal. Every opacity slider emits that too, so a hook wired there would fire dozens of
times per drag.

## Adding an event

1. Add its row to the `EVENTS` table in `bin/nidara-hook` (`name :: arguments :: what it means`).
2. Fire it — `fireHook("name", …)` from the shell, or `nidara-hook name …` from a bash helper.
3. `node scripts/ci/hook-events-check.mjs`.

There is nothing else. The directory is created by the next `nidara-setup`, the README beside it
already points at `--list`, and no documentation needs editing — which is the point.
