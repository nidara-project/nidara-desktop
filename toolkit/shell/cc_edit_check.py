#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""B2.3 private edit-mode and widget walk with real pointer/keys/AT-SPI/settings."""
from notification_fixture import *
import base64,struct,zlib

def walk(root):
    yield root
    for child in children(root):yield from walk(child)
def center():
    root=bar()
    return next((n for n in children(root) if n.get_name()=='Control Center' and n.get_role()==Atspi.Role.PANEL),None) if root else None
def nodes():return list(walk(center())) if center() else []
def find(name):return next(n for n in nodes() if n.get_name()==name)
def names():return [n.get_name() for n in nodes()]
def activate(name):
    n=until(name+' enabled',lambda:(n if n.get_state_set().contains(Atspi.StateType.ENABLED) else None) if (n:=find(name)) else None);assert n.get_action_iface().do_action(0);pump(.25)
def focus(name):
    n=until(name+' enabled',lambda:(n if n.get_state_set().contains(Atspi.StateType.ENABLED) else None) if (n:=find(name)) else None);assert n.get_component_iface().grab_focus();pump(.25)
def control(command,delay=.2):
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write(command+'\n')
    pump(delay)
def press(name,button=272):
    r=box(find(name));x,y=r[0]+r[2]/2,r[1]+r[3]/2
    move(x,y)
    control(f'press {x} {y} {button}\nrelease {button}')
def keys(code,mods=()):
    for mod in mods:control(f'keydown {mod}')
    control(f'key {code}')
    for mod in reversed(mods):control(f'keyup {mod}')
def shot(name):pump(1.5);msg('screenshot',LOG/name)
def stored():
    cc=Gio.Settings.new('org.nidara.control-center');widgets=Gio.Settings.new('org.nidara.widgets')
    return {'positions':cc.get_value('positions').unpack(),'sizes':cc.get_value('sizes').unpack(),'placement':widgets.get_value('placement').unpack()}
def named(name,action):
    n=until(name,lambda:find(name));a=n.get_action_iface();index=next(i for i in range(a.get_n_actions()) if a.get_action_name(i)==action);assert a.do_action(index);pump(.25)

