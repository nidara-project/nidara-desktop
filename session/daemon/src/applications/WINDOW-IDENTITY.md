# Window identity (#998)

Applications1 owns one resolver; the dock consumes its WindowMatches and never
guesses from names. This is presentation identity, never permission to control a
window. Unknown windows retain their window-backed identity and processes without
windows cannot create running applications.

Ordered tiers: compositor activation binding, sandbox (Flatpak, Snap, Steam),
package ownership, launch unit, names, dialog parent. Each nonempty set intersects
the surviving candidates; an empty intersection cannot replace earlier evidence.
A singleton chooses immediately. Ambiguity is explicit and diagnostic candidates
remain bounded to 16 IDs / 8 KiB. Name subtier order preserves exact desktop ID,
StartupWMClass, verified Flatpak ID, ASCII case-insensitive ID/WMClass and initial
ID. Parent walks are bounded and cycle checked.

Package ownership means the pacman database lists the actual executable and the
desktop file in the same package; it is not an Exec substring. A package with an
HTTP handler is excluded from the package tier so browser PWAs cannot acquire the browser's
icon. Package evidence uses only the window PID's own executable, never an
ancestor's package. Launch units may choose only if that executable matches the
resolved Exec binary recorded at launch or the unit's actual main-process
executable. A terminal's unit cannot attribute a different child program. Unit
walks stop before session managers; Chromium's retained child unit needs the same
executable proof. A foreign scope cannot override conflicting names. Scope PID
suffixes also require current membership in that scope. MainPID reads are bounded
and cached (12 new queries per batch, 200 ms per query); unfinished batches
continue as queued work and leave those identities pending. Executable/unit
lookup caches are bounded to 8192 entries. No periodic systemd polling is
introduced.
No inherited environment marker, title heuristic or Chrome/PWA special rule is
used. A user override mechanism remains outside this change.

Process and package reads run outside GLib/H1 and painting. Evidence is cached for
an unchanged window identity and the package database is indexed lazily, watched
for invalidation, and never queried by spawning pacman. Late evidence is accepted
only for the same compositor connection and window identity. Token bindings live
until window close/connection loss; a consumed launch record cannot erase them.
Multiple Wayland windows can reuse a token only on the first presenting client's
connection. A different client cannot inherit identity from that token. The
foreground grant is single-use. X11 startup IDs remain single-use because
Xwayland shares a Wayland connection between independent X11 clients.

Validation must exercise each tier, ambiguity/narrowing, parent cycles, browser
exclusion, inherited markers, expiry/close/epoch boundaries, delayed workers and
the dock/ResolveWindow common result. Removing a tier must break its positive
case. Fixture evidence does not establish installed or physical-session behavior.
