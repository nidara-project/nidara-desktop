# Changelog

All notable changes to Nidara are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2] — 2026-08-17

Two volume fixes, both found by running the released build rather than reading it.

### Fixed

- **The Control Center read 0% volume from every login.** The slider was built
  before the audio endpoint had reported anything and then never asked again, so
  it showed 0% with the sound at whatever you had left it, and only corrected
  itself once something changed the volume from outside the shell. Dragging it
  always worked — it was the number and the fill that lied. The same missing read
  affected the volume panel in the top bar, Settings → Sound and the Control
  Center's volume detail; and if audio arrives after the shell does, those
  controls now come to life instead of staying dead for the session.

- **Waking from suspend could set your volume to something you never chose.** A
  pair of hooks saved the volume before sleep and re-applied it on wake — a
  workaround from May for a WirePlumber that no longer needs one. On the current
  stack the volume survives both a suspend and a full power cycle by itself, so
  the pair did nothing in the ordinary case and re-applied a stale value in any
  case where the saving half had not refreshed its file. Both halves are gone;
  waking still re-enables the displays.

## [0.7.1] — 2026-08-17

A settings release. Every one of Settings' 21 pages was read line by line against
what it actually reads and writes, and most of what follows is what that found:
controls that showed a value from when the window opened, controls that wrote a
key nothing reads, and two controls fighting over one setting.

### Fixed

- **The pointer kept the old cursor until you left the window.** Changing the
  cursor theme or size did nothing you could see until you moved the pointer out
  of whatever window you changed it from. Two separate faults: the accessibility
  page and the appearance page each had a cursor-size control and only one of them
  reached the compositor, and Hyprland only repaints the pointer when it is told a
  *different* shape name — so the shell now names another shape and names the
  original straight back, in one pass, with nothing composited in between.

- **Settings pages showed you the state of the world when the window opened.**
  Nearly every page asked the system once, at build time, and a frozen value looks
  exactly like a correct one. The pages that show a value read it again when you
  come back to them now — text size, the AI provider's fields, appearance, the
  users list, the VPN list, and the rest.

- **Choosing a default web browser never took effect.** The row wrote `text/html`,
  while everything that opens a link reads `x-scheme-handler/http`. The other rows
  were partial in the same way: "Image viewer" set only `image/jpeg`, so a PNG kept
  opening in the old app. Each row now writes its whole category — and offers only
  applications that actually handle it, instead of listing a text editor as a
  candidate web browser.

- **Do Not Disturb could only be switched on.** The bar toggle set the flag and
  had no path back to off.

- **Two keyboard controls wrote one setting, and the one that lost reset your
  variant.** Related: a layout the dropdown does not know about — `es,us`, or any
  XKB variant — was displayed as "English (US)", one click away from making that
  display true and wiping your second layout. A value the list does not contain is
  now shown as itself rather than rounded down to the first entry.

- **"Enable animations" quieted your applications and left the desktop moving.**
  It wrote a GNOME key that GTK reads and Nidara never did, so overlays kept
  popping, the dock kept springing and Hyprland kept animating every window and
  workspace. It is now "Reduce motion", and it is the real thing.

- **Opening Settings rewrote a file your login reads.** All 21 pages are built when
  the window opens, so Region's locale dropdown ran every time and wrote
  `region.json` and `~/.config/environment.d/nidara-locale.conf` no matter which
  page you actually wanted. The writes were byte-identical, which is why nothing
  ever looked wrong.

- **Leaving a game put your power profile on Balanced.** Game mode captured
  nothing on the way in and set a constant on the way out, so a session started
  from Power saver ended somewhere else with nothing said.

- **A second monitor showed two controls for one setting.** Options that are global
  were drawn once per screen, so changing one left the other showing the old value.

- **Settings could take on a key but never drop one**, so a retired setting
  outlived the code that gave it meaning.

- **The Gaming page's wallpaper selector could end up showing nothing selected**
  while a mode was still in force — clicking the already-selected segment turned it
  off. Settings had two segmented controls with the same look and different
  mechanics; there is one now.

