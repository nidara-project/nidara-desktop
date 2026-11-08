#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""B3.1 real-wire/AT-SPI/pointer exercise, inside check-notifications-headless.sh.
Each oracle is checked against a contradictory observation as a failure control.
No test-only behavior is compiled into the shell or daemon.
"""
import json
import os
from pathlib import Path
import subprocess
import signal
import time
import gi
gi.require_version('Atspi', '2.0')
gi.require_version('GdkPixbuf','2.0')
from gi.repository import Atspi, Gio, GLib, GdkPixbuf
LOG = Path(os.environ['NK_WIDGETS_LOG']).resolve()
RUN = Path(os.environ['NK_WIDGETS_RUN']).resolve()
REPO = Path(__file__).resolve().parents[2]
assert Path(os.environ['XDG_RUNTIME_DIR']).resolve() == RUN / 'runtime'
BUS = Gio.bus_get_sync(Gio.BusType.SESSION, None)
PROCS = []
EXTRA = []
REPORT = {}
EVENTS = []
ANNOUNCEMENTS = []
RAW_NOTIFIED = {}

def pump(seconds=0):
    end = time.monotonic() + seconds
    while True:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        if time.monotonic() >= end: break
        time.sleep(.02)

def until(label, read, timeout=15):
    end = time.monotonic() + timeout
    while True:
        try:
            value = read()
            if value: return value
        except (GLib.Error, StopIteration, KeyError): pass
        if time.monotonic() >= end: raise AssertionError('timeout: ' + label)
        pump(.05)

def call(dest, path, iface, method, args=None, bus=BUS):
    return bus.call_sync(dest, path, iface, method, args, None, Gio.DBusCallFlags.NONE if dest=='org.a11y.Bus' else Gio.DBusCallFlags.NO_AUTO_START, 3000, None).unpack()

def private(method, args=None):
    return call('org.freedesktop.Notifications', '/org/nidara/Notifications', 'org.nidara.Notifications1', method, args)

def state():
    return json.loads(call('org.nidara.Shell', '/org/nidara/Shell', 'org.nidara.Shell1', 'GetNotificationState')[0])

def banners(): return state()['banners']
def history(): return json.loads(private('List')[0])
def ids(rows): return [r['id'] for r in rows]

def oracle(label, predicate, good, bad):
    assert predicate(good), (label, good)
    try: assert predicate(bad)
    except AssertionError: REPORT[label] = {'pass': True, 'negative_control_caught': True}
    else: raise AssertionError('ineffective failure control: ' + label)
    print('PASS + control:', label, flush=True)

def notify(summary, timeout=0, critical=False, replace=0, actions=(), hints=None):
    h = {'urgency': GLib.Variant('y', 2 if critical else 1), 'desktop-entry': GLib.Variant('s','nidara-notification-fixture')}
    h.update(hints or {})
    return call('org.freedesktop.Notifications','/org/freedesktop/Notifications','org.freedesktop.Notifications','Notify',
                GLib.Variant('(susssasa{sv}i)', ('B3 fixture', replace, 'dialog-information', summary,
                    'Body with a long final line, 日本語 and combining é. ' * 5, list(actions), h, timeout)))[0]

def clear():
    for n in history(): private('Dismiss', GLib.Variant('(u)',(n['id'],)))
    until('empty stack', lambda: not banners())

def start(name, argv, **env):
    p = subprocess.Popen(argv, stdout=(LOG / (name+'.log')).open('w'), stderr=subprocess.STDOUT, env={**os.environ, **env})
    PROCS.append(p)
    return p

def msg(*args):
    return json.loads(subprocess.check_output([os.environ['HYALO_BIN'],'msg',*map(str,args)], text=True,timeout=8))

def children(n):
    n.clear_cache()
    return [c for i in range(n.get_child_count()) if (c:=n.get_child_at_index(i))]

def bar():
    for app in children(Atspi.get_desktop(0)):
        app.set_cache_mask(Atspi.Cache.NONE)
        for n in children(app):
            if n.get_name() == 'Bar': return n

def notices():
    root = bar()
    return [] if not root else [n for n in children(root) if n.get_role() in (Atspi.Role.NOTIFICATION, Atspi.Role.ALERT)]

def node(summary):
    return next(n for n in notices() if summary in n.get_name())

def box(n):
    r=n.get_component_iface().get_extents(Atspi.CoordType.WINDOW)
    return [r.x,r.y,r.width,r.height]

def move(x,y):
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe: pipe.write(f'move {x} {y}\nmove {x+1} {y}\n')
    pump(.2)

def click(x,y):
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe: pipe.write(f'click {x} {y}\n')
    pump(.2)

def settings(schema,key,value):
    subprocess.run(['gsettings','set',schema,key,value],check=True,timeout=5)
    pump(.25)

def setup(initial_records=None):
    schemas=RUN/'schemas'; schemas.mkdir()
    for f in [*Path('/usr/share/glib-2.0/schemas').glob('*.gschema.xml'), *Path('/usr/share/glib-2.0/schemas').glob('*.enums.xml')]:
        if f.name!='org.nidara.gschema.xml': (schemas/f.name).symlink_to(f)
    (schemas/'org.nidara.gschema.xml').symlink_to(REPO/'config/gsettings/org.nidara.gschema.xml')
    subprocess.run(['glib-compile-schemas',str(schemas)],check=True)
    os.environ['GSETTINGS_SCHEMA_DIR']=str(schemas)
    address=call('org.a11y.Bus','/org/a11y/bus','org.a11y.Bus','GetAddress')[0]
    os.environ['AT_SPI_BUS_ADDRESS']=address
    registry=next(p for p in [Path('/usr/lib/at-spi2-registryd'),Path('/usr/libexec/at-spi2-registryd')] if p.exists())
    start('registry',[str(registry)])
    call('org.a11y.Bus','/org/a11y/bus','org.freedesktop.DBus.Properties','Set',GLib.Variant('(ssv)',('org.a11y.Status','IsEnabled',GLib.Variant('b',True))))
    data=RUN/'apps'; (data/'applications').mkdir(parents=True)
    (data/'applications/nidara-notification-fixture.desktop').write_text('[Desktop Entry]\nType=Application\nName=B3 fixture\nExec=/usr/bin/true\nIcon=org.gnome.Nautilus\n')
    (data/'icons').symlink_to('/usr/share/icons'); (data/'pixmaps').symlink_to('/usr/share/pixmaps')
    settings('org.nidara.ai','allow-computer-control','true')
    if initial_records is not None:
        cache=Path(os.environ['XDG_CACHE_HOME'])/'nidara/notifd';cache.mkdir(parents=True,exist_ok=True)
        (cache/'state.json').write_text(json.dumps({'version':1,'notifications':initial_records}))
    daemon=start('sessiond',[os.environ['NK_SESSIOND_BIN'],'--config','--applications'],XDG_DATA_DIRS=str(data))
    until('daemon',lambda: len(history()) == len(initial_records or []))
    owner_rule="type='method_call',interface='org.freedesktop.DBus',member='GetNameOwner',arg0='org.freedesktop.Notifications'"
    start('owner-monitor',['stdbuf','-oL','dbus-monitor','--session',owner_rule])
    until('owner monitor registered',lambda:'NameAcquired' in (LOG/'owner-monitor.log').read_text())
    renderer=start('shell',[os.environ['NK_DOCK_BIN'],'--bar'],NK_ICON_METRICS='1')
    until('banner source ready',lambda:state()['available'])
    until('bar accessibility',bar)
    until('bar geometry configured',lambda:(b:=bar()) and box(b)[2]>0)
    return daemon,renderer,data
