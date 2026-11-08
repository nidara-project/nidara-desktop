# The Rust bar, B1 (#959)

**Status: B1 built, 2026-11-02.** The owner approved B1's scope in Claude's chat ("Yes, start
B1"). The early switch (#1017, owner 2026-11-05) activates it in Hyalo with
`nidara-shell --bar`, together with the dock and implemented panels. See `SESSION.md`
for remaining panels and installation limits.

B1 is the bar's row, one layer along the top of each output, with the TS "B" bar's
measures (owner, 2026-10-06: 36 strip, 32 capsule, one 4 px rhythm, 12 px text, 18 px
icons). Three pieces of glass, declared to Hyalo as the `control` piece of the exported
material (the shell is always dark: white ink). Each is a true capsule, circular ends
(exponent 2), never the dock's squircle (owner, 2026-11-02):

| Group | Items, left to right | A click |
|---|---|---|
| Left | Nidara's mark · the focused app's name, or the desktop's ("Desktop 3") | mark: the system menu |
| Centre | the island: five workspace dots (active wide, occupied dim, empty faint) | the desktops' overview, once the Rust shell has one; nothing until then |
| Right | tray icons · focus · battery · Wi-Fi · volume · Control Center · clock | tray: below; focus: Do Not Disturb off; Control Center: its panel (`CC.md`); clock: Notification Center/calendar (`B3.2.md`) |

Left out of B1 (the owner's list): the overflow `»`, editing and reordering, the island's
other modes, the search icon (Prism is not in the Rust shell). The person's `bar-order`,
`bar-hidden` and widget `placement` are not read: B1 shows the default set and order.

## Where it lives

`toolkit/shell/src/`, in the `nidara-shell` process beside the docks and Apps:

| File | What |
|---|---|
| `barmodel.rs` | Pure and unit-tested: the measures, the dots, the groups' boxes, the title's room, the clock's text by `org.nidara.region` and the locale's date order |
| `bar.rs` | One bar per output on its own thread (`run_layer`, `nidara-bar`, Top, exclusive 36): layout, paint, input region (the glass only), menus, the reader tree |
| `status.rs` | The widgets' sources (below), each on a watcher thread |
| `tray.rs` | The tray host (below) |
| `hub.rs` | One `BarFrame` per bar: the focused app on that output, the workspaces, hidden (locked, or a fullscreen window there), the widgets' status, the tray |
| `menu.rs` | `system_menu`, `confirm_menu`, `Command::System`, `Command::Tray` |

`main.rs` starts the bar before the dock on each output, and the widget and tray watchers,
only with `--bar`.

## Sources

Every source is subscribed before its first read; a new owner reads again; no owner shows
nothing and retries, backing off; a failed read is logged once ("the bar shows no …").

| Widget | Source | Shown while | Icon (the TS widget's rule) |
|---|---|---|---|
| Focus | GSettings `org.nidara.notifications do-not-disturb` | Do Not Disturb is on (`defaultBarMode: "active"`) | `nd-notifications-disabled` |
| Battery | Power1 `DisplayDevice` → PowerDevice1 `Present`, `PercentageKnown`, `Percentage`, `State` | a battery is present | drawn: `nd-battery-symbolic` redrawn, filled by charge; green on AC (states 1 and 4), red at 15 % and below |
| Wi-Fi | Network1 `Snapshot`/`Updated` (JSON): the adapter on a network, else the first | there is an adapter | off / acquiring / 0–3 arcs (GNOME's 30/55/80) / the plain fan |
| Volume | Audio1 `DefaultOutput` → AudioNode1 `Volume`, `Muted` | there is a default output | muted at 0 or muted; low < 0.34; medium < 0.67; high |

Focus's click writes the key directly: it is the flag's only home (the TS NotifService's
rule), and the Rust Config1 has no `notifications.*` key.

## Notification banners (B3.1, #1050)

`notifications.rs` owns the bounded stack in the hub; `notification_wire.rs` subscribes
only to fresh events. `notification_card.rs` is the reusable card component, painted
on this bar's surface, with declared controlCenter glass. The surface grows while
banners are present; only card/bar glass takes input, never the gaps. Its Overlay
level permits banners above fullscreen while the bar row stays hidden. Lock removes
all cards and pending activations. The CC and banners share right-dock avoidance.
See `B3.1.md` for timer/history/action semantics, accessibility and local validation.
No Notification Center, calendar or clock route is added in B3.1.

## The tray

The host side of `session/daemon/src/tray/README.md` (Tray1 v1); read that first.

- It registers as a host with each new daemon owner (`RegisterHost`), then reads
  `GetSnapshot` after every `Changed` or root `PropertiesChanged`. Passive items are left
  out; an item needing attention shows its attention icon.
- **Icons**: a themed name is looked up as GTK would — the interface icon theme
  (`org.gnome.desktop.interface icon-theme`), what it inherits, hicolor, then the item's
  `IconThemePath` and `/usr/share/pixmaps` as plain directories
  (`nk_icons::find_app_icon`). An SVG is drawn at 36 px (18 at scale 2), a PNG decoded as
  it is; a name that resolves to nothing, or no name, takes the item's pixmap
  (`GetIcon`). A `-symbolic` icon is drawn white. All on the watcher's thread, cached per
  item generation and name.
- **Left click**: the window of the item's process comes forward (Hyalo's windows carry
  their pid) — that process's, else one whose process it started, up to eight
  generations. Never the other way up: what started the app may be the terminal it ran
  in. With no such window, `Activate` at the item's global point. An item that is only a
  menu (`ItemIsMenu`) opens its menu instead.
- **Right click**: its menu (`OpenMenu`) in the shell's own popup, the same one the dock's
  menus use; with no readable menu, `ContextMenu`. **Middle**: `SecondaryActivate`.
  **Wheel**: `Scroll`.
- **Menus**: dbusmenu rows as the popup's rows — `_` mnemonics removed, checkmarks and
  radios, disabled rows, separators; a submenu row (`  ›`) opens its level in its parent's
  place (`ReadMenu`), in the same session; a row is clicked with `MenuEvent` and the
  session closed (`CloseMenu`), as it is when the menu closes unchosen. Every call runs on
  a worker; the level it reads comes back to the bar with a wake.
- Not yet: following `MenuChanged` while a menu is open (a stale row's click fails and the
  menu closes), the Ayatana label, the overlay icon, and the overflow.

## Where menus hang

The bar's menus have no pointer (the dock's do): they hang 12 below the strip
(`MENU_TOP`, the TS bar's `PANEL_TOP`), flush with their capsule's outer edge — the
system menu from the left capsule's left edge, the tray's from the right capsule's right
edge (`popup::Request` `pointer: false`, `align_end`).

## The system menu

The TS system menu's rows and strings (`bar.system-menu.*`): About this computer (disabled:
there is no About in the Rust shell), System settings… (enabled while
`org.nidara.Settings` answers; opened with a token from the click), Lock screen, Sleep,
Log out…, Restart…, Shut down…. The last three ask first, in a second popup in the same
place (the question, the verb, Cancel). The hub runs them: `nidara-lock`, `systemctl
suspend`, `uwsm stop`, `systemctl reboot`, `systemctl poweroff`.

## Accessibility

A window "Bar" with its items in the order drawn: the mark ("System menu"), the title (a
label), the island ("Desktops", "desktop N of 5"), each tray item by its title, each
widget with its state ("Wi-Fi", "connected, signal 3 of 3"), the Control Center (its
panel and tiles, `CC.md`) and the clock (Notification Center/calendar). An open menu's rows join under the root, as on the
dock (#971). Activate does what a click does, without a token.

## Evidence

`toolkit/shell/check-bar-headless.sh` runs the dock's nested check with the bar
(`NK_SHELL_BAR=1`): a private sessiond with `--power-read-only --tray`, a stand-in Network1
and a stand-in tray item. It checks the bar's layer and reader tree; the system menu, the
log-out confirmation and Cancel (nothing ends); the island disabled; the widgets this
machine has; Do Not Disturb on and its click turning it off; the Wi-Fi icon following
`Updated`; and the tray item's icon, its click, its menu with a checkmark, the submenu in
place and the row clicked through dbusmenu. Shots land in `$NK_WIDGETS_LOG` (`bar*.png`).

What it cannot cover: the battery and volume in a real session (no battery here, no
PipeWire in the harness); their reading is unit-tested, and the battery glyph was checked
drawn offscreen.

## Notification Center (B3.2, #1050)

The clock and `nidara-ipc nc` toggle one NC on this surface. CC and NC exclude one
another across outputs; output loss closes the NC. Escape/outside close, lock
redacts it. The one Card component serves fresh banners and history, with history
roles rather than announcing the archive. Only visible cards are laid out/painted
and exposed to AT-SPI. Group disclosure, scrolling, month navigation and all clear
operations have reader and keyboard targets. See `B3.2.md` for hydration, journal,
retention, token actions, bounded rendering, clear animation and reproduction.