- **The window menu acted on a window the bar had already stopped naming**, and the
  Activity Island could paint chips in places clicks never reached.

- **Two of the four shell surfaces never noticed the monitor changing shape**, so a
  resolution or scale change left them measuring against the old geometry.

- **The Assistant's pointer work took away the focus it had just set**, which broke
  the step right after it.

- **Ten languages carried two Settings descriptions that no longer matched.** The
  English had been rewritten to say a change is system-wide rather than account-only;
  the translations still said "requires a session restart". A missing translation
  falls back to English and looks untranslated — one that has gone stale reads
  perfectly and is wrong, so CI now tracks both.

### Changed

- **The nidara package declares the build dependencies it actually uses.** Two of
  them existed in the release build container only because another package happened
  to pull them in first. That is the exact shape of the fault that killed the v0.7.0
  release halfway through.

- **Sliders, settings rows and group footers moved into the shared kit**, so they
  pick up the accent and the light/dark surface the same way everywhere instead of
  four pages each building their own.

## [0.7.0] — 2026-08-11

### Fixed

- **The login card was invisible.** Since 0.6.0, the greeter drew its background
  and nothing else: no card, no username, no password field. You could still log
  in by typing blind and pressing Enter, which is the only reason it was not
  reported sooner. A single failing line in a signal handler was aborting the
  rest of the card's construction silently — nothing crashed, nothing logged.
  CI now boots the greeter and the lockscreen and fails if either comes up empty.

- **Every install that built its package locally left you locked out of your own
  package cache.** The build ran as root and left root-owned files behind, so the
  next `pacman` invocation refused to write there. Anyone whose install fell back
  to a local build — the normal path whenever the prebuilt package is behind —
  hit it.

- **Text was being shaved at the top.** Capital letters and accents lost their
  first pixel row across the whole shell, because the baseline never landed on a
  pixel boundary. Fixing it properly also fixed the accessibility text slider,
  which was snapping to whole pixels and therefore skipping sizes: font sizes are
  in points now, and the crispness comes from the metric hint it was missing.

- **Picking a font whose name contains a style quietly switched your desktop to
  something else.** Choosing "Inter Medium" set the interface to a different
  family entirely; this machine had been running the wrong font for months
  without anyone noticing.

- **Russian shipped with a truncated menu entry.** "Специальные возможности" did
  not fit the sidebar at the default text size, in a released version. It is
  abbreviated now, and a new CI gate measures every sidebar entry in all twelve
  languages at every text scale, so the next one cannot ship unnoticed.

- **The lock screen's "wrong password" message misbehaved three ways.** It moved
  the field you were about to retype in, it stayed on screen after every reason
  to still be there had passed, and the entrance animation never ran at all on
  the lock. All three are fixed, and the clock now appears with the first frame
  instead of jumping into place.

- **Settings pages were each quietly a different window.** Page width was derived
  from content, so switching pages resized the window under your pointer. The
  content pane is a constant width now. The breadcrumb also showed only one
  ancestor, so a three-level page lost the one that says where you are.

- **The Sound page had two empty sections**, and the alert dialog Settings opens
  spent three days with no styling at all.

### Changed

- **The desktop got substantially cheaper to draw.** The bar, the Activity
  Island, the dock and the app grid were each asking the compositor to blur an
  entire monitor in order to show a strip, a capsule or a panel — and the app
  grid was taking the dock's blur down with it every time it opened. Each surface
  now declares only the region it occupies. Opening the Control Center costs
  nothing measurable where it used to cost real frames, and the Workspace
  Overview shows live window content rather than placeholders.

- **Clicking outside a panel to dismiss it is the compositor's job now.** The
  invisible full-screen catchers the shell used for this are gone, replaced by
  the Wayland protocol built for it.

- **The greeter and the lockscreen rejoined the design system.** They had drifted
  into their own look and their own copies of widgets Nidara already had — one of
  those copies had stopped describing the screen accurately. They share the real
  components now.

