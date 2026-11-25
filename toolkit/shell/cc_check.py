#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private B2.2 controls exercised through real AT-SPI and the Network1 wire API."""
import json
import os
from pathlib import Path
import subprocess
import time

NETWORK = r'''
import json,os,sys
import gi
gi.require_version('Gio','2.0')
from gi.repository import Gio,GLib
root=__import__('pathlib').Path(sys.argv[1])
log=__import__('pathlib').Path(os.environ['NK_WIDGETS_LOG'])/'cc-network-actions'
password='privatepassword'
def args(*types,direction='in'):
    return ''.join('<arg type="'+t+'" direction="'+direction+'"/>' for t in types)
methods={'Snapshot':('',args('t','t','s',direction='out')),'SetWifiEnabled':(args('b'),''),'Scan':(args('o'),''),
'ConnectDefault':(args('o','o','s'),args('o',direction='out')),'Disconnect':(args('o'),''),'Activate':(args('s','o'),args('o',direction='out')),
'RegisterSecretsUi':('',''),'SubmitSecrets':(args('t','a{sa{sv}}'),''),'CancelSecrets':(args('t'),'')}
xml='<node><interface name="org.nidara.Network1">'+''.join('<method name="'+k+'">'+a+b+'</method>' for k,(a,b) in methods.items())+('<signal name="Updated">'+args('t','t','s',direction='out')+'</signal><signal name="SecretsRequested">'+args('t','s',direction='out')+'</signal><signal name="SecretsClosed">'+args('t','s',direction='out')+'</signal></interface></node>')
state={'revision':1,'strength':90,'enabled':True,'active':'/ap/1','ui':None,'pending':None,'id':0}
def doc():
    return json.dumps({'schemaVersion':1,'wirelessEnabled':state['enabled'],'wirelessHardwareEnabled':True,'profiles':[],
        'devices':[{'path':'/device/wifi','kind':2,'state':100 if state['active']!='/' else 30,'activeAp':state['active'],
          'accessPoints':[{'path':'/ap/1','ssid':[72,111,109,101],'label':'Home','strength':state['strength']},
                          {'path':'/ap/secure','ssid':[83,101,99,117,114,101],'label':'Secure test','strength':60,'flags':1,'wpaFlags':256,'rsnFlags':256}]}]})
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def updated():
    state['revision']+=1
    bus.emit_signal(None,'/org/nidara/Network','org.nidara.Network1','Updated',GLib.Variant('(tts)',(1,state['revision'],doc())))
def closed(ident):
    bus.emit_signal(state['ui'],'/org/nidara/Network','org.nidara.Network1','SecretsClosed',GLib.Variant('(ts)',(ident,'answered')))
def record(method,data):
    with log.open('a') as f:f.write(json.dumps([method,data])+'\n')
def answer(conn,sender,path,iface,method,params,inv):
    p=params.unpack()
    if method=='Snapshot':inv.return_value(GLib.Variant('(tts)',(1,state['revision'],doc())));return
    if method=='RegisterSecretsUi':
        state['ui']=sender;record(method,[]);inv.return_value(None);return
    if method=='ConnectDefault':
        record(method,list(p))
        if p[1]=='/ap/secure':
            state['id']+=1;state['pending']=(state['id'],inv)
            meta={'setting':'802-11-wireless-security','hints':['psk'],'name':'Secure test','profile':{'802-11-wireless-security':{'key-mgmt':'wpa-psk'}}}
            bus.emit_signal(state['ui'],path,iface,'SecretsRequested',GLib.Variant('(ts)',(state['id'],json.dumps(meta))))
        else:state['active']=p[1];updated();inv.return_value(GLib.Variant('(o)',('/activation/1',)))
        return
    if method=='SubmitSecrets':
        ident,values=p
        valid=(values.get('802-11-wireless-security',{}).get('psk')==password)
        record(method,{'id':ident,'valid':valid})
        pending=state['pending'];assert pending and ident==pending[0] and sender==state['ui']
        if not valid:inv.return_dbus_error('org.nidara.Network1.Error.Invalid','incorrect test value');return
        state['active']='/ap/secure';state['pending']=None;closed(ident);updated();pending[1].return_value(GLib.Variant('(o)',('/activation/2',)));inv.return_value(None);return
    if method=='CancelSecrets':
        record(method,list(p));pending=state['pending']
        if pending and pending[0]==p[0]:pending[1].return_dbus_error('org.nidara.Network1.Error.Cancelled','cancelled');state['pending']=None;closed(p[0])
        inv.return_value(None);return
    record(method,list(p))
    if method=='SetWifiEnabled':state['enabled']=p[0]
    if method=='Disconnect':state['active']='/'
    updated();inv.return_value(None)
bus.register_object('/org/nidara/Network',Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0],answer,None,None)
def poll():
    try:strength=int(root.read_text())
    except (OSError,ValueError):strength=90
    if strength!=state['strength']:state['strength']=strength;updated()
    return True
GLib.timeout_add(200,poll)
Gio.bus_own_name_on_connection(bus,'org.nidara.Network',0,None,None)
GLib.MainLoop().run()
'''


