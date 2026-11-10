#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Real NC, journal, AT-SPI and CLI test on a disposable 2000-record history."""
from notification_fixture import *

def walk(root):
    yield root
    for child in children(root):yield from walk(child)

def center():
    root=bar()
    return next((n for n in children(root) if n.get_name()=='Notification Center'),None) if root else None

def nodes(role=None):
    c=center()
    return [] if not c else [n for n in walk(c) if n is not c and (role is None or n.get_role()==role)]
def named(prefix,role=Atspi.Role.BUTTON):return [n for n in nodes(role) if n.get_name().startswith(prefix)]
def find(name):return next(n for n in nodes() if n.get_name()==name)
def history_cards():return named('History ')
def activate(name):find(name).get_action_iface().do_action(0);pump(.05)
def key(code):
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write(f'key {code}\n')
    pump(.3)
def card_of(name):
    # The card's pane: the panel holding the button of that name.
    return next(p for p in nodes(Atspi.Role.PANEL) if any(n.get_name()==name for n in walk(p)))
FRONT='History 2000, 2000 notifications, expand'
HEADER='Archive, 2000 notifications, collapse'
def clock():return next(n for n in children(bar()) if n.get_role()==Atspi.Role.BUTTON and n.get_name()!='Control Center' and n.get_state_set().contains(Atspi.StateType.EXPANDABLE))
def open_clock():
    r=until('clock geometry configured',lambda:(r:=box(clock())) and r[0]>=0 and r[2]>0 and r[3]>0 and r);move(r[0]+r[2]/2,r[1]+r[3]/2);pump(.3);click(r[0]+r[2]/2,r[1]+r[3]/2);until('clock opens NC',center)
def close_escape():
    until('NC has actual keyboard focus',lambda:bar().get_state_set().contains(Atspi.StateType.ACTIVE))
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write('key 1\n')
    until('Escape closes NC',lambda:center() is None)
def stable_shot(path):
    # Reader/model publication precedes the software compositor's displayed frame.
    pump(1.5)
    msg('screenshot',path)

def archive(summary):
    return notify(summary,hints={'desktop-entry':GLib.Variant('s','b32-archive')})

