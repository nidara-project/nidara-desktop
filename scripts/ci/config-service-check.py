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
Restores everything it changed.
"""
import json, subprocess, sys
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

fails_with('Error.Invalid', 'Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', 'no-such-colour')]),
           'an invalid value')
print('ok invalid value refused')

subprocess.run(['gsettings', 'set', 'org.nidara.ai', 'allow-config-write', 'false'], check=True)
try:
    GLib.usleep(500_000)
    fails_with('Error.Denied', 'Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', accent)]),
               'a write with Settings → AI config writes off')
    print('ok denied while agent config writes are off')
finally:
    subprocess.run(['gsettings', 'reset', 'org.nidara.ai', 'allow-config-write'], check=True)
    GLib.usleep(500_000)
    call('Set', GLib.Variant('(sv)', ['appearance.accent', GLib.Variant('s', accent)]))
print('CONFIG SERVICE OK')