def network_actions(evidence_dir):
    log = evidence_dir / 'cc-network-actions'
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def prompt_nodes(ctx, title):
    root = ctx['dock_node'](title)
    if root is None:
        return []
    def descend(node):
        yield node
        for child in ctx['children'](node):
            yield from descend(child)
    return list(descend(root))
def prompt_button(ctx, title, name):
    return next((n for n in prompt_nodes(ctx, title) if n.get_name() == name
                 and n.get_role_name() == 'button'), None)
def respond_wifi(ctx, pipe):
    from gi.repository import Atspi
    until = ctx['until']
    title = 'Wi-Fi authentication'
    until('Wi-Fi dialog has keyboard focus',
          lambda: (dialog := ctx['dock_node'](title)) and
          dialog.get_state_set().contains(Atspi.StateType.ACTIVE))
    password = until('focused native password question',
        lambda: next((n for n in prompt_nodes(ctx, title)
                      if n.get_role_name() == 'password text'
                      and n.get_state_set().contains(Atspi.StateType.FOCUSED)), None))
    assert password.get_text_iface() is None or password.get_text_iface().get_text(0, -1) == ''
    # Linux evdev codes for the fixture credential "privatepassword".
    for code in [25, 19, 23, 47, 30, 20, 18, 25, 30, 31, 31, 17, 24, 19, 32]:
        pipe.write(f'key {code}\n')
        time.sleep(.02)
    until('password enables Connect',
        lambda: (n := prompt_button(ctx, title, 'Connect')) and
                n.get_state_set().contains(Atspi.StateType.ENABLED) and n)
    assert password.get_text_iface() is None or password.get_text_iface().get_text(0, -1) == ''
    pipe.write('key 28\n')
    until('question withdrawn',lambda:ctx['dock_node'](title) is None)


