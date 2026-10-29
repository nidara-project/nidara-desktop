#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Production clients, real private Display1 and AT-SPI. One nested output proves
client transport/rollback/focus, never physical multi-monitor or DDC acceptance."""
import hashlib, json, os, struct, subprocess, time, zlib
from pathlib import Path
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
RUN=Path(os.environ['DISPLAY_SETTINGS_RUN']).resolve()
OUT=Path(os.environ['DISPLAY_SETTINGS_OUT']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve()!=RUN/'runtime/nr':
    raise SystemExit('private rust-session runtime required')
(OUT/'environment.json').write_text(json.dumps({key:{'path':os.environ[key],'sha256':hashlib.sha256(Path(os.environ[key]).read_bytes()).hexdigest()} for key in ['HYALO_BIN','NK_SETTINGS_BIN','DISPLAY_SELECTOR_BIN','SESSIOND_BIN']},indent=2))
log=(OUT/'check.log').open('w',buffering=1)
def report(message): print(message,file=log)
def wait(test,label,seconds=20):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)
        result=test()
        if result:return result
        time.sleep(.02)
    raise AssertionError('timeout: '+label)
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def call(name,path,interface,method,args=None):
    return bus.call_sync(name,path,interface,method,args,None,Gio.DBusCallFlags.NONE,10000,None).unpack()
def display(): return call('org.nidara.Display','/org/nidara/Display','org.nidara.Display1','GetState')
def msg(*args):return json.loads(subprocess.check_output([os.environ['HYALO_BIN'],'msg',*map(str,args)],timeout=10))['ok']
def control(line):
    with open(os.environ['HYALO_CONTROL'],'w') as stream:stream.write(line+'\n')
def chord():control('keydown 125\nkey 25\nkeyup 125')
# The fixture is on this newly created private session bus, not a second production
# appearance channel. Production clients continue to read the Settings portal only.
assert not call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',('org.freedesktop.portal.Desktop',)))[0]
xml='<node><interface name="org.freedesktop.portal.Settings"><method name="ReadAll"><arg type="as" direction="in"/><arg type="a{sa{sv}}" direction="out"/></method><signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal></interface></node>'
def portal(connection,sender,path,interface,method,params,invocation):
    invocation.return_value(GLib.Variant('(a{sa{sv}})',({
        'org.freedesktop.appearance':{'accent-color':GLib.Variant('(ddd)',(0.,136/255,1.)),'color-scheme':GLib.Variant('u',1),'reduced-motion':GLib.Variant('u',1)},
        'org.nidara.appearance':{'reduce-transparency':GLib.Variant('b',False),'window-background':GLib.Variant('s','opaque')},
        'org.gnome.desktop.interface':{'font-name':GLib.Variant('s','Inter Variable 11'),'text-scaling-factor':GLib.Variant('d',1.)}},)))
bus.register_object('/org/freedesktop/portal/desktop',Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0],portal,None,None)
call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.freedesktop.portal.Desktop',4)))

address=call('org.a11y.Bus','/org/a11y/bus','org.a11y.Bus','GetAddress')[0]
os.environ['AT_SPI_BUS_ADDRESS']=address
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
def children(node):
    node.clear_cache();return [node.get_child_at_index(i) for i in range(node.get_child_count())]
def walk(node):
    result=[node]
    for child in children(node):
        if child:result.extend(walk(child))
    return result
def root(name):
    app=next((a for a in children(Atspi.get_desktop(0)) if a.get_name()==name),None)
    if app:app.set_cache_mask(Atspi.Cache.NONE)
    return app
def nodes(name):
    app=root(name)
    return walk(app) if app else []
def node(name,label,role=None):return next((n for n in nodes(name) if n.get_name()==label and (role is None or n.get_role()==role)),None)
def value_node(name,label):return node(name,label,Atspi.Role.SPIN_BUTTON)
def activate(name,label):
    def available():
        item=node(name,label,Atspi.Role.PUSH_BUTTON)
        return item if item and item.get_state_set().contains(Atspi.StateType.ENABLED) else None
    item=wait(available,label+' enabled')
    assert item.get_action_iface().do_action(0),label+' action refused'
def pending():return display()[5][0]
def screenshot(stem):
    path=OUT/(stem+'.ppm');msg('screenshot',path)
    magic,dims,depth,pixels=path.read_bytes().split(b'\n',3)
    assert magic==b'P6' and depth==b'255'
    width,height=map(int,dims.split())
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    scan=b''.join(b'\0'+pixels[i*width*3:(i+1)*width*3] for i in range(height))
    path.with_suffix('.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(scan))+chunk(b'IEND',b''))
process=None
try:
    baseline=wait(lambda:display(),'Display1')
    original=baseline[4]
    with (OUT/'settings.log').open('w') as stream:
        process=subprocess.Popen([os.environ['NK_SETTINGS_BIN'],'page','appearance' if os.environ.get('DISPLAY_SETTINGS_BASELINE')=='appearance' else 'display'],stdout=stream,stderr=stream)
    wait(lambda:'CONTENT_READY' in (OUT/'settings.log').read_text(),'native display commit')
    if os.environ.get('DISPLAY_SETTINGS_BASELINE')=='appearance':
        screenshot('appearance-baseline')
        report('ok: D7 Appearance baseline capture only; no Display acceptance')
        raise SystemExit(0)
    appname='Settings'
    wait(lambda:node(appname,'Apply display changes'),'display controls')
    assert display()[4]==original and not pending(),'opening wrote output state'
    screenshot('display-initial')
    selected=[n for n in nodes(appname) if n.get_name().startswith('1 ·') and n.get_state_set().contains(Atspi.StateType.SELECTED)]
    assert selected,'output selection missing from semantics'
    scale=wait(lambda:value_node(appname,'Scale'),'scale control')
    assert scale.get_value_iface().set_current_value(0.75)
    wait(lambda:(n:=value_node(appname,'Scale')) and abs(n.get_value_iface().get_current_value()-0.75)<.001,'draft scale')
    assert display()[4]==original and not pending(),'editing a draft wrote hardware'
    activate(appname,'Apply display changes');wait(pending,'preview')
    wait(lambda:any('Reverting to the previous setting in ' in n.get_name() for n in nodes(appname)),'accessible countdown')
    deadline=display()[5][2]
    wait(lambda:f'deadline={deadline}' in (OUT/'settings.log').read_text(),'confirmation root frame callback')
    screenshot('display-confirmation')
    activate(appname,'Revert');wait(lambda:not pending(),'cancelled preview')
    assert display()[4]==original,'cancel did not restore layout'
    scale=wait(lambda:value_node(appname,'Scale'),'scale after cancel');assert scale.get_value_iface().set_current_value(0.75)
    activate(appname,'Apply display changes');wait(pending,'second preview')
    activate(appname,'Keep changes');wait(lambda:not pending(),'confirmed preview')
    confirmed=display()[4];assert confirmed!=original,'confirmation did not keep draft'
    screenshot('display-page')
    # Navigate away while a lease belongs to the page. This is the production
    # unmount path, not merely SIGTERM/process loss.
    scale=wait(lambda:value_node(appname,'Scale'),'scale before unmount');assert scale.get_value_iface().set_current_value(0.5)
    activate(appname,'Apply display changes');wait(pending,'preview before unmount')
    call('org.nidara.SettingsNative','/org/nidara/Settings','org.nidara.Settings','Request',GLib.Variant('(as)',(['page','appearance'],)))
    wait(lambda:not pending(),'unmount rollback');assert display()[4]==confirmed
    report('ok: actual page, retained accessible selection, draft/no write, preview/countdown, cancel, confirm and unmount rollback')
    chord();selector=wait(lambda:next((w for w in msg('windows')['windows'] if w['app_id']=='nidara-display-selector'),None),'Super+P selector')
    wait(lambda:node('Display','External only'),'selector semantics')
    duplicate=node('Display','Duplicate',Atspi.Role.LIST_ITEM);assert duplicate and not duplicate.get_state_set().contains(Atspi.StateType.ENABLED),'unsupported mirror was enabled'
    assert display()[4]==confirmed and not pending(),'opening selector mutated outputs'
    native=next(w for w in msg('windows')['windows'] if w['pid']==process.pid)
    msg('do',f"focus-window {native['id']}");chord()
    wait(lambda:next((w for w in msg('windows')['windows'] if w['id']==selector['id'] and w['focused']),None),'repeat shortcut focus')
    assert len([w for w in msg('windows')['windows'] if w['app_id']=='nidara-display-selector'])==1
    screenshot('selector')
    control('key 108\nkey 28');wait(pending,'selector keyboard preview')
    control('key 1');wait(lambda:not pending(),'Escape rollback')
    assert display()[4]==confirmed
    wait(lambda:not any(w['app_id']=='nidara-display-selector' for w in msg('windows')['windows']),'selector close')
    report('ok: actual Super+P binding, app-id, accessible choices, unsupported mode refusal, repeated activation, Escape rollback')
    (OUT/'result.json').write_text(json.dumps({'passed':True,'scope':'private rust-session/winit/AT-SPI; no hardware/Orca/installation acceptance'},indent=2))
finally:
    if process and process.poll() is None:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
    try:msg('quit')
    except Exception:pass
    log.close()