## [0.6.0] — 2026-08-04

### Added

- **The Assistant stopped talking about your desktop and started working on it.**
  In 0.5.0 it could hold a conversation and flip a setting. It now reads Nidara's
  own configuration, the shipped defaults and the shell log, so when you say
  something is wrong it goes and looks instead of theorising — and, if you allow
  it, it can edit the handful of files no service owns (your Hyprland overrides
  and the idle timers) to add a keybind or change a timeout for you.

  Writing is **off by default** and deliberately a separate switch from
  everything else: those files exist to hold commands, so writing them schedules
  commands for your next session. Everything it writes is plain text you can
  read, and `~/.config/nidara/` becomes a **git repository** on its first write —
  every change it makes is a commit you can inspect or roll back.

  It also stopped forgetting. The conversation survives a shell reload, and it
  answers questions about its own permissions accurately rather than describing
  half of them.

- **The Assistant can work in other applications — if you let it.** Previously it
  was capable inside Nidara and blind outside it. It can now perceive and act on
  third-party windows through the accessibility layer, which is what "open the
  calculator and compute this" actually requires. Both halves — *seeing* and
  *acting* — are **off by default** and are separate switches in Settings → AI.
  `Super + Shift + Escape` still revokes everything instantly.

- **You can see which window the Assistant is working in.** While it runs a turn,
  the focused window's border glows. It was doing real work in somebody else's
  window with nothing on screen to say so.

- **Your clipboard keeps images.** Copying an image from a browser stored the
  page's URL instead — every time — so no image ever reached the history. Images
  are now kept alongside text, and the panel gained per-entry delete.

- **Screen recording asks what you actually meant.** "Include audio" used to mean
  *the default microphone*, which on most machines meant silence. You now choose
  the source — your desktop's output or any specific microphone — and the format
  (MP4, MKV or WebM).

- **Scrollbars you can grab.** Long lists across the shell now show a scrollbar of
  their own that stays a fixed width and can actually be dragged, instead of GTK's
  overlay bar that grew as your pointer neared it and slid out from under the
  button you were aiming for.

### Changed

- **Two switches left Settings → Top bar.** "Show the system menu" hid the only
  graphical way to shut down, restart or log out, and "show the workspace
  switcher" had quietly grown into a switch that also hid media, recording and
  the Assistant — including the only indicator that says your screen is being
  recorded. Both are gone; they read as preferences but were ways to lose a
  capability. "Show the app title" stays.
- **Settings rows stop crowding.** Rows that carried several controls were fitting
  them into space built for one. Text fields now take the full width with their
  buttons underneath, and pickers that show a value actually carry it.
- **One radius ladder, one halo.** A sweep of the design system removed a second,
  conflicting set of corner radii and the stray hover halos that came with it, so
  menus, dropdowns and cards round and highlight the same way everywhere.
- **The Assistant's chip and the battery glyph are drawn to the icon grid.** The
  battery was the one bar icon painted by hand at a size picked by eye, which left
  its capsule 9px wider than its neighbours; the player's chip showed square cover
  art inside a circle.

### Fixed

- **An overlay no longer freezes the dock.** Opening a shell surface could leave
  the dock unresponsive until something else took the pointer, and the error bar
  stayed on screen after the event that raised it was gone.
- **Settings pages keep their contents.** A page you stepped away from was torn
  down as if it had been closed, so coming back to it showed a page that had
  stopped updating.
- **Applications are identified by what they are, not by what they look like.**
  One app could appear under three different names across the dock, the app grid
  and the window title, with only one of them working on each surface.
- **The Activity Island's menus are blurred like everything else.** Moving the
  island to its own layer left its player-source menu flat.
- **A single clip stored in the wrong text encoding hid the other 749.** One
  UTF-16 entry silently truncated the whole clipboard history.
- **Three widgets' buttons were the right colour only by accident** — they
  depended on where they happened to be rendered rather than on their own style.