def run_prompts(ctx):
    from gi.repository import Atspi
    until, run_dir, log = ctx['until'], ctx['RUN'], ctx['LOG']
    signal = run_dir / 'wifi-strength'
    signal.write_text('90')
    bt_actions = log / 'bluetooth-actions.jsonl'
    network_args = ['python3', '-I', '-c', NETWORK, str(signal)]
    network = ctx['start']('network', network_args)
    ctx['start']('bluetooth', ['python3','-I','-c',BLUETOOTH,str(bt_actions)])
    def actions():
        return network_actions(log)
    until('Wi-Fi renderer registered', lambda: any(m == 'RegisterSecretsUi' for m, _ in actions()))
    with open(os.environ['HYALO_CONTROL'], 'w', buffering=1) as pipe:
        # Network1's issuer is independent of the control-center panel.
        before = sum(1 for method, _ in actions() if method == 'SubmitSecrets')
        connect = ['busctl', '--user', 'call', 'org.nidara.Network',
            '/org/nidara/Network', 'org.nidara.Network1', 'ConnectDefault',
            'oos', '/device/wifi', '/ap/secure', '']
        caller = ctx['start']('external-wifi', connect)
        # While Wi-Fi is active, Bluetooth queues on the same surface.
        until('Bluetooth renderer registered', lambda: bt_actions.exists() and 'RegisterUi' in bt_actions.read_text())
        until('external Wi-Fi dialog', lambda: ctx['dock_node']('Wi-Fi authentication'))
        trigger = bt_actions.with_name('bluetooth-prompt')
        trigger.write_text('file')
        until('queued Bluetooth request signalled', lambda: not trigger.exists())
        assert ctx['dock_node']('Bluetooth') is None
        respond_wifi(ctx, pipe)
        until('external connection answered', lambda: caller.poll() == 0)
        assert sum(1 for method, _ in actions() if method == 'SubmitSecrets') == before + 1
        assert sum(1 for method, _ in actions() if method == 'RegisterSecretsUi') == 1

        until('incoming file name', lambda: any(n.get_name() == 'fixture.txt' for n in prompt_nodes(ctx, 'Bluetooth')))
        assert any(n.get_name() == 'Unknown file size' for n in prompt_nodes(ctx, 'Bluetooth'))
        time.sleep(1.5)
        ctx['shot'](log / 'bluetooth-file-consent.png')
        assert until('file accept button', lambda: prompt_button(ctx, 'Bluetooth', 'Accept file')).get_action_iface().do_action(0)
        until('Bluetooth replied to current epoch and ID', lambda: ['ReplyRequest', [7, 12, True, '']] in
              [json.loads(line) for line in bt_actions.read_text().splitlines()])
        until('incoming file prompt withdrawn', lambda: ctx['dock_node']('Bluetooth') is None)
        trigger.write_text('display')
        until('Bluetooth displayed passkey', lambda: any(n.get_name() == '000042' for n in prompt_nodes(ctx, 'Bluetooth')))
        until('Bluetooth updated passkey progress', lambda: any('3 of 6' in n.get_name() for n in prompt_nodes(ctx, 'Bluetooth')))
        assert until('display cancel button', lambda: prompt_button(ctx, 'Bluetooth', 'Cancel')).get_action_iface().do_action(0)
        until('Bluetooth cancelled display at the service', lambda: ['CancelRequest', [7, 13]] in
              [json.loads(line) for line in bt_actions.read_text().splitlines()])
        until('display withdrawn', lambda: ctx['dock_node']('Bluetooth') is None)
        # Owner loss must withdraw a live form, and the shell must register
        # with the replacement without opening a bar detail.
        title = 'Wi-Fi authentication'
        caller = ctx['start']('wifi-before-replacement', connect)
        until('prompt before owner loss', lambda: ctx['dock_node'](title))
        network.terminate()
        network.wait(timeout=5)
        until('Wi-Fi dialog withdrawn on owner loss', lambda: ctx['dock_node'](title) is None)
        until('request failed with its old owner', lambda: (code := caller.poll()) is not None and code != 0)
        ctx['start']('network-replacement', network_args)
        until('Wi-Fi renderer registered with the replacement', lambda:
              sum(1 for method, _ in actions() if method == 'RegisterSecretsUi') == 2)
        caller = ctx['start']('wifi-after-replacement', connect)
        until('keyboard focus on the replacement prompt',
              lambda: (dialog := ctx['dock_node'](title)) and
              dialog.get_state_set().contains(Atspi.StateType.ACTIVE))
        pipe.write('key 1\n')
        until('Cancel reached the replacement', lambda: ['CancelSecrets', [1]] in actions())
        until('replacement dialog withdrawn', lambda: ctx['dock_node'](title) is None)
    assert 'privatepassword' not in (log/'shell.log').read_text()
    print('PASS session prompts: Wi-Fi outside CC, masked password, queued Bluetooth consent, passkey updates and owner replacement', flush=True)


