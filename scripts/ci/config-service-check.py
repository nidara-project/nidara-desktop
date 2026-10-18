#!/usr/bin/env python3
"""org.nidara.Config1 against the running shell (core/ConfigService.ts).

Run inside the smoke's session, after the shell's IPC answers. Every assertion names what
it proves; each fails if its piece is missing:
  1. Describe: JSON, a `ui` with a translated title, the WHOLE enum (agents get a sample).
  2. Get: the value the registry has.
  3. Set from an ordinary sender + Changed: the new accent is applied and announced
     (fails without the accent's `subscribe`).
  4. A change made by the agent's door (`nidara-ipc setConfig`) is announced too.
  5. An invalid value is refused with Config1.Error.Invalid.
  6. With Settings → AI's config writes off, an ordinary sender is refused (Denied):
     this door is not wider than `setConfig`.
  7. The wallpaper transition is announced (it was applied silently until #852's review); a
     window style written by another process is announced, and the shell carries it into
     Hyalo's `[windows.background]` (toolkit/PHASE1.md D6) — with the kit's levels.
  8. The sync protocol: Snapshot (epoch, revision, versioned schema with `available` and the
     bundled-wallpaper catalogue); Apply answers the canonical value and a higher revision that
     an Updated carries; a no-op Apply answers the same revision and announces nothing.
  9. Appearance's own keys: wallpaper/schedule/font validation, schedule and font applied.
 10. A GTK theme installed after the shell started is offered (enums re-read).
 11. The owner of org.nidara.SettingsNative writes while agent writes are off.
Restores everything it changed.
"""
import json, os, shutil, subprocess, sys
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

IPC = sys.argv[1] if len(sys.argv) > 1 else 'nidara-ipc'
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
proxy = None
for _ in range(50):
    try:
        proxy = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None,
                                       'org.nidara.Config', '/org/nidara/Config', 'org.nidara.Config1')
        if proxy.get_name_owner():
            break
    except GLib.Error:
        pass
    GLib.usleep(100_000)
else:
    sys.exit('FAIL: nobody owns org.nidara.Config')

def call(method, args=None):
    return proxy.call_sync(method, args, Gio.DBusCallFlags.NONE, 5000, None)

changes = []
proxy.connect('g-signal', lambda _p, _s, name, params:
              name == 'Changed' and changes.append(params.unpack()[0]))

def wait_for(key, value, what):
    loop = GLib.MainLoop()
    deadline = GLib.get_monotonic_time() + 5_000_000
    def poll():
        if any(c.get(key) == value for c in changes) or GLib.get_monotonic_time() > deadline:
            loop.quit()
            return False
        return True
    GLib.timeout_add(20, poll)
    loop.run()
    if not any(c.get(key) == value for c in changes):
        sys.exit(f'FAIL: {what}: no Changed with {key}={value!r} (got {changes})')

def fails_with(name, method, args, what):
    try:
        call(method, args)
    except GLib.Error as e:
        if name in e.message:
            return
        sys.exit(f'FAIL: {what}: wrong error {e.message}')
    sys.exit(f'FAIL: {what}: was accepted')

schema = json.loads(call('Describe').unpack()[0])
dark = schema.get('appearance.darkMode', {})
if not (dark.get('ui', {}).get('title') and dark.get('type') == 'boolean'):
    sys.exit(f'FAIL: Describe: appearance.darkMode has no translated ui title ({dark})')
layouts = schema.get('input.keyboard.layout', {}).get('values', [])
if len(layouts) <= 40 or 'valuesTotal' in schema['input.keyboard.layout']:
    sys.exit(f'FAIL: Describe: the keyboard layouts are a sample ({len(layouts)}), not the whole enum')
print(f'ok describe: {len(schema)} keys, ui titles, {len(layouts)} keyboard layouts')

accents = schema['appearance.accent']['values']
accent = call('Get', GLib.Variant('(as)', [['appearance.accent']])).unpack()[0]['appearance.accent']
if accent != schema['appearance.accent']['value']:
    sys.exit(f'FAIL: Get: {accent!r} is not the registry\'s {schema["appearance.accent"]["value"]!r}')
print(f'ok get: appearance.accent = {accent}')

other = next(a for a in accents if a != accent)
call('Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', other)]))
wait_for('appearance.accent', other, 'Set from an ordinary sender')
print(f'ok set + changed: appearance.accent → {other}')