## [0.5.0] — 2026-07-26

### Added

- **The Assistant — experimental, and yours to switch on.** Nidara now has a
  built-in conversational assistant living in the Activity Island (`Super+A`).
  It is **off until you configure it** in Settings → AI, and it brings no model
  of its own: you choose a provider — Anthropic, OpenAI, Google or SpaceXAI, any
  OpenAI-compatible endpoint, or a local model through Ollama or llama.cpp,
  which needs no key at all — and it talks to your account. Your API key is
  stored in the desktop keyring, never in a config file, and nothing leaves your
  machine until you opt in.

  It drives the desktop through exactly the same command surface an external
  agent uses, so it can do nothing you have not allowed in Settings → AI: the
  computer-use permissions stay off by default, and the kill switch
  (`Super+Shift+Esc`) still revokes everything instantly. Answers stream as they
  arrive, the capsule shows a working state while a turn runs, and closing the
  island does not cancel it.

  Marked experimental deliberately: it works, it is useful, and it is younger
  than the rest of the desktop. Expect rough edges, and expect it to change.

### Fixed

- **The login keyring now unlocks with your session.** Signing in left the
  keyring closed, so the first application that wanted a secret — a browser, a
  mail client, the Assistant itself — asked for your login password a second
  time, every session. A systemd socket was winning a race against PAM's
  keyring daemon and taking over with no password to unlock anything.

  On existing installs the change lands after a **reboot**, not merely a new
  login: masking a unit does not stop the copy already running, and a lingering
  user session keeps it alive across logout. Note too that the desktop now uses
  the keyring PAM unlocks; if yours was created outside your login password, its
  secrets are not migrated. Nothing is deleted — the old keyring file stays in
  `~/.local/share/keyrings/` and Seahorse can open it if you know its password.
- **Your wallpaper survives a reboot.** Setting a wallpaper worked, but the
  desktop came back to the shipped default on the next boot.
- **Typing goes to your window again after closing a shell surface.** Closing
  the app grid — and, on every shell reload, doing nothing at all — left the
  dock holding the keyboard, so keystrokes went nowhere until you moved the
  mouse. It also made every other overlay look broken afterwards.
- **The bar's title capsule stops lying about what is focused.** It fell back to
  the workspace name after closing the overview, the Assistant or the search,
  and it kept naming a window from the workspace you left when you switched
  workspaces from the app grid. The dock's focus ring, the window menu and
  "screenshot the focused window" were blind for the same reason.
- **Switching to an empty workspace from the overview stays there.** The
  compositor bounced you back to the workspace you came from a few milliseconds
  later — only ever on empty ones, which is why it read as random.
- **The login screen no longer greets you with Hyprland's release notes.**
  Hyprland shows an "updated to X" panel the first time it starts after a
  version change; on the greeter it landed on top of the login card, so the
  first boot after any system upgrade that carried Hyprland covered the password
  field with someone else's news.
- **The Activity Island's blur reaches the bar underneath it.** The island's
  expanded panels now sit on their own layer, so the glass blurs what is behind
  them instead of stacking a seam over the bar mid-morph.

## [0.4.0] — 2026-07-20

### Added

- **The Activity Island.** The workspaces capsule at the bar's center is now a
  living, multi-purpose surface. Its panels don't pop over it — the capsule
  itself transforms: the workspace overview grows out of the pill as one
  continuous glass shape and condenses back into it when it closes.
- **Now Playing on the island.** While media plays, the capsule morphs into a
  mini player — cover art, title and a live equalizer. Clicking it expands the
  full player panel, the cover art flying into place. A short pause or a track
  change never flickers the capsule back and forth, and it returns to the
  workspace dots when the player quits.
- **Live activities, with priorities.** The island now hosts live system
  state: an active screen recording shows a pulsing REC dot with the elapsed
  time (an active capture outranks music), and a critically low battery takes
  over the capsule and opens an alert on its own — it dismisses itself the
  moment you plug in. This is the groundwork the native assistant will build
  on.