def run(ctx):
    from gi.repository import Atspi
    until, log, run_dir = ctx['until'], ctx['LOG'], ctx['RUN']
    def tiles():
        if ctx['shell'].poll() is not None:raise RuntimeError('shell exited')
        if ctx['dock_node']('Bar') is None:return {}
        return ctx['cc_tiles']()
    pipe = ctx['pipe']
    ctx['start']('bluetooth', ['python3','-I','-c',BLUETOOTH,str(log/'bluetooth-actions.jsonl')])
    for suffix in ['A','B']:
        ctx['start']('media-'+suffix,['python3','-I','-c',MPRIS,'org.mpris.MediaPlayer2.nidaraCC'+suffix,'Fixture player '+suffix,str(log/('media-'+suffix+'-actions.jsonl'))])
    def names():return sorted(tiles())
    def node(name):return tiles().get(name)
    def click(name):
        n=until('control '+name,lambda:node(name))
        assert n.get_action_iface().do_action(0),name
    def actions():
        return network_actions(log)
    def back():
        click(next(name for name in names() if name=='Back' or name.endswith(' · Back')));until('grid restored',lambda:'Screenshot' in tiles())
    def open_detail(entry, marker):
        def ready():
            if marker in tiles():return True
            if 'Screenshot' in tiles():click(entry)
            return False
        until('detail '+entry,ready)
    until('secrets renderer registered before opening the Wi-Fi detail',lambda:any(m=='RegisterSecretsUi' for m,_ in actions()))
    open_detail('Wi-Fi','Secure test')
    assert any('Home' in name for name in names()),names()
    time.sleep(1.5);ctx['shot'](log/'cc-wifi.png')
    click('Scan')
    until('scan reaches Network1',lambda:any(m=='Scan' for m,_ in actions()))
    click('Secure test')
    respond_wifi(ctx, pipe)
    until('credential submitted without a blocked Connect lane',lambda:any(m=='SubmitSecrets' and p['valid'] for m,p in actions()))
    assert 'privatepassword' not in (log/'shell.log').read_text()
    time.sleep(1.5);ctx['shot'](log/'cc-wifi-connected.png')
    back()
    bt_entry=until('Bluetooth detail entry',lambda:next((name for name in names() if name.startswith('Bluetooth · ')),None))
    click(bt_entry);click('Test headphones')
    bt_actions=log/'bluetooth-actions.jsonl'
    until('Bluetooth connect',lambda:bt_actions.exists() and 'Connect' in bt_actions.read_text())
    until('Bluetooth connected state',lambda:node('Test headphones').get_state_set().contains(Atspi.StateType.CHECKED))
    click('Test headphones')
    until('Bluetooth disconnect',lambda:'Disconnect' in bt_actions.read_text())
    back()
    media_entry=until('Media detail entry',lambda:next((name for name in names() if name in ('Media','Fixture song') or name.startswith('Media · ')),None))
    click(media_entry);click('Fixture player B')
    def pinned():
        return subprocess.check_output(['busctl','--user','get-property','org.nidara.Session','/org/nidara/Media','org.nidara.Media1','PinnedBus'],text=True).strip()
    until('Media1 selection',lambda:'nidaraCCB' in pinned())
    until('selected player shown in the CC',lambda:node('Fixture player B').get_state_set().contains(Atspi.StateType.CHECKED))
    click('Play or pause')
    media_actions=log/'media-B-actions.jsonl'
    until('selected player transport',lambda:media_actions.exists() and 'PlayPause' in media_actions.read_text())
    if node('Playback position'):
        node('Playback position').get_value_iface().set_current_value(30.)
        until('selected track seek',lambda:'SetPosition' in media_actions.read_text())
    click('Automatic');until('automatic selection restored',lambda:pinned()=='s ""')
    back()
    # Every native detail entry opens; Back/Escape restores the grid. Toggles remain quick.
    for detail in ['Screenshot','Screen recording','Night light']:
        entry=next((name for name in names() if name.startswith(detail+' · ')),None)
        click(entry or detail)
        until('Back in '+detail,lambda:any(name=='Back' or name.endswith(' · Back') for name in names()))
        if detail=='Night light':
            slider=until('temperature slider',lambda:node('Color temperature'))
            slider.get_value_iface().set_current_value(4500.)
            until('temperature write',lambda:subprocess.check_output(['gsettings','get','org.nidara.night-light','temperature'],text=True).strip()=='4500')
        pipe.write('key 1\n')
        until('Escape returns to grid',lambda:'Screenshot' in tiles())
    video_info=None
    if os.environ.get('NK_CC_CAPTURE') == '1':
        click('Screenshot');click('Screen');click('Save')
        until('screenshot closes the CC',lambda:not tiles())
        picture=until('saved native screenshot',lambda:next((p for p in (run_dir/'Pictures').glob('*.png') if p.stat().st_size>100),None))
        (log/'native-screenshot.png').write_bytes(picture.read_bytes())
        def reopen():
            control=next(n for n in ctx['children'](ctx['dock_node']('Bar')) if n.get_name()=='Control Center')
            assert control.get_action_iface().do_action(0)
            until('CC reopened',lambda:'Screen recording' in tiles())
        reopen();click('Screen recording');click('Start recording')
        until('recording closes the CC',lambda:not tiles())
        time.sleep(2.)
        reopen();click('Screen recording')
        try:
            until('owned recorder is running',lambda:node('Stop recording'))
        except RuntimeError:
            (log/'recording-state.json').write_text(json.dumps(names(),indent=2))
            ctx['shot'](log/'recording-state.png')
            raise
        time.sleep(.5);click('Stop recording')
        until('recorder ended',lambda:node('Start recording'))
        video=until('saved native recording',lambda:next((p for p in (run_dir/'Videos').glob('*.mp4') if p.stat().st_size>100),None))
        video_info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,nb_frames','-of','json',str(video)],text=True))
        assert video_info['streams'] and int(video_info['streams'][0].get('nb_frames',0))>0,video_info
        (log/'native-recording.mp4').write_bytes(video.read_bytes())
        back()
    report={'network_actions':actions(),'credentials_readable':False,'details':['wifi','screenshot','screenrecord','night_light'],'temperature':4500,'bluetooth':[json.loads(line) for line in bt_actions.read_text().splitlines()],'media_selection':True,'screenshot':video_info is not None,'recording':video_info}
    (log/'cc-details.json').write_text(json.dumps(report,indent=2))
    print('PASS B2.2: Wi-Fi in CC, redacted password, details and Back/Escape',flush=True)

