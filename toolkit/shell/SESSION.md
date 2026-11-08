# Hyalo's Rust session (#1017)

Owner decision, 2026-11-05: switch now, before B2.2/B2.3/B3. This is the
startup switch, not completion of those panels. No TS shell is started in Hyalo.

`hyalo/session/start-shell` starts only `nidara-rust-shell.service`, which runs
`nidara-shell --bar`: bar, dock, Apps and implemented panels in one process.
It requires and orders after `nidara-sessiond.service`; it conflicts with the TS
`nidara.service` and old separate `nidara-dock.service`. No preview key is read,
no service is enabled on a generic target, and a missing Rust binary never falls
back to TS. PartOf stops the services at logout. Super+Shift+R restarts only the
Rust shell, leaving session services and notification history alive.

The package's Hyalo component ships the Rust binary/unit. Dev `install.sh`
builds/installs them too; `hyalo/scripts/install-preview.sh` installs the compositor
and shell, but requires install.sh from the same checkout for sessiond and IPC.
Neither source changes nor private tests update an installed session.

`nidara-sessiond` with no arguments starts notifications, Config1, Applications1,
Network1, Bluetooth1, Audio1, Media1, Tray1 and Power1. Explicit service flags
select only those services (notifications always remain); `--notifications-only`
selects the old minimal notification test mode. Read-only flags still select
read-only services. Unknown flags fail before connecting to D-Bus. Its readiness
name org.nidara.Session is acquired after all selected services register.
Production builds include audio-native; builds without it expose unavailable audio.

`nidara-ipc` defaults to Rust without an environment variable. Unknown values warn
and keep Rust; `--session=ts` or NIDARA_SESSION=ts is deliberate legacy compatibility,
never an error fallback. Hyalo shortcuts use the native CLI, including Super/Apps.
The TS source/unit remains for the frozen Hyprland boot floor; it is not a Hyalo
fallback. Its launcher explicitly selects TS IPC, and its legacy daemon unit retains
only notifications/media/power so Rust NM/BlueZ agents never start beside TS. The
legacy and full daemon units conflict. The legacy unit waits on notification-ready
org.freedesktop.Notifications, while the full unit waits on org.nidara.Session;
systemd rejects duplicate configured BusNames even on conflicting units.
This is only the frozen boot floor, not new TS/Rust parity work.

## Pending capabilities

- B2.2 details and capture controls are implemented by #1015; installed physical-session
  acceptance and hardware validation remain pending.
- B2.3: CC edit mode, remaining widgets (battery, clipboard, CPU/memory, Ethernet, VPN).
- B3.1 notification banners are implemented in `B3.1.md`; installed physical-session
  acceptance is pending. Sender expiry is presentation metadata, preserving history.
- B3.2 and later: Notification Center and the other unported shell panels. In particular
  NC, Prism, agent, overview and bar-overlay shortcuts may return Unavailable;
  the native capability list is authoritative. There is no hidden TS panel.
- MCP transition gap: the observed installed CLI defaulted to legacy
  org.nidara.Shell.Request, unavailable after TS was stopped. In current source,
  `bin/nidara-mcp` calls `nidara-ipc` (agsRequest is only a historical helper name),
  not D-Bus directly. Updating that CLI now routes screenshot to Hyalo and dump_state
  to native dumpState. The native state schema is different from TS; queryUI and
  other unported introspection remain unavailable. End-to-end installed MCP capture
  and state acceptance remain unverified. No broker, compatibility shim or TS bridge
  is added here; an old installed CLI still leaves the original gap.

## Owner installation and temporary overrides

Installation and changes to the live session require a separate owner decision.
After installing matching binaries and units, inspect the three temporary files
created during the live experiment, then remove **only** those rust-only.conf files:

```sh
rm -f ~/.config/systemd/user/nidara.service.d/rust-only.conf \
      ~/.config/systemd/user/nidara-dock.service.d/rust-only.conf \
      ~/.config/systemd/user/nidara-sessiond.service.d/rust-only.conf
systemctl --user daemon-reload
```

Keep any other overrides. Log out and enter Hyalo again; no automatic live
migration is attempted. Confirm one Rust shell with --bar, no nidara-ui or separate
Rust dock, all service names owned, Super/Apps and the reload shortcut. Private
buses and command stubs verify routing/ordering, not installed hardware or UI acceptance.