- **Notification Center, polished end to end.** Notification groups stack as
  cards with a peeking edge and expand with a smooth choreography; hovering a
  notification reveals its controls in the corner; swiping flings it out the
  way it came (swiping a collapsed group clears the whole group); "Clear
  notifications" cascades the list out top-to-bottom. Banners respect
  freedesktop urgency, transient and replacement semantics, and now show above
  open panels.

### Fixed

- Notification ordering no longer goes stale when an older group receives the
  newest message, and timestamps refresh each minute without rebuilding the
  cards under your pointer.
- The shell log is quieter: two recurring GTK/GJS warnings (one per media
  update, one per notification swipe) are fixed at the source.

## [0.3.3] — 2026-07-18

### Fixed

- **Exiting fullscreen no longer sends the dock into a reserved-space storm.**
  A 0.3.2 regression in the dock's new real-time spring clock could make the
  slide animation diverge while a fullscreen window starved the dock's frame
  clock (and permanently on true 60 Hz displays): on exit, windows retiled
  repeatedly and the dock took seconds to reappear. Springs now integrate in
  numerically stable substeps — the animation feel is unchanged.

## [0.3.2] — 2026-07-18

### Changed

- **Dock magnification now defaults to its full size (128px).** Hovering the
  dock grows icons to double their resting size on fresh installs; existing
  installs keep whatever they had configured.
- **Dock animations feel the same on every monitor.** The magnification and
  auto-hide springs are now clocked by real time instead of frames, so a 60 Hz
  monitor gets the same snappy feel as a 144 Hz one (it used to run 2.4× slower
  there), and mixed-refresh multi-monitor setups stay consistent.

### Fixed

- **Reordering dock icons now tracks the pointer precisely.** Dragging an icon
  across the pinned/open-apps separator used to need the pointer well past it,
  and the whole open-apps zone inherited that lag; the drop preview also
  flickered when the pointer sat exactly between two positions. Both gone.
- **Control Center and Notification Center no longer swallow clicks around
  them.** Their clickable area now matches the visible panels exactly —
  including the Control Center's edit mode — so clicking beside a panel reaches
  whatever is beneath instead of doing nothing.
- **Long window titles no longer overflow the window menu.** Group-member rows
  in the bar's window menu truncate with an ellipsis instead of stretching past
  the menu's glass capsule.

## [0.3.1] — 2026-07-15

### Changed

- **System-tray icons each get their own capsule.** Every tray icon now sits in
  its own glass capsule, coherent with every other bar icon, instead of being
  grouped together in a single pill.
- **Tooltip and menu pointers are shorter and sharper** — the little pointer that
  aims from a bubble toward its anchor now sits closer to it and reads crisper.

### Fixed

- **Left-clicking a tray icon now brings the app to the front.** It focuses the
  app's window — switching to its workspace if needed — instead of silently doing
  nothing. (A Wayland app can't raise itself, so the desktop does it.)
- **The login screen now shows dates and CJK text in the selected language.** The
  greeter runs under the matching locale, so its clock's date names are localized
  and Chinese/Japanese/Korean text uses the correct regional glyph shapes; before,
  it defaulted to English dates and the wrong CJK faces.
- **The launcher icon no longer halos on the dock.** Its drop shadow was being
  blurred by the dock's own frosted layer into a faint halo; the shadow (invisible
  anyway on a blurred layer) has been removed.

## [0.3.0] — 2026-07-13

### Added

- **Language selection everywhere it was missing.** The login screen now has a
  language selector (every language shown by its own name), and installs now
  generate the system locales for all shipped languages — so Settings →
  Language & Region actually offers them. In 0.2.0 the translations shipped
  inside the desktop, but most systems had no generated locale to select them
  with.
- **European Portuguese (pt-PT)** joins as the 12th language — a genuine
  European translation (utilizador, palavra-passe, ficheiro…), distinct from
  Brazilian Portuguese. The login screen and the lock screen now speak all 12
  languages as well.