BLUETOOTH = r'''
import json,sys
from pathlib import Path
from gi.repository import Gio,GLib
log=Path(sys.argv[1]);state={'powered':True,'connected':False,'revision':1,'ui':None,'id':None}
path='/org/nidara/Bluetooth'
iface='org.nidara.Bluetooth1'
xml="""<node><interface name="org.nidara.Bluetooth1">
<method name="Snapshot"><arg type="t" direction="out"/><arg type="t" direction="out"/><arg type="s" direction="out"/></method>
<method name="SetPowered"><arg type="o"/><arg type="b"/></method><method name="Connect"><arg type="o"/></method>
<method name="Disconnect"><arg type="o"/></method><method name="RegisterUi"/>
<method name="ReplyRequest"><arg type="t"/><arg type="t"/><arg type="b"/><arg type="s"/></method>
<method name="CancelRequest"><arg type="t"/><arg type="t"/></method>
<signal name="Updated"><arg type="t"/><arg type="t"/><arg type="s"/></signal>
</interface></node>"""
def doc():return json.dumps({'schemaVersion':1,'available':True,'adapters':[{'path':'/adapter/1','powered':state['powered']}],'devices':[{'path':'/device/headphones','adapter':'/adapter/1','name':'Test headphones','alias':'Test headphones','paired':True,'connected':state['connected']}]})
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def signal(member, ident, data):
    bus.emit_signal(state['ui'],path,iface,member,GLib.Variant('(tts)',(7,ident,data)))
def call(c,s,p,i,m,args,inv):
    if m=='Snapshot':inv.return_value(GLib.Variant('(tts)',(1,state['revision'],doc())));return
    values=args.unpack()
    with log.open('a') as f:f.write(json.dumps([m,values])+'\n')
    if m=='RegisterUi':
        state['ui']=s;inv.return_value(None);return
    if m in ('ReplyRequest','CancelRequest'):
        assert s==state['ui'] and values[:2]==(7,state['id'])
        signal('RequestClosed',state['id'],'answered')
        state['id']=None;inv.return_value(None);return
    if m=='SetPowered':state['powered']=values[1]
    else:state['connected']=m=='Connect'
    state['revision']+=1;bus.emit_signal(None,p,i,'Updated',GLib.Variant('(tts)',(1,state['revision'],doc())));inv.return_value(None)
def poll():
    trigger=log.with_name('bluetooth-prompt')
    if not state['ui'] or not trigger.exists():return True
    kind=trigger.read_text();trigger.unlink()
    if kind=='file':
        state['id']=12
        signal('Request',12,json.dumps({'kind':'incoming-file','deviceName':'Test phone','name':'fixture.txt','size':None}))
    if kind=='display':
        state['id']=13
        meta={'kind':'display-passkey','deviceName':'Test keyboard','code':'000042','entered':0}
        signal('Request',13,json.dumps(meta))
        def update():
            if state['id']==13:signal('RequestUpdated',13,json.dumps({**meta,'entered':3}))
            return False
        GLib.timeout_add(500,update)
    return True
bus.register_object(path,Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0],call,None,None)
Gio.bus_own_name_on_connection(bus,'org.nidara.Bluetooth',0,None,None)
GLib.timeout_add(100,poll)
GLib.MainLoop().run()
'''