try:
    # All helpers and clipboard bytes are private to this run.
    bindir=RUN/'bin';bindir.mkdir()
    for name in ['cliphist','wl-copy']:(bindir/name).symlink_to(REPO/'toolkit/shell/cc_edit_helpers.py')
    os.environ['PATH']=str(bindir)+os.pathsep+os.environ['PATH']
    os.environ['NK_CC_CLIP_STATE']=str(RUN/'clips.json');os.environ['NK_CC_CLIP_LOG']=str(LOG/'clip-actions.jsonl');os.environ['NK_CC_COPIED']=str(LOG/'copied.bin')
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\xff\0\0'))+chunk(b'IEND',b'')
    rows=[{'id':'11','preview':base64.b64encode(b'h\0e\0l\0l\0o\0').decode(),'raw':base64.b64encode(b'h\0e\0l\0l\0o\0').decode()},{'id':'12','preview':base64.b64encode(b'[[ binary data 24 KiB png 1x1 ]]').decode(),'raw':base64.b64encode(png).decode()}]
    (RUN/'clips.json').write_text(json.dumps(rows))
    daemon,renderer,data=setup()
    settings('org.nidara.widgets','placement',"{'screenshot': (true, true)}")
    cc=next(n for n in children(bar()) if n.get_name()=='Control Center')
    x,y,w,h=box(cc);move(x+w/2,y+h/2);click(x+w/2,y+h/2);until('CC opens',center)
    print('CC',names(),flush=True)
    until('committed full bar surface',lambda:any(n['namespace']=='nidara-bar' and n['height']>box(find('Edit'))[1] for n in msg('layers')['ok']['layers']))
    shot('cc-grid.png')
    press('Edit');until('edit mode',lambda:'Done' in names())
    shot('edit-mode.png')
    (LOG/'edit-tree.txt').write_text('\n'.join(f'{n.get_role_name()} {n.get_name()} {box(n)}' for n in nodes()))
    oracle('edit mode exposes full-grid controls',lambda v:'Done' in v and 'screenshot' not in v,names(),[])
    before=stored();print('STORED',before,flush=True)
    focus('Screenshot');keys(103,(29,));pump(.2)
    oracle('Ctrl-up at top is a silent no-op',lambda v:v==(before,False),(stored(),any(n.get_role()==Atspi.Role.ALERT for n in nodes())),({},True))
    r=box(find('Volume'));sx,sy=r[0]+20,r[1]+20
    control(f'press {sx} {sy} 272');control(f'move {sx+96} {sy}');control('release 272')
    until('wide invalid drop restores box',lambda:box(find('Volume'))==r)
    oracle('wide drop past cell boundary silently rolls back',lambda v:v==(before,False),(stored(),any(n.get_role()==Atspi.Role.ALERT for n in nodes())),({},True))

    # Same-sized screenshot and recording occupy adjacent cells in DEFAULT.
    source=find('Screenshot');target=find('Screen recording')
    a=box(source);b=box(target);sx,sy=a[0]+a[2]/2,a[1]+a[3]/2;tx,ty=b[0]+b[2]/2,b[1]+b[3]/2
    control(f'press {sx} {sy} 272')
    for step in range(1,9):control(f'move {sx+(tx-sx)*step/8} {sy+(ty-sy)*step/8}')
    oracle('drag preview never writes settings',lambda s:s==before,stored(),{'positions':{'screenshot':(3,0)}})
    control('release 272')
    until('move persisted',lambda:bool(stored()['positions']))
    after=stored();print('AFTER DRAG',after,flush=True)
    oracle('equal-footprint drag swaps exact cells',lambda s:s['positions']['screenshot']==(3,0) and s['positions']['screenrecord']==(2,0),after,{'positions':{'screenshot':(2,0),'screenrecord':(3,0)}})
    oracle('first drag personalizes all cells',lambda s:len(s['positions'])>=7,after,{'positions':{}})
    ts=json.loads(subprocess.check_output(['gjs','-m',os.environ['NK_CC_TS_PROBE']],text=True,timeout=10))
    ts_cells={v['id']:(v['x'],v['y']) for v in ts['layout']}
    oracle('unchanged TS layout reader reopens exact Rust cells',lambda v:v==after['positions'],ts_cells,{})
    oracle('unchanged TS placement reader preserves bar and CC',lambda v:v=={'bar':True,'cc':True},ts['placement']['screenshot'],{'bar':False,'cc':True})
    (LOG/'ts-roundtrip.json').write_text(json.dumps(ts,indent=2))
    # Invalid pointer drop outside the grid restores the original model without a write.
    focus('Screenshot');a=box(find('Screenshot'));sx,sy=a[0]+20,a[1]+30
    control(f'press {sx} {sy} 272');control('move 600 300');control('release 272')
    until('invalid drag settles',lambda:box(find('Screenshot'))==a)
    oracle('invalid outside drop keeps settings',lambda s:s==after,stored(),before)
    focus('Screenshot');keys(105,(29,));until('Ctrl-left persisted',lambda:stored()['positions']['screenshot']==(2,0))
    focus('Screenshot');keys(106,(29,));until('Ctrl-right persisted',lambda:stored()['positions']['screenshot']==(3,0))
    shot('edit-moved.png')
    press('Screenshot',273);until('size menu',lambda:'Medium' in names())
    activate('Medium');until('resize persisted',lambda:stored()['sizes'].get('screenshot')=='2x1')
    named('Screenshot','Remove');until('remove persisted',lambda:stored()['placement'].get('screenshot',(False,True))[1] is False)
    oracle('remove preserves bar placement',lambda p:p==(True,False),stored()['placement']['screenshot'],(False,False))
    focus('Add Screenshot');a=box(find('Add Screenshot'));origin=box(find('Media'));sx,sy=a[0]+a[2]/2,a[1]+a[3]/2;tx,ty=origin[0]+86,origin[1]+6*96+38
    gallery_before=stored();control(f'press {sx} {sy} 272')
    for step in range(1,6):control(f'move {sx+(tx-sx)*step/5} {sy+(ty-sy)*step/5}')
    oracle('gallery drag previews without writes',lambda s:s==gallery_before,stored(),{})
    control('release 272');until('gallery drag persists exact target',lambda:stored()['placement'].get('screenshot',(False,False))[1] is True and stored()['positions']['screenshot']==(0,6))
    oracle('add back preserves bar placement',lambda p:p==(True,True),stored()['placement']['screenshot'],(False,True))
    until('keyboard active',lambda:bar().get_state_set().contains(Atspi.StateType.ACTIVE))
    keys(1);until('Escape leaves edit but keeps CC',lambda:center() and 'Edit' in names() and 'Done' not in names())
    focus('Screenshot');press('Screenshot',273);pump(.3)
    oracle('outside edit no sizing actions',lambda v:not any(k in v for k in ['Small','Medium','Large']),names(),['Small'])
    back=next(n for n in names() if n=='Back' or n.endswith(' · Back'));activate(back)
    activate('Edit');until('editing again',lambda:'Done' in names())
    oracle('absent hardware is not offered',lambda v:not any(name in v for name in ['Add Battery','Add Ethernet','Add VPN']),names(),['Add Battery'])
    network_control=RUN/'network-control';network_control.write_text('present')
    start('edit-network',['python3','-I',str(REPO/'toolkit/shell/cc_edit_network.py'),str(network_control),str(LOG/'network-actions.jsonl')])
    until('Ethernet source arrives',lambda:'Add Ethernet' in names())
    for name in ['Add Ethernet','Add VPN','Add CPU & memory','Add Clipboard']:
        if name not in names():
            print('GALLERY',names(),flush=True)
        focus(name);activate(name);pump(.5)
    keys(1);until('normal widgets',lambda:'Edit' in names())
    placed_before_loss=stored();network_control.write_text('absent');until('Ethernet absent',lambda:'Ethernet · Details' not in names());oracle('source loss never edits placement',lambda s:s==placed_before_loss,stored(),{});network_control.write_text('present');until('Ethernet returns',lambda:'Ethernet · Details' in names())
    focus('Ethernet · Details');activate('Ethernet · Details');until('Ethernet detail',lambda:'Interface · eth-test' in names())
    sample_count=lambda:sum('cc-resources-sample' in line for line in (LOG/'shell.log').read_text().splitlines())
    pump(.5);samples=sample_count();pump(2.3);oracle('CPU sampling stops outside the mapped grid',lambda n:n==samples,sample_count(),samples+1)
    oracle('Ethernet IP comes from snapshot',lambda v:'IP · 192.0.2.10' in v,names(),[])
    activate('Ethernet');until('wired toggle sent',lambda:(LOG/'network-actions.jsonl').exists() and 'SetWiredEnabled' in (LOG/'network-actions.jsonl').read_text())
    back=next(n for n in names() if n.endswith(' · Back'));activate(back)
    focus('VPN');activate('VPN');activate('Fixture VPN')
    until('VPN activate',lambda:'Activate' in (LOG/'network-actions.jsonl').read_text())
    activate('Fixture VPN');until('VPN deactivate',lambda:'Deactivate' in (LOG/'network-actions.jsonl').read_text())
    back=next(n for n in names() if n.endswith(' · Back'));activate(back)
    focus('Clipboard');activate('Clipboard');until('clipboard rows',lambda:'hello' in names())
    activate('hello');until('clipboard copied',lambda:(LOG/'copied.bin').exists())
    oracle('UTF16 clipboard reoffers UTF8 bytes',lambda v:v==b'hello',(LOG/'copied.bin').read_bytes(),b'h\0e\0l\0l\0o\0')
    image_name=next(n for n in names() if n.startswith('Image ·'))
    activate(image_name);until('image copied',lambda:(LOG/'copied.bin').read_bytes()==png)
    oracle('image clipboard bytes are exact',lambda v:v==png,(LOG/'copied.bin').read_bytes(),b'not png')
    named('hello','Remove');until('clipboard entry removed',lambda:'hello' not in names())
    activate('Clear history');until('clear confirmation',lambda:'Clear everything' in names());activate('Clear everything');until('clipboard empty',lambda:'No clipboard history' in names())
    shot('widgets-complete.png')
    back=next(n for n in names() if n.endswith(' · Back'));activate(back)
    fixture={'media':(0,0,'2x2'),'focus':(2,0,'2x2'),'night_light':(0,2,'2x2'),'dark_mode':(2,2,'2x2'),'screenrecord':(0,4,'2x2'),'cpu_memory':(2,4,'2x2'),'volume':(0,6,'4x1'),'screenshot':(0,7,'1x1'),'clipboard':(1,7,'2x1')}
    cc_settings=Gio.Settings.new('org.nidara.control-center');cc_settings.delay()
    cc_settings.set_value('positions',GLib.Variant('a{s(ii)}',{k:(v[0],v[1]) for k,v in fixture.items()}))
    cc_settings.set_value('sizes',GLib.Variant('a{ss}',{k:v[2] for k,v in fixture.items()}));cc_settings.apply()
    Gio.Settings.new('org.nidara.widgets').set_value('placement',GLib.Variant('a{s(bb)}',{k:(False,k in fixture) for k in ['battery','bt','brightness','clipboard','cpu_memory','dark_mode','ethernet','focus','media','night_light','screenrecord','screenshot','volume','vpn','wifi']}));Gio.Settings.sync();pump(.5)
    activate('Edit');until('full fixture edit',lambda:'Done' in names())
    focus('Screenshot');keys(68,(42,));until('keyboard size menu',lambda:'Large' in names())
    oracle('full grid keeps all tiers and disables an impossible size',lambda v:v==[True,True,False],[find(n).get_state_set().contains(Atspi.StateType.ENABLED) for n in ['Small','Medium','Large']],[True,True,True])
    oracle('disabled tier explains refusal',lambda v:'Grid is full' in v,find('Large').get_description(),'')
    shot('full-grid-size-menu.png')
    keys(1);until('size menu dismissed',lambda:'Large' not in names());focus('Media')
    actions=find('Media').get_action_iface();fixed_actions=[actions.get_action_name(i) for i in range(actions.get_n_actions())]
    oracle('fixed tile never exposes Remove',lambda v:'Remove' not in v,fixed_actions,['Remove'])
    before_fixed=stored();keys(111);pump(.3);oracle('Delete cannot remove a fixed tile',lambda v:v==before_fixed,stored(),{})
    focus('Screenshot');keys(111);until('Delete removes optional tile',lambda:not stored()['placement']['screenshot'][1])
    keys(1);until('finished edit stays in CC',lambda:'Edit' in names())

    (LOG/'report.json').write_text(json.dumps({'checks':REPORT,'stored':stored()},indent=2))
    print('B2.3 EDIT PASSED',flush=True)
except Exception:
    try:
        msg('screenshot',LOG/'failure.png')
        (LOG/'failure-tree.txt').write_text('\n'.join(f'{n.get_role_name()} {n.get_name()} {box(n)}' for n in walk(bar())))
        (LOG/'failure-layers.json').write_text(json.dumps(msg('layers'),indent=2))
    except Exception:pass
    raise
finally:
    for p in reversed(PROCS):
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