### Fixed

- **Chinese and Japanese now render with their correct regional character
  forms.** All CJK text used to fall back to the Korean variant of the Noto
  CJK fonts (a quirk of stock fontconfig on Arch), so Chinese and Japanese
  users read their hanzi/kanji with Korean stroke shapes. Each language now
  gets its proper regional variant (Simplified, Traditional, Japanese, Korean)
  across the whole session — applications included. The Noto CJK fonts are
  also installed by default, so 简体中文 and 日本語 in the language pickers no
  longer render as empty boxes on a clean install.
- A garbage-collection crash in a core layout container (NidaraClamp) that
  could error when interface views were rebuilt.

## [0.2.0] — 2026-07-12

### Added

- **Nidara now speaks 11 languages.** French, German, Italian, Brazilian
  Portuguese, Polish, Dutch, Russian, Simplified Chinese and Japanese join
  English and Spanish. The desktop follows your system language; change it in
  Settings → Language & Region.
- **You can now see your AI agent's cursor.** When an agent acts through
  computer control (off by default, Settings → AI), an accent-colored pointer
  with an "AI" badge travels to the target and pulses where the action lands —
  you always see where the agent clicked, and it backs off the moment you move
  your own mouse. The red bar indicator and the Super+Shift+Esc kill switch
  still stop everything instantly.
- Autostart entries can now be added by picking from your installed apps —
  search, pick, done. The raw-command field remains for advanced entries.

### Changed

- Clocks and dates across the desktop — top bar, login screen and lock
  screen — now follow your system regional format: localized day and month
  names and the native field order, including year-first formats such as
  Chinese and Japanese (e.g. 7月12日 土曜日). Dates no longer render in
  hardcoded English.
- Autostart moved from its own sidebar page into Settings → Apps, and it now
  appears in Settings search.
- A consistency pass over the English and Spanish interface texts (sentence
  case throughout, unified terminology).

### Fixed

- Autostart entries edited in Settings now take effect on a standard install —
  the old page wrote to a file Hyprland never read, so its entries silently
  never launched.

## [0.1.7] — 2026-07-11

### Added

- Default terminal configuration: kitty now ships with a Nidara config on new
  setups — window padding that keeps text clear of the rounded corners, the
  JetBrains Mono font, a subtle glass transparency, and terminal colors that
  follow the system dark/light toggle live. Seeded only when you have no kitty
  config of your own; an existing setup is never touched, and once seeded the
  file is yours (updates never overwrite it).

### Changed

- Laptops now suspend after 30 minutes of idle by default (desktops never
  auto-suspend); Settings → Power overrides this either way.

### Fixed

- Appearance → Fonts on a fresh install showed "Adwaita Mono" — a font Nidara
  doesn't ship — as the monospace font. The bundled JetBrains Mono is now the
  default; a font you picked yourself is never overridden.
- Users created after install time (Settings → Users, `useradd`, archinstall)
  now get their per-user configuration seeded at first login, before the
  desktop loads — previously they landed on an unthemed session with defaults
  missing. A deleted `~/.config/nidara` heals itself the same way.
- Users without a profile photo now see the same avatar glyph on the login
  screen, the lock screen and Settings, instead of a different placeholder on
  each.

## [0.1.6] — 2026-07-10

### Added

- The login screen now remembers the last user who signed in and preselects them at
  boot — avatar, name and their appearance/clock preferences — instead of always
  presenting the first account.

### Fixed

- Settings → Users no longer shows "Unknown" as the display name on systems installed
  without a full name (e.g. archinstall); setting a name now takes effect immediately
  across Settings, the login screen and the lock screen.
- The language and keyboard layout picked at the login screen now survive a reboot,
  and stray greeter dotfiles no longer land in the filesystem root.