dark_was = dark['value']
subprocess.run([IPC, 'setConfig', 'appearance.darkMode', str(not dark_was).lower()], check=True,
               capture_output=True)
wait_for('appearance.darkMode', not dark_was, 'a change through nidara-ipc')
subprocess.run([IPC, 'setConfig', 'appearance.darkMode', str(dark_was).lower()], check=True,
               capture_output=True)
print('ok changed from the agent door (nidara-ipc setConfig)')

# The wallpaper transition, applied and never announced until #852's review (the shell's
# setter emitted nothing).
transitions = schema['wallpaper.transition']['values']
transition = schema['wallpaper.transition']['value']
new_t = next(t for t in transitions if t != transition)
call('Set', GLib.Variant('(sv)', ['wallpaper.transition', GLib.Variant('s', new_t)]))
wait_for('wallpaper.transition', new_t, 'Set of wallpaper.transition')
call('Set', GLib.Variant('(sv)', ['wallpaper.transition', GLib.Variant('s', transition)]))
print(f'ok wallpaper transition announced ({new_t})')

# The window style written by ANOTHER process (gsettings, as Settings does): announced, and
# Hyalo told the level and the kit's table (AppearanceSync → `[windows.background]`).
def hyalo_background():
    out = subprocess.run(['nidara-hyalo', 'msg', 'config'], check=True, capture_output=True, text=True).stdout
    return json.loads(out)['ok']['config']['windows']['background']
style_was = schema['appearance.windowBackground']['value']
style = 'translucent' if style_was != 'translucent' else 'tinted'
subprocess.run(['gsettings', 'set', 'org.nidara.appearance', 'window-background', style], check=True)
wait_for('appearance.windowBackground', style, 'a window style written by another process')
deadline = GLib.get_monotonic_time() + 5_000_000
while hyalo_background()['level'] != style and GLib.get_monotonic_time() < deadline:
    GLib.usleep(50_000)
told = hyalo_background()
if told['level'] != style:
    sys.exit(f'FAIL: the window style {style} never reached Hyalo: {told}')
if not (0 < told['translucent']['opacity'] < told['tinted']['opacity'] < 1):
    sys.exit(f'FAIL: Hyalo was not told the kit\'s levels (translucent below tinted, both below 1): {told}')
subprocess.run(['gsettings', 'set', 'org.nidara.appearance', 'window-background', style_was], check=True)
print(f'ok window style from another process announced and carried into Hyalo ({style}: {told[style]})')

fails_with('Error.Invalid', 'Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', 'no-such-colour')]),
           'an invalid value')
print('ok invalid value refused')

# ── The sync protocol (PHASE1.md [A3]): Snapshot, Apply, Updated ──────────────
updates = []
proxy.connect('g-signal', lambda _p, _s, name, params:
              name == 'Updated' and updates.append(params.unpack()))
epoch, rev0, snap = call('Snapshot').unpack()
snap = json.loads(snap)
if not (epoch > 0 and snap.get('schemaVersion') == 1 and 'available' in snap['keys'].get('appearance.darkMode', {})):
    sys.exit(f'FAIL: Snapshot: epoch {epoch}, version {snap.get("schemaVersion")}, no `available`')
cat = snap['keys'].get('wallpaper.current', {}).get('catalogue', [])
if not cat:
    sys.exit('FAIL: Snapshot: wallpaper.current has no catalogue of bundled wallpapers')
print(f'ok snapshot: epoch {epoch}, revision {rev0}, {len(snap["keys"])} keys, {len(cat)} bundled wallpapers')

def apply(key, value):
    return call('Apply', GLib.Variant('(sv)', [key, value])).unpack()

def wait_updated(revision, key, what):
    loop = GLib.MainLoop()
    deadline = GLib.get_monotonic_time() + 5_000_000
    hit = lambda: any(e == epoch and r == revision and key in v for e, r, v in updates)
    GLib.timeout_add(20, lambda: (loop.quit(), False)[1] if hit() or GLib.get_monotonic_time() > deadline else True)
    loop.run()
    if not hit():
        sys.exit(f'FAIL: {what}: no Updated({epoch}, {revision}) with {key} (got {updates})')

temp0 = snap['keys']['nightlight.temperature']['value']
target = 4321.6 if round(temp0) != 4322 else 4111.4
rev, canon = apply('nightlight.temperature', GLib.Variant('d', target))
if canon != round(target) or rev <= rev0:
    sys.exit(f'FAIL: Apply: {target} answered {canon} at revision {rev} (snapshot {rev0})')
