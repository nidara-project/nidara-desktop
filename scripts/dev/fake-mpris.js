#!/usr/bin/env gjs
// fake-mpris.js — minimal MPRIS player for testing the shell's media widget
// (source selection heuristic, pin menu, cover-art resolution, seeking) without
// playing a sound. Registers org.mpris.MediaPlayer2.<name> on the session bus;
// drive it with playerctl (`playerctl -p <name> pause/play/position 30`);
// Ctrl-C (or Quit) to stop. It is also what `mpris-probe.ts` drives.
//
//   gjs scripts/dev/fake-mpris.js <name> <identity> <title> <artist> <artUrl> [Playing|Paused] [desktopEntry]
//
// Position advances with the clock while Playing, Seek/SetPosition move it and
// emit Seeked. FAKE_MPRIS_NO_TRACKID=1 removes mpris:trackid, which is the case
// where SetPosition is a no-op and a client must fall back to a relative Seek.
//
// Examples:
//   # data: cover art (the mpv-mpris case — the shell decodes it into
//   # ~/.cache/nidara/media-art itself; GIO cannot open a data: URI at all):
//   gjs scripts/dev/fake-mpris.js fakeA "Aurora" "Red track" "Artist A" \
//       "data:image/jpeg;base64,$(ffmpeg -loglevel error -f lavfi -i color=c=crimson:s=120x120 -frames:v 1 -f image2pipe -c:v mjpeg - | base64 -w0)" Playing kitty
//   # https cover art (curl'd into the same cache, asynchronously):
//   gjs scripts/dev/fake-mpris.js fakeB "Boreal" "Blue track" "Artist B" \
//       "https://github.com/nidara-project.png" Playing

const { GLib, Gio } = imports.gi

const [name, identity, title, artist, artUrl, status, entry] = ARGV
if (!name) {
    print("usage: fake-mpris.js <name> <identity> <title> <artist> <artUrl> [Playing|Paused] [desktopEntry]")
    imports.system.exit(1)
}
let playback = status || "Playing"

const rootXml = `<node>
 <interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
  <property name="SupportedUriSchemes" type="as" access="read"/>
  <property name="SupportedMimeTypes" type="as" access="read"/>
 </interface></node>`

const playerXml = `<node>
 <interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/><method name="PlayPause"/><method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
  <method name="SetPosition"><arg direction="in" name="TrackId" type="o"/><arg direction="in" name="Position" type="x"/></method>
  <method name="OpenUri"><arg direction="in" name="Uri" type="s"/></method>
  <signal name="Seeked"><arg name="Position" type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="LoopStatus" type="s" access="readwrite"/>
  <property name="Rate" type="d" access="readwrite"/>
  <property name="Shuffle" type="b" access="readwrite"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Volume" type="d" access="readwrite"/>
  <property name="Position" type="x" access="read"/>
  <property name="MinimumRate" type="d" access="read"/>
  <property name="MaximumRate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
 </interface></node>`

// mpris:trackid is what lets a client use SetPosition; FAKE_MPRIS_NO_TRACKID=1
// drops it, which is the (common) case a client has to cover with a relative
// Seek instead.
const noTrackId = GLib.getenv("FAKE_MPRIS_NO_TRACKID") === "1"

const metadata = () => {
    const m = {
        "mpris:length": GLib.Variant.new_int64(180 * 1000000),
        "mpris:artUrl": GLib.Variant.new_string(artUrl || ""),
        "xesam:title": GLib.Variant.new_string(title || "Test track"),
        "xesam:artist": new GLib.Variant("as", [artist || "Test artist"]),
    }
    if (!noTrackId) m["mpris:trackid"] = new GLib.Variant("o", "/org/mpris/track/1")
    return new GLib.Variant("a{sv}", m)
}

// Position: the spec forbids announcing it through PropertiesChanged, so a real
// player just lets it run and answers when asked. Same here — it advances with
// the monotonic clock while Playing and freezes when it is not.
let posUs = 0
let posAt = GLib.get_monotonic_time()
const curPos = () => (playback === "Playing" ? posUs + (GLib.get_monotonic_time() - posAt) : posUs)
const setPos = (us) => {
    posUs = Math.max(0, Math.round(us))
    posAt = GLib.get_monotonic_time()
    print(`[${name}] Position -> ${(posUs / 1e6).toFixed(2)}s`)
    if (playerExport) playerExport.emit_signal("Seeked", new GLib.Variant("(x)", [posUs]))
}

const root = {
    Raise() {}, Quit() { loop.quit() },
    CanQuit: true, CanRaise: false, HasTrackList: false,
    Identity: identity || name,
    DesktopEntry: entry || "",
    SupportedUriSchemes: [], SupportedMimeTypes: [],
}

let playerExport = null
function setStatus(s) {
    posUs = curPos() // freeze the clock at the value it had under the old status
    posAt = GLib.get_monotonic_time()
    playback = s
    print(`[${name}] PlaybackStatus -> ${s}`)
    if (playerExport) {
        playerExport.emit_property_changed("PlaybackStatus", GLib.Variant.new_string(s))
        playerExport.flush()
    }
}

const player = {
    Next() {}, Previous() {}, Stop() {},
    Pause() { setStatus("Paused") },
    Play() { setStatus("Playing") },
    PlayPause() { setStatus(playback === "Playing" ? "Paused" : "Playing") },
    Seek(offset) { setPos(curPos() + Number(offset)) },
    SetPosition(_trackId, p) { setPos(Number(p)) },
    OpenUri(_u) {},
    get PlaybackStatus() { return playback },
    LoopStatus: "None", Rate: 1.0, Shuffle: false,
    get Metadata() { return metadata() },
    Volume: 1.0,
    get Position() { return curPos() },
    MinimumRate: 1.0, MaximumRate: 1.0,
    CanGoNext: true, CanGoPrevious: true, CanPlay: true, CanPause: true,
    CanSeek: true, CanControl: true,
}

Gio.bus_own_name(
    Gio.BusType.SESSION,
    `org.mpris.MediaPlayer2.${name}`,
    Gio.BusNameOwnerFlags.NONE,
    (conn) => {
        const rootExport = Gio.DBusExportedObject.wrapJSObject(rootXml, root)
        rootExport.export(conn, "/org/mpris/MediaPlayer2")
        playerExport = Gio.DBusExportedObject.wrapJSObject(playerXml, player)
        playerExport.export(conn, "/org/mpris/MediaPlayer2")
        print(`[${name}] up (${playback}) — playerctl -p ${name} pause|play|play-pause`)
    },
    null,
    () => { print(`[${name}] lost bus name`); loop.quit() },
)

const loop = new GLib.MainLoop(null, false)
loop.run()
