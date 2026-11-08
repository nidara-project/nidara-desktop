#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""B3.1 real-wire check; shared private fixture also drives B3.2."""
from notification_fixture import *

try:
    daemon, renderer, data = setup()
    if os.environ.get('NK_NOTIFICATION_HIDPI_CHECK')=='1':
        image=RUN/'hidpi.svg'
        image.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0066ee"/></svg>')
        notify('HiDPI startup',hints={'image-path':GLib.Variant('s',str(image))})
        until('scaled card',lambda:node('HiDPI startup'))
        def metrics():
            return [json.loads(line.split('ICON_METRIC ',1)[1]) for line in (LOG/'shell.log').read_text().splitlines() if 'ICON_METRIC ' in line]
        def scaled_artwork(v):
            scales=[e.get('scale',1) for e in v if e.get('logical')==44 and e.get('scale',1)>1]
            return bool(scales) and any(e.get('side')==int(64*scales[-1]+.999) and str(e.get('id','')).startswith('winit:') for e in v)
        requests=until('physical artwork requests at HiDPI',lambda:(v:=metrics()) and scaled_artwork(v) and v,timeout=30)
        oracle('artwork follows renderer pixel scale',scaled_artwork,requests,[e for e in requests if e.get('scale',1)<=1 and e.get('side',0)<=64])
        (LOG/'report.json').write_text(json.dumps(REPORT,indent=2))
        print('B3.1 HiDPI PASSED',flush=True)
        raise SystemExit(0)
    def owner_calls():return (LOG/'owner-monitor.log').read_text().count('member=GetNameOwner')
    until('initial notification owner lookup observed',lambda:owner_calls()>0)
    pump(.2)
    lookups=owner_calls();pump(3.2)
    oracle('notification watcher makes no idle owner calls',lambda v:v==0,owner_calls()-lookups,1)
    # NameOwnerChanged alone must retire old banners and resume fresh events.
    old_notice=notify('Before daemon owner loss')
    until('old owner banner',lambda:old_notice in ids(banners()))
    before_loss=state()
    daemon.terminate();daemon.wait(timeout=5);PROCS.remove(daemon)
    lost=until('owner loss retires stack',lambda:(s:=state())['available'] is False and not s['banners'] and s)
    oracle('owner signal retires stale banners',lambda v:not v['available'] and not v['banners'],lost,before_loss)
    daemon=start('sessiond-restarted',[os.environ['NK_SESSIOND_BIN'],'--config','--applications'],XDG_DATA_DIRS=str(data))
    until('new owner ready',lambda:state()['available'])
    fresh=notify('After daemon owner change')
    recovered=until('fresh banner after owner signal',lambda:(s:=state())['available'] and any(n['id']==fresh and n['summary']=='After daemon owner change' for n in s['banners']) and s)
    oracle('owner signal resumes fresh notifications',lambda v:v['available'] and any(n['id']==fresh and n['summary']=='After daemon owner change' for n in v['banners']),recovered,lost)
    clear()
    listener=Atspi.EventListener.new(lambda e,*_: ANNOUNCEMENTS.append((e.type,e.detail1,e.any_data)))
    listener.register('object:announcement')
    BUS.signal_subscribe(None,'org.nidara.Notifications1','Notified','/org/nidara/Notifications',None,Gio.DBusSignalFlags.NONE,
                         lambda c,s,p,i,m,a,*_: RAW_NOTIFIED.update({a.unpack()[0]:json.loads(a.unpack()[2])}))
    BUS.signal_subscribe(None,'org.freedesktop.Notifications',None,'/org/freedesktop/Notifications',None,Gio.DBusSignalFlags.NONE,
                         lambda c,s,p,i,m,a,*_: EVENTS.append((m,a.unpack())))
    spy=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
    leaked=[]
    spy.signal_subscribe(None,'org.freedesktop.Notifications',None,'/org/freedesktop/Notifications',None,Gio.DBusSignalFlags.NONE,
                         lambda c,s,p,i,m,a,*_: leaked.append((m,a.unpack())))
    first=notify('First')
    before=until('first banner',lambda:(v:=banners()) and ids(v)==[first] and v)
    until('notification semantic role',lambda:node('First'))
    until('announcement',lambda:ANNOUNCEMENTS)
    oracle('notification announcement',lambda v:any('First' in str(x[2]) for x in v),ANNOUNCEMENTS,[])
    for i in range(2,6): notify('Stack '+str(i))
    four=until('four cap',lambda:(v:=banners()) and len(v)==4 and first not in ids(v) and v)
    oracle('four cap preserves daemon history',lambda v:len(v)==4 and first not in ids(v),four,history())
    target=four[1]; order=ids(four)
    subprocess.run(['notify-send','--replace-id='+str(target['id']),'--expire-time=0','--app-name=B3 fixture','Replacement'],check=True,timeout=5)
    replaced=until('replacement in place',lambda:(v:=banners()) and any(n['summary']=='Replacement' for n in v) and v)
    oracle('replacement keeps position and identity',lambda v:ids(v)==order and v[1]['instance']==target['instance'] and v[1]['content']>target['content'],replaced,four)
    clear()
    sticky=notify('Critical survives saturation',critical=True)
    normal_ids=[notify('Ordinary burst '+str(i)) for i in range(4)]
    expected=[sticky,*normal_ids[1:]]
    kept=until('saturated stack keeps critical',lambda:(v:=banners()) and ids(v)==expected and v)
    oracle('normal burst preserves critical banner',lambda v:ids(v)==expected,kept,[{'id':i} for i in normal_ids])
    assert sticky in ids(history()) and normal_ids[0] in ids(history()),'local retirement removed history'
    clear()
    critical_ids=[notify('Critical burst '+str(i),critical=True) for i in range(5)]
    capped=until('all critical cap',lambda:(v:=banners()) and ids(v)==critical_ids[1:] and v)
    oracle('all critical stack retires oldest at four',lambda v:ids(v)==critical_ids[1:],capped,[{'id':i} for i in critical_ids[:4]])
    assert critical_ids[0] in ids(history()),'retired critical lost history'
    clear()
    settings('org.nidara.notifications','popup-timeout','1')
    normal=notify('Default timeout',timeout=-1)
    visible=until('default visible',lambda:(v:=banners()) and normal in ids(v) and v)
    until('default expires locally',lambda:normal not in ids(banners()),timeout=6)
    oracle('default expiry retains history',lambda v:normal not in ids(v) and normal in ids(history()),banners(),visible)
    timed=notify('Hover',timeout=6000)
    until('hover node',lambda:node('Hover'))
    r=box(node('Hover'));move(r[0]+r[2]/2,r[1]+50)
    until('hover pauses timer',lambda:(move(r[0]+r[2]/2,r[1]+50) or any(n['id']==timed and n['hovered'] and n['deadline'] is None for n in banners())))
    pump(6.2)
    paused=banners()
    move(20,200)
    until('hover leaves',lambda:any(n['id']==timed and not n['hovered'] for n in banners()))
    pump(.7)
    assert timed in ids(banners()), 'leave must restart full countdown'
    until('sender timeout after leave',lambda:timed not in ids(banners()),timeout=10)
    oracle('hover pause and restart',lambda v:timed in ids(v),paused,banners())
    oracle('positive timeout never removes daemon history',lambda v:timed in ids(v),history(),banners())
    critical=int(subprocess.check_output(['notify-send','--print-id','--urgency=critical','--expire-time=1','--app-name=B3 fixture','Critical'],text=True,timeout=5).strip())
    never=notify('Never',timeout=0)
    stable=until('critical and zero timeout',lambda:(v:=banners()) and critical in ids(v) and never in ids(v) and v)
    pump(1.5)
    oracle('critical and zero never expire',lambda v:critical in ids(v) and never in ids(v),banners(),[])
    until('critical alert role',lambda:node('Critical').get_role()==Atspi.Role.ALERT)
    until('assertive critical announcement',lambda:any(e[1]==2 and str(e[2])=='B3 fixture: Critical' for e in ANNOUNCEMENTS))
    oracle('critical announcement is assertive',lambda v:any(e[1]==2 and str(e[2])=='B3 fixture: Critical' for e in v),ANNOUNCEMENTS,[e for e in ANNOUNCEMENTS if e[1]!=2])
    settings('org.nidara.notifications','do-not-disturb','true')
    until('DND retires normal only',lambda:ids(banners())==[critical])
    oracle('DND critical exception',lambda v:critical in ids(v) and never not in ids(v),banners(),stable)
    suppressed=notify('Suppressed')
    pump(.4)
    oracle('DND suppresses new normals',lambda v:suppressed not in ids(v),banners(),history())
    # Transients leave live memory/List exactly when their presentation retires.
    suppressed_transient=notify('Suppressed transient',hints={'transient':GLib.Variant('b',True)})
    until('suppressed transient retired',lambda:suppressed_transient not in ids(history()))
    oracle('suppression expires transient history only',lambda v:suppressed_transient not in ids(v) and suppressed in ids(v),history(),[{'id':suppressed_transient}])
    settings('org.nidara.notifications','do-not-disturb','false')
    clear()
    # Send through notify-send as well as the persistent action-capable sender above.
    subprocess.run(['notify-send','--expire-time=0','--app-name=B3 notify-send','Real notify-send'],check=True,timeout=5)
    until('notify-send renderer',lambda:any(n['summary']=='Real notify-send' for n in banners()))
    def neutral_art():
        rows=[json.loads(line.split('ICON_METRIC ',1)[1]) for line in (LOG/'shell.log').read_text().splitlines() if 'ICON_METRIC ' in line]
        return [e for e in rows if e.get('id')=='nd-notifications-symbolic']
    neutral=until('neutral reference artwork decoded',lambda:(v:=neutral_art()) and any(e.get('event')=='icon-convert' for e in v) and v)
    oracle('unknown sender gets reference neutral artwork',lambda v:any(e.get('event')=='icon-convert' for e in v) and not any(e.get('event')=='icon-fetch-error' for e in v),neutral,neutral+[{'event':'icon-fetch-error'}])
    clear()
    image=RUN/'thumbnail.svg'
    image.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ee4400"/></svg>')
    ephemeral=notify('Timed transient',timeout=180,hints={'transient':GLib.Variant('i',1)})
    until('timed transient visible',lambda:ephemeral in ids(banners()))
    until('timed transient expired',lambda:ephemeral not in ids(history()))
    oracle('banner timeout expires transient record',lambda v:ephemeral not in ids(v),history(),[{'id':ephemeral}])
    ephemeral=notify('Capped transient',hints={'transient':GLib.Variant('b',True)})
    for i in range(4): notify('Transient cap '+str(i))
    until('capped transient expired',lambda:ephemeral not in ids(history()))
    oracle('cap expires transient record',lambda v:ephemeral not in ids(v),history(),[{'id':ephemeral}])
    clear()
    id_file=RUN/'cli-id';selected_file=RUN/'cli-action';token_file=RUN/'cli-token'
    streams=[os.open(p,os.O_CREAT|os.O_RDWR,0o600) for p in (id_file,selected_file,token_file)]
    cli=subprocess.Popen(['notify-send','--expire-time=0','--action=pick=CLI Accept',
        '--hint=string:image-path:'+str(image),'--app-name=B3 notify-send',
        '--id-fd='+str(streams[0]),'--selected-action-fd='+str(streams[1]),'--activation-token-fd='+str(streams[2]),
        'CLI actions and image'],pass_fds=streams,stdout=(LOG/'notify-send.log').open('w'),stderr=subprocess.STDOUT)
    EXTRA.append(cli)
    for fd in streams:os.close(fd)
    cli_id=int(until('notify-send id',lambda:id_file.read_text().strip()))
    cli_node=until('notify-send action card',lambda:node('CLI actions and image'))
    next(n for n in children(cli_node) if n.get_name()=='CLI Accept').get_action_iface().do_action(0)
    until('notify-send receives selected action',lambda:selected_file.read_text().strip()=='pick')
    until('notify-send receives activation token',lambda:bool(token_file.read_text().strip()))
    until('nonresident CLI action closes history',lambda:cli_id not in ids(history()))
    oracle('notify-send action and token round trip',lambda v:v==('pick',True,False),
        (selected_file.read_text().strip(),bool(token_file.read_text().strip()),cli_id in ids(history())),('',False,True))
    cli.wait(timeout=5)
    clear()
    actionable=notify('Actions and image',actions=('default','Open','accept','Accept','other','Other','third','Third','fourth','Fourth'),
        hints={'image-path':GLib.Variant('s',str(image)),'resident':GLib.Variant('b',True)})
    n=until('actions node',lambda:node('Actions and image'))
    action_nodes=children(n)
    oracle('declared action buttons',lambda v:any(x.get_name()=='Accept' for x in v),action_nodes,[])
    # A real pointer action obtains a compositor token; resident history remains.
    accept=next(x for x in action_nodes if x.get_name()=='Accept')
    r=box(accept)
    until('action card accepts real pointer',lambda:(move(r[0]+r[2]/2,r[1]+r[3]/2) or any(n['id']==actionable and n['hovered'] for n in banners())))
    click(r[0]+r[2]/2,r[1]+r[3]/2)
    until('pointer ActionInvoked',lambda:any(m=='ActionInvoked' and a==(actionable,'accept') for m,a in EVENTS))
    paired=[(m,a) for m,a in EVENTS if a[0]==actionable and m in ('ActivationToken','ActionInvoked')]
    oracle('token precedes directed action',lambda v:len(v)==2 and v[0][0]=='ActivationToken' and bool(v[0][1][1]) and v[1][0]=='ActionInvoked',paired,list(reversed(paired)))
    oracle('token and action private to sender',lambda v:not any(a[0]==actionable and m in ('ActivationToken','ActionInvoked') for m,a in v),leaked,paired)
    assert actionable in ids(history()), 'resident action removed record'
    EVENTS.clear()
    accept.get_component_iface().grab_focus()
    until('keyboard focus on action',lambda:any(n.get_name()=='Accept' and n.get_state_set().contains(Atspi.StateType.FOCUSED) for n in children(node('Actions and image'))))
    # Withhold replies only from the disposable compositor, never a live session.
    accept=next(x for x in children(node('Actions and image')) if x.get_name()=='Accept')
    pid=os.getppid()
    expected=Path(os.environ['HYALO_BIN']).resolve()
    while pid>1 and Path(f'/proc/{pid}/exe').resolve()!=expected:
        pid=int(next(line.split()[1] for line in Path(f'/proc/{pid}/status').read_text().splitlines() if line.startswith('PPid:')))
    assert pid>1 and Path(f'/proc/{pid}/exe').resolve()==expected, 'private compositor ancestor missing'
    env=Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    assert ('XDG_RUNTIME_DIR='+str(RUN/'runtime')).encode() in env, 'refuse non-private compositor'
    EVENTS.clear()
    os.kill(pid,signal.SIGSTOP)
    try:
        accept.get_action_iface().do_action(0)
        until('token failure visible in canonical state',lambda:any(b['id']==actionable and b['error'] for b in banners()),timeout=8)
        assert not any(m=='ActionInvoked' and a[0]==actionable for m,a in EVENTS)
    finally:
        os.kill(pid,signal.SIGCONT)
    failed=until('token error reader description',lambda:(n:=node('Actions and image')) and 'Try again' in n.get_description() and n)
    oracle('token failure is accessible and retryable',lambda v:'Try again' in v,failed.get_description(),'')
    pump(.5)
    def error_ink():
        shot=LOG/'activation-error.png'
        msg('screenshot',shot)
        pix=GdkPixbuf.Pixbuf.new_from_file(str(shot));pixels=pix.get_pixels();stride=pix.get_rowstride();channels=pix.get_n_channels()
        x,y,w,h=map(int,box(node('Actions and image')))
        return sum(min(pixels[yy*stride+xx*channels:yy*stride+xx*channels+3])>200 for yy in range(y+h-28,y+h-8) for xx in range(x+16,x+w-16))
    visible_error=until('activation error paints pixels',lambda:(v:=error_ink())>20 and v)
    oracle('activation error is visibly painted',lambda v:v>20,visible_error,0)
    next(x for x in children(failed) if x.get_name()=='Accept').get_action_iface().do_action(0)
    until('token failure retry invokes action',lambda:any(m=='ActionInvoked' and a==(actionable,'accept') for m,a in EVENTS))
    until('retry clears error',lambda:any(b['id']==actionable and not b['error'] for b in banners()))
    EVENTS.clear()
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write('key 28\n')
    until('keyboard action',lambda:any(m=='ActionInvoked' and a==(actionable,'accept') for m,a in EVENTS))
    oracle('keyboard activation carries token',lambda v:any(m=='ActivationToken' and a[0]==actionable for m,a in v),EVENTS,[])
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write('key 1\n')
    pump(.2)
    # Same component, assistive activation: focus handshake, genuine enter serial.
    EVENTS.clear()
    n=node('Actions and image')
    next(x for x in children(n) if x.get_name()=='Accept').get_action_iface().do_action(0)
    until('assistive ActionInvoked',lambda:any(m=='ActionInvoked' and a==(actionable,'accept') for m,a in EVENTS))
    oracle('assistive action has real token',lambda v:any(m=='ActivationToken' and a[0]==actionable and bool(a[1]) for m,a in v),EVENTS,[])
    # The second action page exposes all declared keys without expanding the card.
    more=next(x for x in children(node('Actions and image')) if x.get_name()=='More actions…')
    more.get_action_iface().do_action(0)
    until('more actions page',lambda:any(x.get_name()=='Third' for x in children(node('Actions and image'))))
    shot=LOG/'banners.png'
    msg('screenshot',shot)
    assert shot.read_bytes().startswith(b'\x89PNG')
    pix=GdkPixbuf.Pixbuf.new_from_file(str(shot));pixels=pix.get_pixels();stride=pix.get_rowstride();channels=pix.get_n_channels()
    def ink_pixels(rect,predicate):
        x,y,w,h=map(int,rect)
        return sum(predicate(pixels[yy*stride+xx*channels:yy*stride+xx*channels+3]) for yy in range(y,y+h) for xx in range(x,x+w))
    r=box(node('Actions and image'))
    summary_pixels=ink_pixels([r[0]+72,r[1]+31,180,20],lambda p:min(p)>200)
    empty_pixels=ink_pixels([40,240,180,20],lambda p:min(p)>200)
    oracle('summary paints with unavailable bold face',lambda v:v>20,summary_pixels,empty_pixels)
    image_pixels=ink_pixels([r[0]+r[2]-80,r[1]+40,64,64],lambda p:p[0]>180 and 30<p[1]<130 and p[2]<30)
    oracle('image-path thumbnail paints',lambda v:v>2000,image_pixels,empty_pixels)
    # A request from old content must lose a race against replacement in the daemon.
    pump(.1)
    old_revision=RAW_NOTIFIED[actionable]['revision']
    image.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0066ee"/></svg>')
    notify('Actions and image',replace=actionable,actions=('default','Open','accept','Accept'),hints={'resident':GLib.Variant('b',True),'image-path':GLib.Variant('s',str(image))})
    until('fresh replacement revision',lambda:RAW_NOTIFIED.get(actionable,{}).get('revision',0)>old_revision)
    rejected=[]
    for method,args in [('DismissBanner',GLib.Variant('(ut)',(actionable,old_revision))),
                        ('InvokeActionWithToken',GLib.Variant('(usst)',(actionable,'accept','stale-test-token',old_revision)))]:
        try: private(method,args)
        except GLib.Error: rejected.append(method)
    oracle('daemon rejects retired banner actions',lambda v:len(v)==2,rejected,[])
    assert actionable in ids(history()),'stale dismiss touched replacement'
    def new_thumbnail():
        msg('screenshot',LOG/'replacement-image.png')
        p=GdkPixbuf.Pixbuf.new_from_file(str(LOG/'replacement-image.png'));raw=p.get_pixels();stride=p.get_rowstride();ch=p.get_n_channels()
        r=box(node('Actions and image'));x,y=int(r[0]+r[2]-80),int(r[1]+40)
        return sum(raw[yy*stride+xx*ch+2]>180 and raw[yy*stride+xx*ch]<30 for yy in range(y,y+64) for xx in range(x,x+64))
    new_pixels=until('same-path replacement thumbnail refreshes',lambda:(v:=new_thumbnail())>2000 and v,timeout=30)
    oracle('replacement image path does not reuse old pixels',lambda v:v>2000,new_pixels,empty_pixels)
    EVENTS.clear()
    until('replacement on screen',lambda:any(n['id']==actionable and n['content']>1 for n in banners()))
    node('Actions and image').get_action_iface().do_action(0)
    until('body default action',lambda:any(m=='ActionInvoked' and a==(actionable,'default') for m,a in EVENTS))
    oracle('body invokes declared default',lambda v:any(m=='ActionInvoked' and a==(actionable,'default') for m,a in v),EVENTS,[])
    before_close=history()
    next(x for x in children(node('Actions and image')) if x.get_name()=='Close notification').get_action_iface().do_action(0)
    until('explicit close reaches daemon',lambda:actionable not in ids(history()))
    oracle('close dismisses daemon record',lambda v:actionable not in ids(v),history(),before_close)
    swipe=notify('Swipe')
    n=until('swipe card',lambda:node('Swipe'));r=box(n)
    until('swipe card accepts pointer',lambda:(move(r[0]+100,r[1]+60) or any(n['id']==swipe and n['hovered'] for n in banners())))
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:
        x,y=r[0]+100,r[1]+60
        pipe.write(f'press {x} {y} 272\n')
        pump(.1)
        pipe.write(f'move {x+120} {y}\nrelease 272\n')
    until('swipe dismissal',lambda:swipe not in ids(history()))
    oracle('swipe dismisses',lambda v:swipe not in ids(v),history(),[{'id':swipe}])
    # Real client behind the banner surface: card gaps must pass clicks through.
    clicks=RUN/'client-clicks'
    client_code = r"""
import sys,gi
from pathlib import Path
gi.require_version('Gtk','4.0')
from gi.repository import Gtk,GLib
Gtk.init()
w=Gtk.Window(title='B3 pointer fixture');w.set_default_size(900,600)
button=Gtk.Button(label='B3 input and fullscreen fixture');w.set_child(button)
g=Gtk.GestureClick.new();g.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
def pressed(*args):
    with Path(sys.argv[1]).open('a') as f:f.write('click\n')
g.connect('pressed',pressed);button.add_controller(g);w.present();GLib.MainLoop().run()
"""
    start('pointer-client',['python','-u','-c',client_code,str(clicks)],GDK_BACKEND='wayland',GSK_RENDERER='cairo',GDK_DISABLE='gl,vulkan')
    client_window=until('private GTK client',lambda:next((w for w in msg('windows')['ok']['windows'] if w['title']=='B3 pointer fixture'),None))
    clear()
    click(200,300)
    until('client positive input control',lambda:clicks.exists() and clicks.read_text().count('click')>0)
    baseline_clicks=clicks.read_text().count('click')
    one=notify('Input One');two=notify('Input Two')
    first_node=until('two accessible cards',lambda:len(notices())==2 and node('Input One'))
    r=box(first_node)
    until('input card committed',lambda:(move(r[0]+100,r[1]+60) or any(n['id']==one and n['hovered'] for n in banners())))
    actual_client=next(w for w in msg('windows')['ok']['windows'] if w['id']==client_window['id'])
    gap=((max(r[0],actual_client['x'])+min(r[0]+r[2],actual_client['x']+actual_client['width']))/2,r[1]+r[3]+8)
    (LOG/'input-geometry.json').write_text(json.dumps({'card':r,'client':actual_client,'gap':gap,'layers':msg('layers')},indent=2))
    click(*gap)
    until('gap click reaches client',lambda:clicks.exists() and clicks.read_text().count('click')>baseline_clicks)
    passed=clicks.read_text().count('click')
    click(r[0]+100,r[1]+60)
    until('body without default dismisses',lambda:one not in ids(history()))
    oracle('card glass captures but gap passes through',lambda v:v==passed,clicks.read_text().count('click'),passed+1)
    # The same right-dock envelope is used for banners and CC.
    old_box=box(node('Input Two'))
    settings('org.nidara.dock','position',"'right'")
    moved=until('card dodges right dock',lambda:(r:=box(node('Input Two')))[0]<old_box[0]-40 and r)
    dock=until('right dock',lambda:next((l for l in msg('layers')['ok']['layers'] if l['namespace']=='nidara-dock' and l['width']<l['height']),None))
    oracle('right dock avoidance',lambda v:v[0]+v[2]<=dock['x'],moved,old_box)
    cc=next(n for n in children(bar()) if n.get_name()=='Control Center')
    cc.get_action_iface().do_action(0)
    until('CC suppresses ordinary banners',lambda:not banners())
    critical_cc=notify('Critical over CC',critical=True)
    until('critical cuts through CC',lambda:critical_cc in ids(banners()))
    oracle('CC critical exception',lambda v:critical_cc in ids(v) and two not in ids(v),banners(),[{'id':two}])
    cc_panel=until('CC panel semantics',lambda:next((n for n in children(bar()) if n.get_name()=='Control Center' and n.get_role()==Atspi.Role.PANEL),None))
    cc_box=box(cc_panel)
    oracle('CC and banner share right edge',lambda v:v[0]+v[2]==moved[0]+moved[2],cc_box,old_box)
    # Close using a real click after the critical card's accessibility publication.
    until('critical CC card published',lambda:node('Critical over CC'))
    cc_button=next(n for n in children(bar()) if n.get_name()=='Control Center' and n.get_role()==Atspi.Role.BUTTON)
    r=box(cc_button);click(r[0]+r[2]/2,r[1]+r[3]/2)
    until('CC closed',lambda:not any(n.get_name()=='Control Center' and n.get_role()==Atspi.Role.PANEL for n in children(bar())))
    clear(); settings('org.nidara.dock','position',"'bottom'")
    msg('do','fullscreen',client_window['id'])
    until('client fullscreen',lambda:any(w['id']==client_window['id'] and w['fullscreen'] not in ('none',False,None) for w in msg('windows')['ok']['windows']))
    full=notify('Fullscreen critical',critical=True)
    until('fullscreen banner',lambda:full in ids(banners()))
    until('fullscreen card accepts pointer',lambda:(move(1100,100) or any(n['id']==full and n['hovered'] for n in banners())))
    surface=until('fullscreen row hidden in committed glass',lambda:next((l for l in msg('layers')['ok']['layers'] if l['namespace']=='nidara-bar' and l.get('glass',{}).get('shapes')==1),None))
    oracle('fullscreen banner stays above client',lambda v:v.get('layer')=='overlay' and v.get('height',0)>48 and v.get('glass',{}).get('shapes')==1,surface,{'layer':'top','height':48})
    clear();msg('do','fullscreen',client_window['id'])
    # A renderer restart never turns historical records back into fresh popups.
    previous=notify('No replay on renderer restart')
    until('pre-restart banner',lambda:previous in ids(banners()))
    renderer.terminate();renderer.wait(timeout=5);PROCS.remove(renderer)
    renderer=start('shell-restarted',[os.environ['NK_DOCK_BIN'],'--bar'],NK_ICON_METRICS='1')
    until('new renderer source ready',lambda:state()['available'])
    oracle('renderer restart does not replay history',lambda v:previous not in ids(v) and previous in ids(history()),banners(),history())
    clear()
    # Native dumpState exercises the additive capability without altering GetState's tuple.
    if os.environ.get('NIDARA_IPC_BIN'):
        dump=json.loads(subprocess.check_output([os.environ['NIDARA_IPC_BIN'],'dumpState'],text=True,timeout=5))
        oracle('dumpState includes native banners',lambda v:isinstance(v.get('banners'),list) and v.get('available') is True,dump['shell']['notifications'],{})
    assert all(p.poll() is None for p in PROCS), 'native service exited'
    (LOG/'report.json').write_text(json.dumps(REPORT,indent=2))
    print('B3.1 NOTIFICATIONS PASSED',flush=True)
finally:
    for p in reversed(EXTRA+PROCS):
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