try:
    now=int(time.time())
    records=[dict(id=i,app_name='Archive',app_icon='',summary=f'History {i}',body='Persisted before the renderer started.',expire_timeout=80,time=now,
                  hints={'desktop-entry':'b32-archive'},actions=[{'id':'read','label':'Read'}] if i==2000 else []) for i in range(1,2001)]
    daemon,renderer,data=setup(records)
    initial=history()
    oracle('2000 imported records receive runtime revisions',lambda rows:len(rows)==2000 and all(n.get('revision',0)>0 for n in rows),initial,[{**n,'revision':0} for n in initial])
    oracle('history hydration never replays banners',lambda rows:not rows,banners(),[{'id':1}])
    cache=Path(os.environ['XDG_CACHE_HOME'])/'nidara/notifd'
    oracle('legacy store imported once into journal',lambda v:v==(False,True),((cache/'state.json').exists(),(cache/'history.jsonl').exists()),(True,False))
    open_clock()
    until('collapsed archive group',lambda:find(FRONT))
    oracle('collapsed group shows count and newest only',lambda v:len(v)==1 and v[0].get_name()==FRONT,history_cards(),[])
    oracle('relative age is available to readers',lambda v:v.startswith('now'),find(FRONT).get_description(),'')
    month=lambda:[n.get_name() for n in nodes(Atspi.Role.LABEL) if any(ch.isdigit() for ch in n.get_name()) and len(n.get_name())>6]
    date=month()
    activate('Next month');until('calendar navigates',lambda:month()!=date)
    activate('Previous month');until('calendar returns',lambda:month()==date)
    selected=named('Today, ')
    oracle('calendar marks today',lambda v:len(v)==1 and not v[0].get_state_set().contains(Atspi.StateType.ENABLED),selected,[])
    def today_ink():
        msg('screenshot',LOG/'nc-calendar.png')
        pix=GdkPixbuf.Pixbuf.new_from_file(str(LOG/'nc-calendar.png'));data=pix.get_pixels();stride=pix.get_rowstride();channels=pix.get_n_channels()
        x,y,w,h=box(selected[0]);xx=int(x+w/2);yy=int(y+h-3)
        offset=-int(w+2) if x>box(center())[0]+32 else int(w+2)
        good=data[yy*stride+xx*channels];bad=data[yy*stride+(xx+offset)*channels]
        (LOG/'today-colors.json').write_text(json.dumps({'box':[x,y,w,h],'today':good,'other':bad}))
        digit=sum(min(data[yy*stride+xx*channels:yy*stride+xx*channels+3])>200 for yy in range(int(y),int(y+h)) for xx in range(int(x),int(x+w)))
        return good-bad if digit>5 else 0
    visible_today=until('today marker paints',lambda:(v:=today_ink())>10 and v)
    oracle('today is visibly marked by compositor',lambda v:v>10,visible_today,0)
    activate(FRONT)
    until('group expands',lambda:find(HEADER))
    before=[n.get_name() for n in history_cards()]
    # Only the rows near the window are built: a bounded tree, never 2000 cards.
    oracle('2000 expanded cards have a bounded visible tree',lambda v:0<len(v)<40,history_cards(),list(range(2000)))
    until('NC has keyboard focus',lambda:bar().get_state_set().contains(Atspi.StateType.ACTIVE))
    key(15)  # Tab
    for _ in range(12):key(109)  # Page Down
    until('viewport scrolls',lambda:[n.get_name() for n in history_cards()]!=before and not named('History 2000'))
    oracle('scroll changes visible rows only',lambda v:0<len(v)<40,history_cards(),list(range(2000)))
    stable_shot(LOG/'nc-scrolled.png')
    # Back to the newest row with Page Up.
    for _ in range(14):key(104)  # Page Up
    until('top restored',lambda:named('History 2000'))
    activate(HEADER)
    until('group collapsed before CC switch',lambda:find(FRONT))
    cc=next(n for n in children(bar()) if n.get_name()=='Control Center')
    r=box(cc);move(r[0]+r[2]/2,r[1]+r[3]/2);click(r[0]+r[2]/2,r[1]+r[3]/2)
    until('CC excludes NC',lambda:center() is None and any(n.get_name()=='Control Center' and n.get_role()==Atspi.Role.PANEL for n in children(bar())))
    open_clock();until('NC excludes CC',lambda:not any(n.get_name()=='Control Center' and n.get_role()==Atspi.Role.PANEL for n in children(bar())))
    normal=notify('Held in NC')
    until('ordinary reaches history',lambda:normal in ids(history()))
    oracle('NC suppresses ordinary banners but keeps history',lambda v:normal not in ids(v) and normal in ids(history()),banners(),[{'id':normal}])
    transient=notify('Transient while NC open',hints={'transient':GLib.Variant('b',True)})
    until('suppressed transient discarded',lambda:transient not in ids(history()))
    critical=notify('Critical while NC open',critical=True)
    until('NC critical exception',lambda:critical in ids(banners()))
    oracle('critical still has a banner over open NC',lambda v:critical in ids(v),banners(),[])
    stable_shot(LOG/'nc-critical.png')
    critical_box=box(node('Critical while NC open'))
    pix=GdkPixbuf.Pixbuf.new_from_file(str(LOG/'nc-critical.png'));pixels=pix.get_pixels();stride=pix.get_rowstride();channels=pix.get_n_channels()
    x,y,w,h=map(int,critical_box)
    painted=sum(min(pixels[yy*stride+xx*channels:yy*stride+xx*channels+3])>200 for yy in range(y+31,y+51) for xx in range(x+72,min(x+w-36,x+252)))
    oracle('critical banner content paints beside NC',lambda v:v>20,painted,0)
    # Close by outside click, then exercise the actual new CLI alias.
    move(20,300);click(20,300);until('outside closes NC',lambda:center() is None)
    cli=os.environ['NIDARA_IPC_BIN']
    subprocess.run([cli,'--session=rust','nc'],check=True,timeout=5,stdout=subprocess.DEVNULL)
    until('nidara-ipc nc opens',center)
    shell_state=call('org.nidara.Shell','/org/nidara/Shell','org.nidara.Shell1','GetState')
    oracle('Shell1 reports NC visibility',lambda s:any(n=='nc' and visible for n,visible in s[1]),shell_state,(False,[],''))
    close_escape()
    # A transient left visible by a renderer shutdown must not leak in daemon memory.
    transient=notify('Transient before reload',hints={'transient':GLib.Variant('b',True)})
    until('transient banner before reload',lambda:transient in ids(banners()))
    before_ids=set(ids(history()))-{transient}
    renderer.terminate();renderer.wait(timeout=5);PROCS.remove(renderer)
    renderer=start('shell-reloaded',[os.environ['NK_DOCK_BIN'],'--bar'],NK_ICON_METRICS='1')
    until('renderer reload ready',lambda:state()['available'])
    until('reload retires transient leftovers',lambda:transient not in ids(history()))
    oracle('shell restart preserves ordinary history without banners',lambda v:set(ids(v))==before_ids and not banners(),history(),[])
    open_clock();until('history after shell restart',lambda:find(FRONT))
    # The daemon restart restores fresh revisions and unknown senders. Invoke through AT-SPI.
    daemon.terminate();daemon.wait(timeout=5);PROCS.remove(daemon)
    until('owner loss',lambda:not state()['available'])
    daemon=start('daemon-reloaded',[os.environ['NK_SESSIOND_BIN'],'--config','--applications'],XDG_DATA_DIRS=str(data))
    until('new daemon snapshot',lambda:state()['available'])
    until('restored card actionable',lambda:find(FRONT))
    # Its action shows once its group is open and the card is shown whole.
    activate(FRONT);until('group opens',lambda:find(HEADER))
    more=until('card offers more',lambda:next((n for n in walk(card_of('History 2000')) if n.get_name()=='Show more'),None))
    more.get_action_iface().do_action(0);pump(.05)
    until('read button restored',lambda:find('Read'))
    activate('Read')
    until('restored action resolves missing sender',lambda:2000 not in ids(history()))
    oracle('restored action with real token resolves',lambda v:2000 not in ids(v),history(),[{'id':2000}])
    # Clear just the small live-sender group, leaving the 1999 archived records.
    until('live group clear is visible',lambda:find('Clear B3 fixture'))
    activate('Clear B3 fixture')
    until('group clear leaves other app',lambda:len(history())==1999)
    oracle('one group clear preserves other apps',lambda v:len(v)==1999 and all(n['app_name']=='Archive' for n in v),history(),[])
    new_id=archive('Archive replacement count')
    until('2000 before clear all',lambda:len(history())==2000)
    batches=[]
    BUS.signal_subscribe(None,'org.nidara.Notifications1','ResolvedBatch','/org/nidara/Notifications',None,Gio.DBusSignalFlags.NONE,lambda c,s,p,i,m,a,*_:batches.append(a.unpack()))
    rule="type='method_call',interface='org.nidara.Notifications1',member='DismissAll'"
    start('bulk-monitor',['stdbuf','-oL','dbus-monitor','--session',rule])
    until('bulk monitor ready',lambda:'NameAcquired' in (LOG/'bulk-monitor.log').read_text())
    journal=cache/'history.jsonl';before_bytes=journal.read_bytes();before_inode=journal.stat().st_ino
    started=time.monotonic();activate('Clear notifications')
    def emptied():
        pump(.02)
        return any(n.get_name()=='No notifications' for n in nodes(Atspi.Role.LABEL)) and time.monotonic()
    emptied_at=until('NC empty state',emptied)
    elapsed=emptied_at-started
    (LOG/'clear-timing.json').write_text(json.dumps({'start':started,'empty':emptied_at,'elapsed':elapsed}))
    until('2000 cleared',lambda:history()==[])
    backend_elapsed=time.monotonic()-started
    until('one private removal batch',lambda:len(batches)==1)
    pump(.25)
    oracle('2000 clear uses one bus call and one batch',lambda v:v==(1,1,2000),((LOG/'bulk-monitor.log').read_text().count('member=DismissAll'),len(batches),len(batches[0][0])),(2000,2000,1))
    after=journal.read_bytes()
    oracle('bulk removal appends one journal entry',lambda v:v[0] and v[1]==1 and v[2],(after.startswith(before_bytes),after[len(before_bytes):].count(b'\n'),journal.stat().st_ino==before_inode),(False,2000,False))
    # Only the cards in view leave, 45 ms apart: bounded by the view, never by the 2000.
    oracle('2000 clear has no row-count cascade',lambda v:v<2.,elapsed,90.)
    oracle('the cards leave before the list empties',lambda v:v>=0.15,elapsed,0.)
    stable_shot(LOG/'nc-empty.png')
    # One sender's over-limit record cannot disconnect the history stream.
    oversized=notify('x'*(1024*1024+1))
    after_limit=notify('After rejected over-limit record')
    until('stream continues after bounded rejection',lambda:find('After rejected over-limit record'))
    oracle('over-limit notice cannot stop later notifications',lambda v:v['available'] and v['historyCount']==1,state(),{'available':False,'historyCount':0})
    daemon.terminate();daemon.wait(timeout=5);PROCS.remove(daemon)
    until('oversized history owner loss',lambda:not state()['available'])
    daemon=start('daemon-bounded-reload',[os.environ['NK_SESSIOND_BIN'],'--config','--applications'],XDG_DATA_DIRS=str(data))
    until('snapshot skips over-limit record',lambda:state()['available'] and state()['historyCount']==1)
    oracle('over-limit history record cannot block hydration',lambda v:v['available'] and v['historyCount']==1,state(),{'available':False,'historyCount':0})
    private('DismissAll')
    until('clear bounded rejection fixture',lambda:history()==[])
    close_escape()
    (LOG/'report.json').write_text(json.dumps({'checks':REPORT,'clear_seconds':elapsed,'backend_seconds':backend_elapsed,'records':2000},indent=2))
    print('B3.2 NC PASSED',flush=True)
except Exception:
    try:
        (LOG/'failure-state.json').write_text(json.dumps(state(),indent=2))
        (LOG/'failure-layers.json').write_text(json.dumps(msg('layers'),indent=2))
        msg('screenshot',LOG/'failure.png')
        (LOG/'failure-tree.txt').write_text('\n'.join(f'{n.get_role_name()}: {n.get_name()}' for n in walk(bar())))
    except Exception:pass
    raise
finally:
    for p in reversed(EXTRA+PROCS):
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
