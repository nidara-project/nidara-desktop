#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private Spanish AT-SPI names/descriptions and capacity-message check."""
from notification_fixture import *
os.environ['LANG']='es_ES.UTF-8'
S=json.loads((Path(os.environ['NK_SETTINGS_DATA'])/'i18n/es.json').read_text())
EN=json.loads((Path(os.environ['NK_SETTINGS_DATA'])/'i18n/en.json').read_text())
def walk(n):
    yield n
    for child in children(n):yield from walk(child)
def panel():return next(n for n in children(bar()) if n.get_role()==Atspi.Role.PANEL and n.get_name()=='Control Center')
def nodes():return list(walk(panel()))
def find(name):return next(n for n in nodes() if n.get_name()==name)
def activate(name):
    n=until(name,lambda:find(name));assert n.get_action_iface().do_action(0);pump(.4)
try:
    bindir=RUN/'bin';bindir.mkdir();(bindir/'cliphist').symlink_to(REPO/'toolkit/shell/cc_edit_helpers.py')
    os.environ['PATH']=str(bindir)+os.pathsep+os.environ['PATH']
    os.environ['NK_CC_CLIP_STATE']=str(RUN/'clips.json');(RUN/'clips.json').write_text('[]')
    os.environ['NK_CC_CLIP_LOG']=str(LOG/'clip-actions.jsonl')
    daemon,renderer,data=setup()
    button=next(n for n in children(bar()) if n.get_name()=='Control Center');x,y,w,h=box(button)
    move(x+w/2,y+h/2);click(x+w/2,y+h/2);until('CC',panel)
    activate(S['cc.grid.edit']);until('edit',lambda:find(S['cc.grid.done']))
    oracle('Spanish edit description',lambda v:v==S['cc.grid.mode'],panel().get_description(),'Edit mode')
    target=until('Spanish screenshot tile',lambda:find(S['widget.screenshot.name']))
    a=target.get_action_iface();indices={a.get_action_name(i):i for i in range(a.get_n_actions())}
    for stable,key in [('Move up','cc.action.move-up'),('Move down','cc.action.move-down'),('Move left','cc.action.move-left'),('Move right','cc.action.move-right'),('Resize','cc.action.resize'),('Remove','cc.menu.remove')]:
        index=indices[stable]
        observed=(a.get_action_name(index),a.get_localized_name(index),a.get_action_description(index))
        expected=(stable,S[key],S[key]);oracle('Spanish reader action '+stable,lambda v:v==expected,observed,(stable,stable,stable))
    fixture={'media':(0,0,'2x2'),'focus':(2,0,'2x2'),'night_light':(0,2,'2x2'),'dark_mode':(2,2,'2x2'),'screenrecord':(0,4,'2x2'),'cpu_memory':(2,4,'2x2'),'volume':(0,6,'4x1'),'screenshot':(0,7,'1x1'),'clipboard':(1,7,'2x1')}
    cc=Gio.Settings.new('org.nidara.control-center');cc.delay()
    cc.set_value('positions',GLib.Variant('a{s(ii)}',{k:v[:2] for k,v in fixture.items()}));cc.set_value('sizes',GLib.Variant('a{ss}',{k:v[2] for k,v in fixture.items()}));cc.apply()
    Gio.Settings.new('org.nidara.widgets').set_value('placement',GLib.Variant('a{s(bb)}',{k:(False,k in fixture) for k in ['battery','bt','brightness','clipboard','cpu_memory','dark_mode','ethernet','focus','media','night_light','screenrecord','screenshot','volume','vpn','wifi']}));Gio.Settings.sync();pump(.5)
    target=find(S['widget.screenshot.name']);assert target.get_component_iface().grab_focus();pump(.4)
    a=target.get_action_iface();index=next(i for i in range(a.get_n_actions()) if a.get_action_name(i)=='Resize');assert a.do_action(index)
    large=until('Spanish size menu',lambda:find(S['cc.menu.size.large']))
    observed=(large.get_description(),large.get_state_set().contains(Atspi.StateType.ENABLED))
    oracle('Spanish capacity refusal reuses existing key',lambda v:v==(S['cc.menu.size-full'],False),observed,('Grid is full',True))
    error_keys=['cc.grid.write-read-only','cc.grid.write-changed','cc.grid.write-failed']
    oracle('write error keys translated in Spanish',lambda v:all(v[k] and v[k]!=EN[k] for k in error_keys),{k:S[k] for k in error_keys},{k:EN[k] for k in error_keys})
    pump(1.5);msg('screenshot',LOG/'spanish-size-menu.png')
    with open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:pipe.write('key 1\n')
    pump(.4)
    media=find(S['cc.media.name']);assert media.get_component_iface().grab_focus();pump(.3)
    actions=media.get_action_iface();index=next(i for i in range(actions.get_n_actions()) if actions.get_action_name(i)=='Move down');assert actions.do_action(index)
    alert=until('Spanish capacity alert',lambda:next(n for n in nodes() if n.get_role()==Atspi.Role.ALERT))
    oracle('Spanish capacity alert is localized',lambda v:v==S['cc.menu.size-full'],alert.get_name(),'Grid is full')
    pump(1.5);msg('screenshot',LOG/'spanish-capacity-alert.png')
    (LOG/'report.json').write_text(json.dumps(REPORT,indent=2));print('B2.3 SPANISH PASSED',flush=True)
finally:
    for p in reversed(PROCS):
        if p.poll() is None:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
