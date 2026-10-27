# Native session media (Media1 v1)

`nidara-sessiond --media` serves `org.nidara.Media1` on `org.nidara.Session`,
`/org/nidara/Media`, with ObjectManager. The packaged notification/media unit
passes `--media`; Audio1, Config1, Network1 and Bluetooth1 remain separate opt-ins.
The MPRIS reader can coexist with the legacy TS reader. No TS code or bridge is
added: a pin in the current TS panel does **not** change Media1 selection. Keys
use Media1 selection until the panel moves to Rust. Lock UI is a later Rust-lock
step; this change only supplies the service and configuration keys.

## Objects and selection

Player paths are `/org/nidara/Media/players/g{generation}/p{serial}`. Every player
captures a unique D-Bus owner. Removal/replacement clears the pin; an old path
never controls a replacement owner, even if its well-known bus name is reused.
Subscribe before GetManagedObjects and apply bus order. On session service
owner-change discard all proxies. InterfacesAdded precedes root references;
references are cleared before InterfacesRemoved.

Root read-only properties: State (`Ready`/`Degraded`), LastError, Generation `t`,
Players `ao`, Selected `o` (`/` if none), SelectionMode (`Auto`/`Pinned`), PinnedBus,
Capabilities `as`, LockScreenControls `b`, PauseOnHeadphonesDisconnect `b`,
HeadphonePauseAvailable `b`. A connected service with no players is Ready.
An individual snapshot failure is visible as degraded; it does not discard other
players or silently keep failed transport capabilities. Audio1 absence is normal,
not a Media1 error; headphone-fallback is omitted and availability is false.

`SetSelection(s bus)` pins an existing player; empty means Auto. No persistence.
Auto chooses Playing first, then the most recent actual state change; ties are
stable by bus name. Metadata refreshes do not promote a player.

Root methods: SelectedPlay, SelectedPause, SelectedPlayPause, SelectedStop,
SelectedNext, SelectedPrevious, SelectedRaise. Each captures Selected once.
SelectedSeekTo(`o expectedPlayer,t trackRevision,x positionUs`),
SelectedSetVolume(`o expectedPlayer,d volume`), SelectedSetShuffle(`o,b`),
SelectedSetLoopStatus(`o,s`) reject a changed selection.

`MediaPlayer1` properties: BusName, Owner, Identity, DesktopEntry, AppIcon
(serialized GIcon), Title, Artists `as`, Album, LengthUs `x`, TrackId `o`,
TrackRevision `t`, PlaybackStatus, Rate `d`, PositionUs `x`, PositionAnchor
`(xtd)`, PositionAvailable, CanControl, CanPlay, CanPause, CanGoNext,
CanGoPrevious, CanSeek, CanRaise, ShuffleAvailable/Shuffle, LoopAvailable/
LoopStatus, VolumeAvailable/Volume/VolumeSource/VolumeLimit/VolumeTargets,
ArtState/ArtPath/ArtError, State/LastError/Capabilities. Optional data uses an
explicit availability flag; false is never presented as supported Shuffle=false.
Artists accepts the common provider string variant as a singleton list. Negative
lengths and Chromium's sentinel (anything above 2^53-1 microseconds) become zero.
TrackId is `/` for missing, malformed or MPRIS NoTrack identifiers.

Player methods: Play, Pause, PlayPause, Stop, Next, Previous, Raise,
SeekTo(`t revision,x positionUs`), SetShuffle(`b`), SetLoopStatus(`s`),
SetVolume(`d`), RequestPosition() → `(x positionUs,t monotonicUs,d rate)`.
CanControl and individual capabilities are checked; Raise respects CanRaise.
LoopStatus accepts only None/Track/Playlist. No Playlists, TrackList, Rate setter,
Quit, Fullscreen or OpenUri.

## Position, calls and updates

PositionAnchor is an absolute monotonic-clock anchor. Clients extrapolate only
while Playing, using Rate, and clamp to zero/known length. State/Rate changes
freeze the previous anchor before changing the clock. Seeked installs a new
anchor. PositionUs is a getter without change signals; there is no one-second
polling or notification timer. RequestPosition coalesces overlapping reads and
allows at most one provider read per ten seconds on demand, including failed
reads. A seek explicitly resynchronizes. Valid track IDs use SetPosition;
otherwise seek uses a relative offset after a fresh read and checks track revision
again. The track identity prevents a queued seek from targeting a later track.