- Creating a user: cancelling the password authorization no longer closes the dialog
  as if it had succeeded (the account existed but couldn't log in) — the error is
  shown and Create retries just the password step; a blank password now intentionally
  creates a locked account, as the field promised; picking an existing username now
  says exactly that.
- The Other Users list no longer goes blank after creating or deleting a user.
- "Change Password" on a user row now opens (it failed silently before) and survives
  a cancelled authorization prompt.
- The administrator toggle no longer re-opens the authorization prompt in an endless
  loop when cancelled, has a visible label now, and the user glyph in the list is no
  longer black in dark mode.

## [0.1.5] — 2026-07-09

### Fixed

- The lock screen now shows the default wallpaper on fresh installs — until a wallpaper
  was picked in Settings it painted a flat backdrop. It also falls back gracefully (user
  wallpaper → default) when the configured image no longer exists on disk, instead of
  going blank. Groundwork included for assigning independent wallpapers to the desktop,
  lock screen and login screen from Settings in a future release.
- On multi-user machines the lock screen now shows — and verifies the password of — the
  user who actually locked the session; previously it always presented the first user
  account, locking everyone else out of their own session.
- The login screen's clock now honors the time and date format chosen in Settings even
  when the user's home directory is private (mode 700).
- Config files generated before the Nidara rename no longer keep "Crystal Shell" headers
  forever — they're rewritten (comments only, never user content) on the next
  install or update.

## [0.1.4] — 2026-07-09

### Changed

- Settings → Apps → **Installed Apps** (formerly "App Icons") now opens each app on its
  own page instead of a pop-up dialog — more room for the icon override, which now applies
  instantly (no Apply/Cancel), and a natural home for future per-app settings. Each row now
  shows the app's id as its subtitle.

### Fixed

- The tails of letters like g, j, y and p no longer linger as faint leftover fragments — nor
  get clipped short — in the Installed Apps search while filtering the list.

## [0.1.3] — 2026-07-07

### Changed

- **Nidara now installs as a real pacman package (`nidara`).** System installs consume it
  prebuilt from the project's signed repo (or build it on the spot from the same in-repo
  recipe when the repo doesn't serve the release yet) — pacman owns every installed file,
  so Nidara upgrades with the rest of the system (`pacman -Syu`) and removes cleanly
  (`pacman -R nidara`). Existing installs migrate automatically on their next
  `nidara-update`; user config is untouched.
- `nidara-update` on package installs is now a full system upgrade plus the idempotent
  setup pass, reloading the running session only when the version actually changed.
- New `nidara-setup` binary carries the first-time setup packaging can't do (greeter,
  services, per-user config seeding) — with the repo configured,
  `sudo pacman -S nidara && nidara-setup` is a complete install.

### Added

- `toggleAbout` IPC action — the About window can now be opened, verified and closed
  deterministically (agent tooling parity with the other surfaces).
- Community docs: Code of Conduct (Contributor Covenant 2.1) and a Credits section.

### Fixed

- Upgrading or reinstalling under a live session no longer leaves a stuck Hyprland
  "cannot open … hyprland.lua" error banner — replacing the packaged config file killed
  the compositor's config watch; both update paths now reload it once the new file is
  in place.

## [0.1.2] — 2026-07-06

### Fixed

- With a surface open (Control Center, Notification Center, system menu, or a widget
  pill), clicking another bar capsule now switches to it in a single click — the first
  click no longer just dismisses. Clicking anywhere below the bar still dismisses.
- The widget expansion panel no longer flashes at the previous pill's position when
  jumping directly from one pill to another.
- Updates no longer abort on the repository's moving `ci-assets` tag — `nidara-update`
  fetches only release tags (`v*`).
- Updates no longer silently drop agent-carried local fixes: when a patch stack is
  registered (`~/.config/nidara/.patches`), `nidara-update` and `install.sh --update`
  refuse the blind reinstall and point at the carry flow (rebase onto the new release,
  then `install.sh --update-apply`).

## [0.1.1] — 2026-07-05

### Security

