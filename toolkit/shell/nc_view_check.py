#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""The NC pilot on nk-view (NK_NC_VIEW=1, #1048): real wire, AT-SPI, pointer and keys, on a
disposable 300-record history. Run through check-nc-view-headless.sh."""
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
def find(prefix,role=Atspi.Role.BUTTON):return named(prefix,role)[0]
def act(n):n.get_action_iface().do_action(0);pump(.1)
def clock():return next(n for n in children(bar()) if n.get_role()==Atspi.Role.BUTTON and n.get_name()!='Control Center' and n.get_state_set().contains(Atspi.StateType.EXPANDABLE))
def open_clock():
    r=until('clock geometry configured',lambda:(r:=box(clock())) and r[0]>=0 and r[2]>0 and r[3]>0 and r);move(r[0]+r[2]/2,r[1]+r[3]/2);pump(.3);click(r[0]+r[2]/2,r[1]+r[3]/2);until('clock opens NC',center)
def key(code):
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write(f'key {code}\n')
    pump(.3)
def shot(name):
    pump(1.5)
    msg('screenshot',LOG/name)
def cards():
    # A card is a panel whose first button opens it: one pane per notification or group.
    return [p for p in nodes(Atspi.Role.PANEL) if any(b.get_role()==Atspi.Role.BUTTON for b in children(p))]
def inside(a,b):return a[0]>=b[0] and a[1]>=b[1] and a[0]+a[2]<=b[0]+b[2] and a[1]+a[3]<=b[1]+b[3]

try:
    now=int(time.time())
    records=[dict(id=i,app_name='Archive',app_icon='',summary=f'History {i}',body='Persisted before the renderer started.',expire_timeout=80,time=now-60,
                  hints={'desktop-entry':'b32-archive'},actions=[]) for i in range(1,301)]
    daemon,renderer,data=setup(records)
    live=notify('Live card',actions=('reply','Reply'))
    until('live reaches history',lambda:live in ids(history()))
    open_clock()
    until('cards built',lambda:len(cards())>=2)
    shot('pilot-open.png')
    # Separate cards: each card is its own panel, and no panel holds two cards.
    boxes=[box(p) for p in cards()]
    oracle('every card is a panel of its own',lambda bs:len(bs)>=2 and not any(i!=j and inside(a,b) for i,a in enumerate(bs) for j,b in enumerate(bs)),boxes,boxes+[[0,0,10**5,10**5]])
    widths={b[2] for b in boxes if b[2]>200 and b[3]<250}  # the clear pill is narrower by design
    oracle('cards share one width',lambda w:len(w)==1,widths,widths|{1})
    # The collapsed group fronts its newest, with its count.
    front=until('archive group front card',lambda:find('History 300, 300 notifications'))
    oracle('collapsed group builds only its front card',lambda v:len(v)==0,named('History 299'),[1])
    # Calendar: today is marked and the month navigates.
    today=until('today marked',lambda:find('Today, '))
    oracle('today is a disabled marker',lambda s:not s.contains(Atspi.StateType.ENABLED),today.get_state_set(),Atspi.StateSet.new([Atspi.StateType.ENABLED]))
    month=next(n.get_name() for n in nodes(Atspi.Role.LABEL) if any(ch.isdigit() for ch in n.get_name()) and len(n.get_name())>6)
    act(find('Next month'))
    until('calendar navigates',lambda:month not in [n.get_name() for n in nodes(Atspi.Role.LABEL)])
    oracle('another month has no today marker',lambda v:not v,named('Today, '),[1])
    act(find('Today'))
    until('calendar returns',lambda:named('Today, '))
    # The group opens to a header and its cards, built only near the window.
    act(front)
    header=until('group header',lambda:find('Archive, 300 notifications'))
    shot('pilot-group-open.png')
    built=named('History ')
    oracle('300 open cards build a bounded tree',lambda v:0<len(v)<40,built,list(range(300)))
    first=[n.get_name() for n in built]
    # Keyboard: focus the list, then page down far enough to need a rebuild.
    until('NC has keyboard focus',lambda:bar().get_state_set().contains(Atspi.StateType.ACTIVE))
    key(15)  # Tab
    for _ in range(12):key(109)  # Page Down
    until('viewport rebuilt further down',lambda:[n.get_name() for n in named('History ')]!=first and not named('History 300'))
    later=named('History ')
    oracle('scrolled list still builds a bounded tree',lambda v:0<len(v)<40,later,list(range(300)))
    shot('pilot-scrolled.png')
    for _ in range(14):key(104)  # Page Up
    until('top restored',lambda:named('History 300'))
    act(header)
    until('group folds',lambda:find('History 300, 300 notifications'))
    # Pointer: hover the live card, its close appears and a click dismisses it.
    card=next(p for p in cards() if any(n.get_name()=='Live card' for n in walk(p)))
    r=box(card);move(r[0]+r[2]/2,r[1]+r[3]/2);pump(.5)
    shot('pilot-hover.png')
    close=next(n for n in walk(card) if n.get_name()=='Close notification')
    c=box(close);click(c[0]+c[2]/2,c[1]+c[3]/2)
    until('close dismisses the live card',lambda:live not in ids(history()))
    oracle('pointer close removed only its card',lambda v:len(v)==300 and live not in ids(v),history(),history()+[{'id':live}])
    # Clear all: one bulk call, and the empty pill.
    act(find('Clear notifications'))
    until('history cleared',lambda:history()==[])
    until('empty state',lambda:any(n.get_name()=='No notifications' for n in nodes(Atspi.Role.LABEL)))
    oracle('cleared centre keeps only the calendar card',lambda v:len(v)==1,cards(),cards()*2)
    shot('pilot-empty.png')
    key(1)  # Escape
    until('Escape closes NC',lambda:center() is None)
    (LOG/'report.json').write_text(json.dumps({'checks':REPORT},indent=2))
    print('NC PILOT PASSED',flush=True)
except Exception:
    try:
        (LOG/'failure-state.json').write_text(json.dumps(state(),indent=2))
        msg('screenshot',LOG/'failure.png')
        (LOG/'failure-tree.txt').write_text('\n'.join(f'{n.get_role_name()}: {n.get_name()!r}' for n in nodes()))
    except Exception:pass
    raise
finally:
    for p in reversed(EXTRA+PROCS):
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