PropertiesChanged carries values only for modified properties, invalidated=[];
no unchanged root properties are emitted during position/metadata/volume changes.
MPRIS method completion acknowledges provider acceptance, not audible playback or
window-manager acceptance of Raise. Calls have bounded deadlines (5s transport,
2s snapshot/position); timeout is uncertainty, not rollback. Actions are never
retried. Media errors include NotFound, NotSupported, InvalidArgument, StaleTrack,
StaleSelection, Unavailable, Busy, Timeout and Failed. Provider D-Bus errors can
also propagate; the key helper independently verifies *our* service is absent
before considering fallback.

## Volume and headphones

Prefer a published MPRIS Volume (write policy 0..1; actual readings above 1 stay
visible). Invalid published Volume does not cause a silent fallback. MPRIS units
are not converted to PipeWire's cubic scale. With no MPRIS Volume, match an
external Audio1 playback stream by PID/ancestor PID or unique normalized app-id.
The `/proc` walk is capped at 32 with cycle, same-user and starttime checks;
Flatpak can match DesktopEntry despite a D-Bus proxy PID. Metadata is informative,
not authenticated identity. Ambiguous players/streams yield no volume control.
Only a unique volume-capable stream delegates to Audio1.SetVolume; its cubic
scale and VolumeLimit apply. No matching stream never means the master output.

AudioNode1 additionally exposes ProcessId `u` (0 unknown). Audio1 adds capability
headphone-fallback and signal HeadphoneFallback(`t eventId,o oldOutput,o newOutput,
ao affectedPlayback,s reason`). Detection compares physical device/route snapshots:
headphones→speaker on the SAME node requires the old route to become unavailable;
BT/USB headphone-node loss requires the corresponding physical Device to disappear,
then the actual affected streams to link to a classified speaker within two seconds.
Missing/ambiguous evidence, virtual/HDMI destinations, profile reenumeration,
backend restarts and explicit Audio1 topology changes do not trigger a pause.
Explicit topology operations establish a short conservative suppression window.
This is not inferred from a default-output change alone.

Media1 pauses all uniquely matched affected players still Playing with CanPause,
checking owner, track revision and state-change identity again before each request.
It never resumes, and never retries a failed pause. AutoPauseResult(`t eventId,
o player,s result`) reports accepted or the error; acceptance is not observed
paused playback. Duplicate event IDs are ignored. Audio1 is optional; without it
MPRIS transport and MPRIS volume remain available.

Config1 owns `media.lock-screen-controls=true` and
`media.pause-on-headphones-disconnect=true` in `org.nidara.media` GSettings.
Changes by Config1 or another writer are observed on a confined GLib thread.
A future Rust lock reads the first key and this service; no lock UI is delivered
here. Disabling the second suppresses the automatic pause request.

## Artwork and keys

Local absolute paths, local file URIs, image data/base64 and HTTP(S) are copied
into `$XDG_CACHE_HOME/nidara/media-art/sessiond/` (default ~/.cache). This directory
is separate from the legacy TS writer. Limits: 10 MiB, ten seconds per request,
two workers, three redirects limited to HTTP(S), PNG/JPEG/GIF/WebP, at most
4096×4096 and 64 MiB decoder allocation. `image` uses only those codecs, no
native codec dependency. Signature and actual decode must pass before ArtPath is
published. curl is executed with fixed argv and disabled curlrc. File sources
must be regular and opens are nonblocking. Data and filenames are never executed.

SHA256 filenames and atomic rename publish complete files. The cache prunes its
own files at 150 entries/100 MiB, touching successful cache hits for recency.
Negative results are cached for 60 seconds, capped at 256 entries. A late result
checks owner, track revision and URL before publication. Art failure does not
remove playback controls. Icons use desktop-id, lowercase and bus candidates,
then an unambiguous Identity match in the application registry.

Hyalo's multimedia bindings spawn installed `nidara-media-key`; Pause is a real
pause. The helper calls Selected* with gdbus. It invokes playerctl only after
ServiceUnknown/NameHasNoOwner AND a successful NameHasOwner=false probe for
org.nidara.Session. It never falls back after Timeout, Failed, NotSupported or
an error about a disappeared MPRIS player while our service is alive. Hyalo code,
hyprland.lua and the live/installed session are untouched.

## Validation boundaries

The existing session test job runs the model/private-bus fixtures and local HTTP
art fixtures, Config1/GSettings round trips, optional Audio1 absence, Audio1 fake
volume/autopause and negative cases, plus the key helper with fake executables.
No CI jobs, steps or configuration are added. Native clippy/release and the
private PW/WP Audio1 matrix are checked locally. Model fakes/null sinks do not
establish physical jack/BT/USB timing, sandbox-specific process mappings, installed
unit/helper behavior or visible Rust-shell/lock acceptance. No system package is
installed and no service is restarted in the owner's session by these checks.