- The prebuilt dependency repo ([nidara-repo](https://github.com/nidara-project/nidara-repo))
  is now GPG-signed end-to-end: CI signs every package and the repo database, and
  `install.sh` imports the project key and enforces signature verification
  (`SigLevel = Required DatabaseOptional`). Existing installs are migrated automatically
  on their next update. No changes to the desktop itself.

## [0.1.0] — 2026-07-05

First public release. Nidara is a full Wayland desktop environment for Arch Linux,
built on Hyprland and AGS v3 (Aylur's GTK Shell), registering as a proper login session.

### Desktop

- **Compositor** — Hyprland (Wayland) with smooth animations and tiling + floating
  window management; Lua-based config with a user override file
  (`~/.config/nidara/hyprland-user.lua`).
- **Bar** — live clock, workspaces, system tray, resource indicators, and a system
  menu with inline power actions.
- **Dock** — hover magnification with spring physics; bottom, left, and right
  positions.
- **App Launcher** — full-screen grid with instant fuzzy search.
- **Control Center** — volume (WirePlumber), brightness, Wi-Fi, Bluetooth, battery,
  and MPRIS media, with a resizable tile grid and per-widget bar/CC placement.
- **Notification Center** — grouped notifications with inline actions.
- **Login & Lock** — a greetd-based greeter (`nidara-greeter`) and a lock screen
  (`nidara-lock`, on `ext-session-lock-v1`), both sharing the Nidara look; no regreet,
  no hyprlock.
- **Idle management** — hypridle with configurable screen-off, lock, and suspend timers.
- **Hardware & media keys** — volume, mic mute, brightness (floored above black), and
  MPRIS transport (`XF86*`) bound out of the box, working on the lock screen too.
- **Familiar shortcuts** — `Alt + Tab` window cycling, `Super + M` maximize,
  `Super + Space` Search, `Super + Ctrl (+ Shift) + ←/→` workspace navigation,
  alongside the tiling basics (focus, resize, float, fullscreen, pseudo-tile).

### Settings

- Multi-page settings panel: Appearance, Display, Audio, Network, Input, Bluetooth,
  Language & Region, Applications (default apps + per-app icon overrides), Dock & Panel,
  Control Center (controls placement), Notifications, Autostart, Power, Accessibility, Gaming, Users, AI, and About.
- Live Wi-Fi (connect/forget/detail), Bluetooth (pairing agent with passkey/PIN dialogs),
  and audio device management.

### Design system

- Nidara design system: dynamic accent colors, glassmorphism/material tokens, and
  dark/light mode, generated at runtime by the theme engine.
- libadwaita apps follow the Nidara accent live via a desktop-portal backend.

### Gaming

- Game mode: Steam games auto-move to a dedicated `gamespace` workspace (no
  blur/shadow/animations, `immediate` mode), with optional library-art wallpaper and a
  performance power profile. `Super + B` floats the bar above any fullscreen window.

### AI-native tooling

- Bundled **MCP server** (`nidara-mcp`) that lets an AI agent see and control the running
  desktop through the official interface — read state, change settings, run shell actions,
  and take screenshots to verify its work.
- An in-repo agent skill (`.claude/skills/nidara/`) ships with the code so coding agents
  can extend and fix the desktop.
- All agent capabilities are governed by consent toggles in **Settings → AI** (config
  writes, screenshots, and the MCP server itself can each be switched off, effective
  immediately).

### Installation & updates

- `install.sh` provisions onto an existing minimal Arch system: installs dependencies,
  builds the Astal/AGS libraries from pinned sources (no AUR helper) and hands them to
  pacman, builds the three bundles, and registers the Wayland session. Enables `greetd`
  only when no display manager is already present.
- Stateless updates via `nidara-update`; user config in `~/.config/nidara/` is never
  overwritten.
- First-run defaults are seeded from the existing Arch setup (keyboard layout, timezone,
  locale) without prompting.

### Internationalization

- All UI strings routed through `t()`; English and Spanish included.

[0.1.2]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.0
