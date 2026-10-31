#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A1 only: private bus, XDG trees and settings; no installed session contacted."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import threading
import gi
gi.require_version('Gio','2.0')
from gi.repository import Gio, GLib

NAME='org.nidara.Applications'
PATH='/org/nidara/Applications'
IFACE='org.nidara.Applications1'

class Portal:
    """Private Settings portal: ReadOne once per owner, live SettingChanged."""
    def __init__(self):
        self.theme='ThemeA';self.reads=0;self.ready=threading.Event()
        def run():
            ctx=GLib.MainContext.new();ctx.push_thread_default()
            self.bus=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
            info=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.portal.Settings"><method name="ReadOne"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method><signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal></interface></node>')
            def method(c,sender,path,iface,name,args,invocation):
                assert name=='ReadOne' and args.unpack()==('org.gnome.desktop.interface','icon-theme')
                self.reads+=1
                invocation.return_value(GLib.Variant('(v)',(GLib.Variant('s',self.theme),)))
            self.registration=self.bus.register_object('/org/freedesktop/portal/desktop',info.interfaces[0],method,None,None)
            self.loop=GLib.MainLoop.new(ctx,False);self.ready.set();self.loop.run()
            self.bus.unregister_object(self.registration);self.bus.close_sync(None);ctx.pop_thread_default()
        self.thread=threading.Thread(target=run);self.thread.start();assert self.ready.wait(5)
    def own(self,enabled):
        method='RequestName' if enabled else 'ReleaseName'
        args=GLib.Variant('(su)',('org.freedesktop.portal.Desktop',4)) if enabled else GLib.Variant('(s)',('org.freedesktop.portal.Desktop',))
        return self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus',method,args,None,Gio.DBusCallFlags.NONE,1000,None)
    def changed(self,theme,connection=None):
        self.theme=theme
        (connection or self.bus).emit_signal(None,'/org/freedesktop/portal/desktop','org.freedesktop.portal.Settings','SettingChanged',GLib.Variant('(ssv)',('org.gnome.desktop.interface','icon-theme',GLib.Variant('s',theme))))
    def close(self):
        self.loop.quit();self.thread.join(timeout=5);assert not self.thread.is_alive()