wait_updated(rev, 'nightlight.temperature', 'Apply of the temperature')
seen = len(updates)
rev_same, canon_same = apply('nightlight.temperature', GLib.Variant('d', float(round(target))))
settle = GLib.MainLoop()
GLib.timeout_add(500, lambda: (settle.quit(), False)[1])
settle.run()
if rev_same != rev or canon_same != round(target) or len(updates) != seen:
    sys.exit(f'FAIL: a no-op Apply moved the revision ({rev} → {rev_same}) or announced something')
apply('nightlight.temperature', GLib.Variant('d', float(temp0)))
print(f'ok apply: {target} → canonical {canon} at revision {rev}; a no-op answers it unchanged, silently')

# ── The keys Appearance's own controls change (PHASE1.md [A2]) ──────────────────
for key, raw in [('wallpaper.current', '/no/such/image.jpg'), ('wallpaper.current', '/etc/hostname'),
                 ('nightlight.scheduleFrom', '25:00'), ('appearance.interfaceFont', 'NoSuchFamily 12'),
                 ('appearance.interfaceFont', 'Inter')]:
    fails_with('Error.Invalid', 'Apply', GLib.Variant('(sv)', [key, GLib.Variant('s', raw)]), f'{key} = {raw!r}')
was_from = snap['keys']['nightlight.scheduleFrom']['value']
new_from = '21:30' if was_from != '21:30' else '22:15'
rev, canon = apply('nightlight.scheduleFrom', GLib.Variant('s', f' {new_from} '))
if canon != new_from:
    sys.exit(f'FAIL: scheduleFrom answered {canon!r}')
wait_updated(rev, 'nightlight.scheduleFrom', 'Apply of the schedule')
apply('nightlight.scheduleFrom', GLib.Variant('s', was_from))
font0 = snap['keys']['appearance.interfaceFont']['value']
new_font = 'Inter 13' if font0.strip() == 'Inter 12' else 'Inter 12'
rev, canon = apply('appearance.interfaceFont', GLib.Variant('s', new_font))
wait_updated(rev, 'appearance.interfaceFont', 'Apply of the interface font')
apply('appearance.interfaceFont', GLib.Variant('s', font0))
print('ok appearance keys: wallpaper/schedule/font validated, schedule and font applied and announced')

# ── A catalogue installed meanwhile is current (enum re-read, [A6]) ───────────
theme_dir = os.path.expanduser('~/.local/share/themes/NidaraCiTheme/gtk-4.0')
os.makedirs(theme_dir, exist_ok=True)
try:
    values = json.loads(call('Snapshot').unpack()[2])['keys']['appearance.gtkTheme']['values']
    if 'NidaraCiTheme' not in values:
        sys.exit(f'FAIL: a GTK theme installed after the shell started is not offered ({values})')
finally:
    shutil.rmtree(os.path.expanduser('~/.local/share/themes/NidaraCiTheme'), ignore_errors=True)
print('ok enum re-read: a theme installed meanwhile is offered')

# ── The native Settings' path: the owner of org.nidara.SettingsNative ────────────
native = Gio.DBusConnection.new_for_address_sync(
    Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None),
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
owned = native.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
                         GLib.Variant('(su)', ['org.nidara.SettingsNative', 4]), None, Gio.DBusCallFlags.NONE, 5000, None)
if owned.unpack()[0] != 1:
    sys.exit(f'FAIL: could not own org.nidara.SettingsNative ({owned.unpack()})')
native_proxy = Gio.DBusProxy.new_sync(native, Gio.DBusProxyFlags.NONE, None,
                                      'org.nidara.Config', '/org/nidara/Config', 'org.nidara.Config1')
GLib.usleep(300_000)

subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-config-write', 'false'], check=True)
try:
    GLib.usleep(500_000)
    fails_with('Error.Denied', 'Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', accent)]),
               'a write with Settings → AI config writes off')
    print('ok denied while agent config writes are off')
    # The same write from the native Settings' connection is its own path, not an agent's.
    native_proxy.call_sync('Apply', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', other)]),
                           Gio.DBusCallFlags.NONE, 5000, None)
    print('ok the owner of org.nidara.SettingsNative writes with agent writes off')
finally:
    subprocess.run(['gsettings', 'reset', 'org.nidara.ai', 'allow-config-write'], check=True)
    GLib.usleep(500_000)
    call('Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', accent)]))
print('CONFIG SERVICE OK')
