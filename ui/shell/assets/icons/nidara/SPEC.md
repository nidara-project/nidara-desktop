# Nidara icon spec

**Version 4.** How to make an icon theme that changes Nidara's interface icons — the bar,
the menus, the Control Centre, Settings, the login and lock screens.

Nidara's interface asks for its own icon names, all starting with `nd-`. Only a theme that
provides those names, and says it follows this spec, can change them. Application icons (the
dock, the app grid, the tray, notifications) are not part of this spec: they keep the
freedesktop names every icon theme already has, and follow the *app* icon theme.

## Why its own names

The [freedesktop Icon Naming Spec](https://specifications.freedesktop.org/icon-naming-spec/latest/)
is frozen since 2007 and has no word for much of a modern desktop. The names themes grew on top
of it are not a standard either — GNOME describes Adwaita's as a private UI icon set with no API
— and the same name draws different things in different themes. Asking arbitrary themes for
those names kept putting the wrong picture on the wrong button. A name defined here means one
thing, and a theme made for it draws that thing.

## Making a theme

1. **Declare the spec** in your theme's `index.theme`, in the `[Icon Theme]` group:

   ```ini
   [Icon Theme]
   Name=My Theme
   Comment=Interface icons for Nidara
   Inherits=hicolor
   X-Nidara-Icon-Spec=2
   Directories=16x16/actions,scalable/actions

   [16x16/actions]
   Context=Actions
   Size=16
   Type=Fixed

   [scalable/actions]
   Context=Actions
   Size=24
   MinSize=16
   MaxSize=512
   Type=Scalable
   ```

   Settings → Appearance → *Interface icons* lists only themes carrying `X-Nidara-Icon-Spec`.
   The value is the version of this spec the theme was made for. `X-` keys are the format's
   own extension mechanism: every other program ignores the line, so the same theme keeps
   working as an ordinary icon theme anywhere else.

2. **Name each file `<name>-symbolic.svg`**, using the names in the table below. The
   `-symbolic` suffix is required: GTK only recolours an icon whose file name ends that way,
   and Nidara ignores any other file — a PNG, or an SVG without the suffix, is treated as
   missing.

3. **Draw symbolic icons.** One colour, taken from the interface at runtime. Mark every shape
   with GTK's symbolic classes: `foreground-stroke` on shapes drawn with a stroke,
   `foreground-fill` on filled shapes, and `transparent-fill` on stroked shapes that must stay
   hollow. A stroke-only drawing without `transparent-fill` renders as a filled blob.

4. **Sizes.** Provide `scalable/actions` (drawn on a 24-unit grid). Optionally add
   `16x16/actions` drawn on a 16-unit grid: GTK draws symbolic strokes 2 units wide, so a
   24-unit drawing shown at 16 px has a 1.33 px line, and a 16-unit one a real 2 px line. The
   bar's icons are 16 px.

5. **Keep a `viewBox`** on every file. GTK's symbolic renderer can drop a group
   `transform` on a file without one, and the icon then draws nothing. Nidara renders every
   icon before using it and falls back when it comes out empty, but your icon is lost.

You do not need every name. **Any icon your theme lacks, or that draws nothing, falls back to
Nidara's own drawing** — a theme that redraws ten icons is a valid theme. A theme made for an
earlier version of this spec keeps working; the names added since fall back the same way.

**The Nidara theme is the reference, and a template.** It is complete, in both sizes, and it is
the theme this file lives in: `/usr/share/icons/nidara` on an installed system,
`ui/shell/assets/icons/nidara/` in the repository. Copy the directory, rename it, change `Name=`,
and redraw what you want — delete the rest, and those icons fall back to Nidara's. Its drawings
come from [Lucide](https://lucide.dev) (ISC, see `LICENSE`); keep that notice if you keep any of them.

## Names

Draw what the **Represents** column says. *Where* is where Nidara shows it today, to help you
check your drawing in place; it is not part of the contract and may grow.

| Name | Represents | Where |
|---|---|---|
| `nd-ai` | The AI assistant | Settings → AI |
| `nd-audio-input-microphone` | A microphone (input device) | Settings → Audio, device list |
| `nd-audio-speakers` | Speakers (output device) | Settings → Audio |
| `nd-audio-volume-high` | Volume, high | Volume widget and slider |
| `nd-audio-volume-low` | Volume, low | Volume widget and slider |
| `nd-audio-volume-medium` | Volume, medium | Volume widget |
| `nd-audio-volume-muted` | Volume, muted | Volume widget, mute button |
| `nd-audio-x-generic` | Audio is playing | Activity Island indicator |
| `nd-avatar-default` | A user with no picture | Settings → Users, installer |
| `nd-bar` | The top bar | Settings → Bar |
| `nd-battery` | The battery | Battery widget, Settings → Power |
| `nd-bluetooth-active` | Bluetooth on | Bluetooth widget, Settings → Bluetooth |
| `nd-bluetooth-disabled` | Bluetooth off | Bluetooth widget |
| `nd-clipboard` | The clipboard history | Clipboard widget |
| `nd-clipboard-list` | Summary of settings (checklist on a clipboard) | Installer |
| `nd-contact-new` | Add a user | Settings → Users |
| `nd-control-center` | The Control Centre | Bar button |
| `nd-conversation-reset` | Start the conversation over | Assistant |
| `nd-cpu` | The processor / system resources | CPU widget, installer |
| `nd-dark-mode` | Dark appearance | Dark-mode widget |
| `nd-dialog-information` | Information / about | System menu, Settings → About, notifications without an icon |
| `nd-dialog-password` | A password | Settings → Users |
| `nd-dialog-warning` | Something here is wrong and holds the step (a caution triangle) | Installer → manual partitioning, a table row that fails a rule |
| `nd-display-brightness` | Screen brightness, high | Brightness widget and slider |
| `nd-display-brightness-low` | Screen brightness, low | Brightness slider |
| `nd-dock` | The dock | Settings → Dock |
| `nd-drive-harddisk` | A disk | Installer |
| `nd-emblem-default` | Selected (a check mark) | Menus |
| `nd-globe` | Where in the world you are (a globe) | Installer → Region |
| `nd-hand` | Welcome (a waving hand) | Installer |
| `nd-input-gaming` | Games | Settings → Gaming |
| `nd-input-keyboard` | A keyboard / keyboard layout | Settings → Input, login screen |
| `nd-light-mode` | Light appearance | Dark-mode widget |
| `nd-media-playback-pause` | Pause | Media widget |
| `nd-media-playback-start` | Play | Media widget |
| `nd-media-playback-stop` | Stop | Screen recording |
| `nd-media-record` | Record | Screen recording |
| `nd-media-skip-backward` | Previous track | Media widget |
| `nd-media-skip-forward` | Next track | Media widget |
| `nd-network-vpn` | VPN connected | VPN widget |
| `nd-network-vpn-disconnected` | VPN disconnected | VPN widget, Settings → Apps |
| `nd-network-wired` | Wired network | Ethernet widget |
| `nd-network-wireless` | Wi-Fi | Wi-Fi widget |
| `nd-network-wireless-acquiring` | Wi-Fi connecting | Wi-Fi widget |
| `nd-network-wireless-configure` | Wi-Fi network details | Settings → Network |
| `nd-network-wireless-disabled` | Wi-Fi off | Wi-Fi widget |
| `nd-network-wireless-signal-none` | Wi-Fi signal, none | Wi-Fi widget |
| `nd-network-wireless-signal-ok` | Wi-Fi signal, good | Wi-Fi widget |
| `nd-network-wireless-signal-weak` | Wi-Fi signal, weak | Wi-Fi widget |
| `nd-night-light` | Night light | Night-light widget |
| `nd-notifications` | Notifications | Bar bell, Do-not-disturb widget |
| `nd-notifications-disabled` | Do not disturb | Do-not-disturb widget |
| `nd-pan-down` | Expand / move down (chevron) | Settings, menus |
| `nd-pan-end` | Go forward / open (chevron) | Settings rows |
| `nd-pan-start` | Go back (chevron) | Settings, Control Centre |
| `nd-pan-up` | Collapse / move up (chevron) | Notifications, assistant send button |
| `nd-power-profile-balanced` | Power profile: balanced | Settings → Power |
| `nd-power-profile-performance` | Power profile: performance | Settings → Power |
| `nd-power-profile-power-saver` | Power profile: power saver | Settings → Power |
| `nd-preferences-desktop` | Settings | System menu, Settings |
| `nd-preferences-desktop-accessibility` | Accessibility | Settings → Accessibility |
| `nd-preferences-desktop-peripherals` | Pointer and touchpad | Settings → Input, pointer speed sliders |
| `nd-preferences-desktop-theme` | Appearance | Settings → Appearance |
| `nd-preferences-system` | Widgets | Settings → Widgets |
| `nd-preferences-system-network` | Network | Settings → Network |
| `nd-preferences-system-notifications` | Notification settings | Settings → Notifications |
| `nd-preferences-system-time` | Date, time and region | Settings → Region |
| `nd-rocket` | Start installation | Installer |
| `nd-screenshot` | Take a screenshot | Screenshot widget |
| `nd-sidebar-show` | Show or hide the sidebar | Settings, installer |
| `nd-system-lock-screen` | Lock (the screen, or a secured network) | System menu, Wi-Fi lists |
| `nd-system-log-out` | Log out | System menu |
| `nd-system-reboot` | Restart | System menu, login and lock screens |
| `nd-system-search` | Search | Bar, app grid, Settings |
| `nd-system-shutdown` | Shut down | System menu, login and lock screens |
| `nd-system-suspend` | Suspend | System menu, login and lock screens |
| `nd-user-trash` | Delete / remove; the trash | Lists, Control Centre, dock |
| `nd-utilities-terminal` | A command | Settings → Apps → Autostart |
| `nd-value-decrease` | Less (slider end) | Sliders |
| `nd-value-increase` | More; add (slider end, add button) | Sliders, Autostart |
| `nd-video-display` | Displays | Settings → Display |
| `nd-view-grid` | Applications | Settings → Apps |
| `nd-window-close` | Close / dismiss | Windows, notifications |
| `nd-window-floating` | Floating windows mode | Workspace mode control, Settings → Desktop |
| `nd-window-tiling` | Tiling windows mode | Workspace mode control |
| `nd-zoom-in` | Zoom in | Avatar cropper |
| `nd-zoom-out` | Zoom out | Avatar cropper |

## Changes

- **4** — add `nd-dialog-warning` (the installer's partition table marks a row that fails a rule).
- **3** — add `nd-globe` (the installer's Region page, split from `nd-preferences-system-network`).
- **2** — add `nd-clipboard-list` and `nd-rocket` (installer summary and run steps).
- **1** — first version: 83 names.