def inside(binary, out):
    out=Path(out)
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    second=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
    log=(out/'daemon.log').open('w')
    daemon=None
    portal=None
    def call(method,sig=None,args=(),client=None):
        return (client or bus).call_sync(NAME,PATH,IFACE,method,GLib.Variant(sig,args) if sig else None,None,Gio.DBusCallFlags.NO_AUTO_START,10000,None).unpack()
    def wait(f,label):
        until=time.monotonic()+12
        while True:
            try:
                value=f()
                if value:return value
            except GLib.Error:pass
            assert time.monotonic()<until,label
            while GLib.MainContext.default().pending():GLib.MainContext.default().iteration(False)
            time.sleep(.025)
    def fail(method,sig,args,code,client=None):
        try:call(method,sig,args,client)
        except GLib.Error as e:
            assert Gio.DBusError.get_remote_error(e).endswith('.'+code),(method,e)
            return
        raise AssertionError((method,'unexpected success'))
    def start(*flags):
        nonlocal daemon
        daemon=subprocess.Popen([binary,*flags],stdout=log,stderr=log)
    def stop():
        nonlocal daemon
        if daemon:
            daemon.terminate();daemon.wait(timeout=5);daemon=None
    def snap():
        e,r,state=call('GetSnapshot')
        if state['AppsNext']:call('CloseSnapshot','(ts)',(e,state['AppsNext']))
        return e,r,state
    def all_apps():
        e,r,s=call('GetSnapshot');apps=list(s['Apps']);token=s['AppsNext'];first=token
        while token:
            page,token=call('ReadSnapshotPage','(ts)',(e,token));apps.extend(page)
        if first:call('CloseSnapshot','(ts)',(e,first))
        return e,r,s,{a['DesktopId']:a for a in apps}
    def settings(k,v):subprocess.run(['gsettings','set','org.nidara.ai',k,str(v).lower()],check=True)
    appdir=Path(os.environ['XDG_DATA_DIRS'])/'applications'
    user=Path(os.environ['XDG_DATA_HOME'])/'applications'
    def desktop(root,id,name,extra=''):
        p=root/id;p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text('[Desktop Entry]\nType=Application\nName='+name+'\nExec=/usr/bin/true %U\nIcon='+str(out/'red.svg')+'\n'+extra)
        return p
    try:
        start()
        wait(lambda:bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',('org.nidara.Session',)),None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0],'notification daemon ready')
        assert not bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',(NAME,)),None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0]
        stop()
        # Competing Applications owner is never replaced or queued behind.
        reply=second.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',(NAME,4)),None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0]
        assert reply==1
        start('--applications');time.sleep(.1)
        owner=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetNameOwner',GLib.Variant('(s)',(NAME,)),None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0]
        assert owner==second.get_unique_name()
        stop()
        second.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName',GLib.Variant('(s)',(NAME,)),None,Gio.DBusCallFlags.NONE,1000,None)
        start('--applications')
        wait(lambda:bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',(NAME,)),None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0],'Applications owner ready')
        snap()  # Name publication must expose an already registered/hydrated object.
        e,r,s,apps=all_apps()
        assert s['CatalogueComplete'],s
        assert len(apps)>300,len(apps)
        assert 'Case.desktop' in apps and 'case.desktop' in apps
        assert not apps['NoExec.desktop']['EntryAvailable'] and not apps['NoExec.desktop']['Launchable']
        assert apps['DbusNoExec.desktop']['Launchable'] and apps['DbusNoExec.desktop']['DBusActivatable']
        assert 'Masked.desktop' not in apps and not apps['Hidden.desktop']['Visible']
        assert 'nested-Tool.desktop' in apps
        assert 'TryMissing.desktop' in apps and not apps['TryMissing.desktop']['EntryAvailable'] and not apps['TryMissing.desktop']['Visible']
        assert apps['Sample.desktop']['Origin']=='flatpak'
        assert [x['Key'] for x in s['Layout']]==['default-handler:inode/directory','app:Sample.desktop','app:Case.desktop'],s['Layout']
        def dock_get(key):
            return subprocess.run(['gsettings','get','org.nidara.dock',key],capture_output=True,text=True,check=True).stdout.strip()
        def dock_set(key,value):
            subprocess.run(['gsettings','set','org.nidara.dock',key,value],check=True)
        assert ast.literal_eval(dock_get('pinned'))==['pinned-Sample','deleted','Case']
        assert dock_get('layout-version')=='uint32 1'
        native_before=[x['Key'] for x in s['Layout']]
        # A simulated TS writer sees only bare IDs and cannot overwrite native order.
        dock_set('pinned',"['case']")
        time.sleep(.25)
        assert [x['Key'] for x in snap()[2]['Layout']]==native_before
        assert ast.literal_eval(dock_get('pinned'))==['case']
        assert apps['Sample.desktop']['Launchable'] and not apps['Sample.desktop']['IsNew']
        fail('ResolveWindow','(tst)',(e,'private',1),'Unavailable')
        fail('AcknowledgeNew','(tas)',(e,['Sample.desktop']),'AccessDenied')
        # Hidden list filtering, accent folding, no full-Exec argument matching.
        rev=s['CatalogueRevision']
        _,hits=call('Search','(tts ub)'.replace(' ',''),(e,rev,'configuracion',10,False))
        assert hits[0]['DesktopId']=='Sample.desktop',hits
        _,hits=call('Search','(ttsub)',(e,rev,'',100,False));assert all(a['Visible'] for a in hits)
        _,hits=call('Search','(ttsub)',(e,rev,'hidden',10,True));assert hits[0]['DesktopId']=='Hidden.desktop'
        _,hits=call('Search','(ttsub)',(e,rev,'secret-flag-never-search',10,False));assert hits==[]
        fail('Search','(ttsub)',(e,rev,'a',101,False),'Invalid')
        # Snapshot pages are immutable, bounded, idempotent and caller-bound.
        _,_,page_state=call('GetSnapshot');token=page_state['AppsNext'];assert token
        p1,n1=call('ReadSnapshotPage','(ts)',(e,token));p2,n2=call('ReadSnapshotPage','(ts)',(e,token));assert (p1,n1)==(p2,n2) and len(p1)<=256
        fail('ReadSnapshotPage','(ts)',(e,token),'Stale',second)
        desktop(appdir,'Added.desktop','Added')
        wait(lambda: 'Added.desktop' in all_apps()[3],'catalogue watch sees new entry')
        assert call('ReadSnapshotPage','(ts)',(e,token))==(p1,n1)
        call('CloseSnapshot','(ts)',(e,token));fail('ReadSnapshotPage','(ts)',(e,token),'Stale')
        fail('Search','(ttsub)',(e,rev,'a',10,False),'Stale')
        # A generic interpreter stays External; a claimed Settings name grants nothing.
        bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.nidara.SettingsNative',4)),None,Gio.DBusCallFlags.NONE,1000,None)
        _,_,s,apps=all_apps()
        edit={'Operation':GLib.Variant('s','insert-app'),'DesktopId':GLib.Variant('s','Added.desktop')}
        fail('EditLayout','(tta{sv})',(e,s['LayoutRevision'],edit),'AccessDenied')
        settings('allow-computer-control',True);settings('allow-config-write',False)
        fail('EditLayout','(tta{sv})',(e,s['LayoutRevision'],edit),'AccessDenied')
        settings('allow-config-write',True)
        def pin():
            nonlocal s
            _,_,s,_=all_apps()
            try:return call('EditLayout','(tta{sv})',(e,s['LayoutRevision'],edit))
            except GLib.Error as error:
                if Gio.DBusError.get_remote_error(error).endswith('.AccessDenied'):return False
                raise
        lr,rows=wait(pin,'consent reaches GLib owner')
        assert rows[-1]['Key']=='app:Added.desktop'
        lr2,_=call('EditLayout','(tta{sv})',(e,lr,edit));assert lr2==lr
        fail('EditLayout','(tta{sv})',(e,lr-1,edit),'Conflict')
        bad=dict(edit);bad['Unexpected']=GLib.Variant('s','ignored?');fail('EditLayout','(tta{sv})',(e,lr,bad),'Invalid')
        folder=out/'a folder';folder.mkdir()
        lr,rows=call('EditLayout','(tta{sv})',(e,lr,{'Operation':GLib.Variant('s','insert-folder'),'Uri':GLib.Variant('s',folder.as_uri())}))
        assert rows[-1]['Kind']=='folder'
        # Healthy uninstall removes a pin; lost root must preserve it, including restart.
        saved=appdir.with_name('applications-offline');appdir.rename(saved)
        wait(lambda:not snap()[2]['CatalogueComplete'],'provider/root outage degrades catalogue')
        assert 'app:Added.desktop' in [x['Key'] for x in snap()[2]['Layout']]
        stop();start('--applications');wait(snap,'restart during outage')
        e2,_,s2,_=all_apps();assert e2!=e and not s2['CatalogueComplete']
        assert 'app:Added.desktop' in [x['Key'] for x in s2['Layout']]
        fail('EditLayout','(tta{sv})',(e,s2['LayoutRevision'],edit),'Stale')
        saved.rename(appdir)
        wait(lambda:snap()[2]['CatalogueComplete'],'root recovery')
        previous_gen=all_apps()[3]['Added.desktop']['Generation']
        (appdir/'Added.desktop').unlink()
        wait(lambda:'app:Added.desktop' not in [x['Key'] for x in snap()[2]['Layout']],'healthy uninstall prunes pin')
        desktop(appdir,'Added.desktop','Recreated')
        wait(lambda:all_apps()[3].get('Added.desktop',{}).get('Generation',0)>previous_gen,'recreated ID has a fresh generation')
        e=e2;_,_,s,apps=all_apps();sample=apps['Sample.desktop'];g=sample['Generation']
        token,w,h,rgba=call('GetIcon','(tstud)',(e,'Sample.desktop',g,32,1.25))
        assert (w,h)==(40,40) and len(rgba)==w*h*4 and token.startswith('asset:'),(token,w,h,len(rgba))
        assert any(rgba[i]>200 and rgba[i+1]<20 for i in range(0,len(rgba),4))
        fail('GetIcon','(tstud)',(e,'Sample.desktop',g,512,float('nan')),'Invalid')
        # Actual SVG text goes through resvg/fontdb, not monochrome icon shapes.
        token,w,h,rgba=call('GetIcon','(tstud)',(e,'Text.desktop',apps['Text.desktop']['Generation'],64,1.0));assert token.startswith('asset:') and any(rgba[i] for i in range(3,len(rgba),4))
        portal=Portal();portal.own(True)
        pg=apps['Portal.desktop']['Generation']
        def portal_color(color):
            _,w,h,pixels=call('GetIcon','(tstud)',(e,'Portal.desktop',pg,32,1.0))
            return pixels[(h//2*w+w//2)*4+color]>200
        wait(lambda:portal_color(0),'initial portal ReadOne selects red theme')
        assert portal.reads==1
        ir=snap()[2]['IconRevision']
        theme_asset=Path(os.environ['XDG_DATA_HOME'])/'icons/ThemeA/32x32/apps/portal-test.svg'
        theme_asset.write_text((out/'blue.svg').read_text())
        wait(lambda:snap()[2]['IconRevision']>ir and portal_color(2),'asset monitor changes icon without polling')
        theme_asset.write_text((out/'red.svg').read_text())
        wait(lambda:portal_color(0),'asset restoration event')
        portal.changed('ThemeB')
        wait(lambda:portal_color(2),'SettingChanged selects blue without read polling')
        time.sleep(.25);assert portal.reads==1
        portal.changed('ThemeA',second) # wrong sender cannot select a theme
        time.sleep(.25);assert portal_color(2) and portal.reads==1
        portal.own(False)
        wait(lambda:call('GetIcon','(tstud)',(e,'Portal.desktop',pg,32,1.0))[0].startswith('fallback-v1:'),'portal loss uses fallback')
        portal.own(True)
        wait(lambda:portal.reads==2 and portal_color(0),'portal owner return performs one read')
        source={'Kind':GLib.Variant('s','file'),'Value':GLib.Variant('s',(out/'blue.svg').as_uri())}
        call('SetIconOverride','(tsta{sv})',(e,'Sample.desktop',g,source))
        token,w,h,rgba=call('GetIcon','(tstud)',(e,'Sample.desktop',g,32,1.0));assert rgba[(h//2*w+w//2)*4+2]>200
        call('ResetIconOverride','(tst)',(e,'Sample.desktop',g))
        # Restoring an app override retains an existing shared raw-icon override.
        _,_,_,current=all_apps();tg=current['Themed.desktop']['Generation']
        call('SetIconOverride','(tsta{sv})',(e,'Themed.desktop',tg,source))
        call('ResetIconOverride','(tst)',(e,'Themed.desktop',tg))
        legacy=Path(os.environ['XDG_DATA_HOME'])/'icons/nidara/scalable/apps/org.example.Color.svg'
        assert legacy.exists()
        _,w,h,pixels=call('GetIcon','(tstud)',(e,'Themed.desktop',tg,32,1.0));assert pixels[(h//2*w+w//2)*4]>200
        # Refuse a parent symlink on both writes and resets, before touching its target.
        per_app=legacy.parents[2]/'per-app';real=per_app.with_name('per-app-real');per_app.rename(real)
        outside=out/'outside-icons';outside.mkdir();per_app.symlink_to(outside,target_is_directory=True)
        fail('SetIconOverride','(tsta{sv})',(e,'Sample.desktop',g,source),'AccessDenied')
        fail('ResetIconOverride','(tst)',(e,'Sample.desktop',g),'AccessDenied')
        assert list(outside.iterdir())==[]
        per_app.unlink();real.rename(per_app)
        settings('allow-computer-control',False)
        wait(lambda:subprocess.run(['gsettings','get','org.nidara.ai','allow-computer-control'],capture_output=True,text=True).stdout.strip()=='false','revoked setting')
        def revoked():
            try:call('EditLayout','(tta{sv})',(e,0,edit))
            except GLib.Error as error:return Gio.DBusError.get_remote_error(error).endswith('.AccessDenied')
            raise AssertionError('zero revision unexpectedly accepted')
        wait(revoked,'revocation reaches the effect owner')
        fail('SetIconOverride','(tsta{sv})',(e,'Sample.desktop',g,source),'AccessDenied')
        # Old app generation refuses after content replacement; deletion/recreation never reuses it.
        desktop(user,'Sample.desktop','Changed','X-Flatpak=org.example.App\n')
        wait(lambda:all_apps()[3]['Sample.desktop']['Generation']!=g,'entry generation changes')
        fail('GetIcon','(tstud)',(e,'Sample.desktop',g,32,1.0),'Stale')
        assert ast.literal_eval(dock_get('pinned'))==['case']
        # An intentionally empty native v1 layout survives TS edits and restart.
        dock_set('layout','[]')
        wait(lambda:snap()[2]['Layout']==[],'native empty layout')
        settings('allow-computer-control',True)
        stop();start('--applications');wait(snap,'restart with empty layout')
        assert snap()[2]['Layout']==[] and ast.literal_eval(dock_get('pinned'))==['case']
        dock_set('layout-version','2')
        wait(lambda:not snap()[2]['LayoutAvailable'],'future native version read-only')
        fe,_,fs=snap()
        fail('EditLayout','(tta{sv})',(fe,fs['LayoutRevision'],edit),'Unavailable')
        assert dock_get('layout-version')=='uint32 2' and ast.literal_eval(dock_get('pinned'))==['case']
        print('PASS Applications1: opt-in/name conflict, XDG precedence/case/hidden/nested IDs, >300 apps + caller-bound immutable pages, search tiers, canonical layout migration/CAS/folder, consent+revocation, root outage+restart retention and healthy-only pruning, PNG/RGBA/SVG text + overrides, stale epochs/generations, TS/native key isolation+empty restart+future version, portal ReadOne/signals/owner/spoof; no launches or live session')
    finally:
        stop();log.close();second.close_sync(None)
        if portal:portal.close()

def idle(binary, out, seconds):
    """No client traffic during the interval; same private catalogue as the fixture."""
    out=Path(out)
    binary_hash=hashlib.sha256(Path(binary).read_bytes()).hexdigest()
    with (out/'daemon.log').open('w') as log:
        daemon=subprocess.Popen([binary,'--applications'],stdout=log,stderr=log)
        try:
            bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
            for _ in range(200):
                try:
                    _,_,state=bus.call_sync(NAME,PATH,IFACE,'GetSnapshot',None,None,Gio.DBusCallFlags.NO_AUTO_START,1000,None).unpack()
                    break
                except GLib.Error:time.sleep(.025)
            else:raise AssertionError('idle service not ready')
            time.sleep(3) # let startup/watch changes settle before sampling
            def sample():
                stat=Path(f'/proc/{daemon.pid}/stat').read_text().rsplit(')',1)[1].split()
                switches={}
                for task in Path(f'/proc/{daemon.pid}/task').iterdir():
                    count=0
                    try:
                        for line in (task/'status').read_text().splitlines():
                            if line.startswith(('voluntary_ctxt_switches:','nonvoluntary_ctxt_switches:')):
                                count+=int(line.split()[1])
                        switches[task.name]=count
                    except FileNotFoundError:pass
                return int(stat[11])+int(stat[12]),switches
            before=sample();start=time.monotonic();time.sleep(seconds)
            after=sample();elapsed=time.monotonic()-start
            result=dict(seconds=elapsed,cpu_seconds=(after[0]-before[0])/os.sysconf('SC_CLK_TCK'),context_switches_surviving_threads=sum(after[1][tid]-before[1][tid] for tid in before[1].keys() & after[1].keys()),threads_exited=len(before[1].keys()-after[1].keys()),threads_started=len(after[1].keys()-before[1].keys()),binary=str(binary),binary_sha256=binary_hash,first_page_apps=len(state['Apps']))
            result['cpu_percent_one_core']=100*result['cpu_seconds']/elapsed
            (out/'idle.json').write_text(json.dumps(result,indent=2)+'\n')
            print(json.dumps(result))
        finally:daemon.terminate();daemon.wait(timeout=5)

def outer(binary, idle_seconds=None, driver=None, setup=None):
    repo=Path(__file__).resolve().parents[2]
    out=repo/'target/applications1'/str(time.time_ns());out.mkdir(parents=True)
    for directory in ['home','data/applications','system/share/applications','config','state','cache','schemas']:(out/directory).mkdir(parents=True,exist_ok=True)
    shutil.copy(repo/'config/gsettings/org.nidara.gschema.xml',out/'schemas')
    subprocess.run(['glib-compile-schemas',str(out/'schemas')],check=True)
    red='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'
    (out/'red.svg').write_text(red);(out/'blue.svg').write_text(red.replace('red','blue'))
    (out/'text.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text x="2" y="45" font-family="DejaVu Sans" font-size="40" fill="red">Aa</text></svg>')
    appdir=out/'system/share/applications';user=out/'data/applications'
    def desktop(root,id,name,extra=''):
        p=root/id;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('[Desktop Entry]\nType=Application\nName='+name+'\nExec=/usr/bin/true %U\nIcon='+str(out/'red.svg')+'\n'+extra)
    (appdir/'NoExec.desktop').write_text('[Desktop Entry]\nType=Application\nName=No Exec\nNoDisplay=true\n')
    (appdir/'DbusNoExec.desktop').write_text('[Desktop Entry]\nType=Application\nName=D-Bus No Exec\nDBusActivatable=true\n')
    for i in range(310):desktop(appdir,f'Fixture{i:03d}.desktop',f'Fixture {i:03d}')
    for id in ['Case.desktop','case.desktop','Sample.desktop','Masked.desktop']:desktop(appdir,id,id)
    desktop(appdir,'TryMissing.desktop','Try Missing','TryExec=/nonexistent/nidara-a1-binary\n')
    desktop(appdir,'Hidden.desktop','Hidden','NoDisplay=true\n');desktop(appdir,'nested/Tool.desktop','Nested Tool')
    desktop(user,'Masked.desktop','Masked','Hidden=true\n')
    desktop(user,'Sample.desktop','Configuración','X-Flatpak=org.example.App\nKeywords=configuracion;settings;\nStartupWMClass=Sample\nExec=/usr/bin/true --secret-flag-never-search %U\n')
    desktop(appdir,'Portal.desktop','Portal','Icon=portal-test\n')
    for theme,color in [('ThemeA','red'),('ThemeB','blue')]:
        root=out/'data/icons'/theme
        if theme=='ThemeA':
            real=out/'theme-assets/ThemeA';real.mkdir(parents=True)
            (root/'32x32').mkdir(parents=True)
            (root/'32x32/apps').symlink_to(real,target_is_directory=True)
            (real/'cycle').symlink_to(root,target_is_directory=True)
        else:(root/'32x32/apps').mkdir(parents=True)
        (root/'index.theme').write_text('[Icon Theme]\nName='+theme+'\nDirectories=32x32/apps\n[32x32/apps]\nSize=32\nType=Fixed\n')
        (root/'32x32/apps/portal-test.svg').write_text(red.replace('red',color))
    desktop(appdir,'Themed.desktop','Themed','Icon=org.example.Color\n')
    legacy=out/'data/icons/nidara/scalable/apps/org.example.Color.svg';legacy.parent.mkdir(parents=True);legacy.write_text(red)
    desktop(appdir,'Text.desktop','Text');p=appdir/'Text.desktop';p.write_text(p.read_text().replace(str(out/'red.svg'),str(out/'text.svg')))
    with tempfile.TemporaryDirectory(prefix='napp-') as rt:
        address='unix:path='+rt+'/bus'
        env=dict(os.environ,HOME=str(out/'home'),XDG_DATA_HOME=str(out/'data'),XDG_DATA_DIRS=str(out/'system/share'),XDG_CONFIG_HOME=str(out/'config'),XDG_STATE_HOME=str(out/'state'),XDG_CACHE_HOME=str(out/'cache'),XDG_RUNTIME_DIR=rt,DBUS_SESSION_BUS_ADDRESS=address,DBUS_SYSTEM_BUS_ADDRESS='unix:path='+rt+'/no-system-bus',GSETTINGS_BACKEND='keyfile',GSETTINGS_SCHEMA_DIR=str(out/'schemas'),XDG_CURRENT_DESKTOP='Nidara')
        env.pop('HYALO_SOCKET',None);env.pop('WAYLAND_DISPLAY',None)
        env['GIO_USE_VFS']='local'
        config=out/'bus.xml'
        if setup:setup(out,env)
        services='<servicedir>'+str(out/'services')+'</servicedir>' if driver else ''
        config.write_text('<busconfig><type>session</type><listen>'+address+'</listen><auth>EXTERNAL</auth>'+services+'<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
        bus=subprocess.Popen(['dbus-daemon','--nofork','--config-file='+str(config)],env=env,stdout=subprocess.DEVNULL)
        try:
            for _ in range(100):
                if Path(rt+'/bus').exists():break
                time.sleep(.01)
            subprocess.run(['gsettings','set','org.nidara.dock','pinned',"['pinned-Sample','deleted','Case']"],env=env,check=True)
            result=subprocess.run(['/usr/bin/python3',driver or __file__,'--idle-inside' if idle_seconds else '--inside',str(Path(binary).resolve()),str(out)]+([str(idle_seconds)] if idle_seconds else []),env=env)
            if result.returncode:print((out/'daemon.log').read_text(),file=sys.stderr)
            print('Evidence:',out)
            return result.returncode
        finally:bus.terminate();bus.wait(timeout=5)
if __name__=='__main__':
    if sys.argv[1]=='--inside':inside(sys.argv[2],sys.argv[3])
    elif sys.argv[1]=='--idle-inside':idle(sys.argv[2],sys.argv[3],float(sys.argv[4]))
    elif sys.argv[1]=='--idle':sys.exit(outer(sys.argv[2],float(sys.argv[3])))
    else:sys.exit(outer(sys.argv[1]))