MPRIS = r'''
import json,sys
from pathlib import Path
from gi.repository import Gio,GLib
name,label,filename=sys.argv[1:];log=Path(filename);bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
xml='''+'"""'+r'''<node><interface name="org.mpris.MediaPlayer2"><property name="Identity" type="s" access="read"/><property name="DesktopEntry" type="s" access="read"/><property name="CanRaise" type="b" access="read"/></interface><interface name="org.mpris.MediaPlayer2.Player"><method name="PlayPause"/><method name="Play"/><method name="Pause"/><method name="Next"/><method name="Previous"/><method name="Seek"><arg type="x"/></method><method name="SetPosition"><arg type="o"/><arg type="x"/></method><property name="PlaybackStatus" type="s" access="read"/><property name="Rate" type="d" access="read"/><property name="Metadata" type="a{sv}" access="read"/><property name="Volume" type="d" access="read"/><property name="Position" type="x" access="read"/><property name="CanControl" type="b" access="read"/><property name="CanPlay" type="b" access="read"/><property name="CanPause" type="b" access="read"/><property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/><property name="CanSeek" type="b" access="read"/><property name="Shuffle" type="b" access="read"/><property name="LoopStatus" type="s" access="read"/><signal name="Seeked"><arg type="x"/></signal></interface></node>'''+'"""'+r'''
props={'Identity':GLib.Variant('s',label),'DesktopEntry':GLib.Variant('s','nidara-fixture'),'CanRaise':GLib.Variant('b',False),
'PlaybackStatus':GLib.Variant('s','Paused'),'Rate':GLib.Variant('d',1.),'Volume':GLib.Variant('d',.5),'Position':GLib.Variant('x',1000000),
'Metadata':GLib.Variant('a{sv}',{'xesam:title':GLib.Variant('s','Fixture song'),'xesam:artist':GLib.Variant('as',['Fixture artist']),'mpris:length':GLib.Variant('x',180000000),'mpris:trackid':GLib.Variant('o','/org/nidara/fixture/track')}),
'Shuffle':GLib.Variant('b',False),'LoopStatus':GLib.Variant('s','None')}
for key in ['CanControl','CanPlay','CanPause','CanGoNext','CanGoPrevious','CanSeek']:props[key]=GLib.Variant('b',True)
def call(c,s,p,i,m,args,inv):
    with log.open('a') as f:f.write(json.dumps([m,args.unpack()])+'\n')
    if m=='SetPosition':props['Position']=GLib.Variant('x',args.unpack()[1]);bus.emit_signal(None,p,i,'Seeked',GLib.Variant('(x)',(args.unpack()[1],)))
    if m in ['PlayPause','Play','Pause']:
        props['PlaybackStatus']=GLib.Variant('s','Playing' if m=='Play' or (m=='PlayPause' and props['PlaybackStatus'].unpack()!='Playing') else 'Paused')
        bus.emit_signal(None,p,'org.freedesktop.DBus.Properties','PropertiesChanged',GLib.Variant('(sa{sv}as)',(i,{'PlaybackStatus':props['PlaybackStatus']},[])))
    inv.return_value(None)
def get(c,s,p,i,prop):return props.get(prop)
for interface in Gio.DBusNodeInfo.new_for_xml(xml).interfaces:bus.register_object('/org/mpris/MediaPlayer2',interface,call,get,None)
Gio.bus_own_name_on_connection(bus,name,0,None,None)
GLib.MainLoop().run()
'''


def setup(run_dir):
    config=Path(os.environ['XDG_CONFIG_HOME'])
    config.mkdir(parents=True,exist_ok=True)
    (config/'user-dirs.dirs').write_text('XDG_PICTURES_DIR="'+str(run_dir/'Pictures')+'"\nXDG_VIDEOS_DIR="'+str(run_dir/'Videos')+'"\n')
    for key,value in [('hardware','false'),('framerate','30'),('save-dir',repr(str(run_dir/'Videos')))]:
        subprocess.run(['gsettings','set','org.nidara.recording',key,value],check=True)
