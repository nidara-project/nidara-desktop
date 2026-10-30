#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A1 only: private bus, XDG trees and settings; no installed session contacted."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import gi
gi.require_version('Gio','2.0')
from gi.repository import Gio, GLib

NAME='org.nidara.Applications'
PATH='/org/nidara/Applications'
IFACE='org.nidara.Applications1'

def inside(binary, out):
    out=Path(out)
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    second=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
    log=(out/'daemon.log').open('w')
    daemon=None
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
        start('--applications');wait(snap,'Applications1 ready')
        e,r,s,apps=all_apps()
        assert s['CatalogueComplete'],s
        assert len(apps)>300,len(apps)
        assert 'Case.desktop' in apps and 'case.desktop' in apps
        assert 'Masked.desktop' not in apps and not apps['Hidden.desktop']['Visible']
        assert 'nested-Tool.desktop' in apps
        assert 'TryMissing.desktop' in apps and not apps['TryMissing.desktop']['EntryAvailable'] and not apps['TryMissing.desktop']['Visible']
        assert apps['Sample.desktop']['Origin']=='flatpak'
        assert [x['Key'] for x in s['Layout']]==['default-handler:inode/directory','app:Sample.desktop','app:Case.desktop'],s['Layout']
        assert not apps['Sample.desktop']['Launchable'] and not apps['Sample.desktop']['IsNew']
        for method,sig,args in [('Launch','(tsta{sv})',(e,'Sample.desktop',apps['Sample.desktop']['Generation'],{})),('ResolveWindow','(tst)',(e,'private',1)),('AcknowledgeNew','(tas)',(e,['Sample.desktop']))]:fail(method,sig,args,'Unavailable')
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
        print('PASS Applications1: opt-in/name conflict, XDG precedence/case/hidden/nested IDs, >300 apps + caller-bound immutable pages, search tiers, canonical layout migration/CAS/folder, consent+revocation, root outage+restart retention and healthy-only pruning, PNG/RGBA/SVG text + overrides, stale epochs/generations; no launches or live session')
    finally:
        stop();log.close();second.close_sync(None)

def outer(binary):
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
    for i in range(310):desktop(appdir,f'Fixture{i:03d}.desktop',f'Fixture {i:03d}')
    for id in ['Case.desktop','case.desktop','Sample.desktop','Masked.desktop']:desktop(appdir,id,id)
    desktop(appdir,'TryMissing.desktop','Try Missing','TryExec=/nonexistent/nidara-a1-binary\n')
    desktop(appdir,'Hidden.desktop','Hidden','NoDisplay=true\n');desktop(appdir,'nested/Tool.desktop','Nested Tool')
    desktop(user,'Masked.desktop','Masked','Hidden=true\n')
    desktop(user,'Sample.desktop','Configuración','X-Flatpak=org.example.App\nKeywords=configuracion;settings;\nStartupWMClass=Sample\nExec=/usr/bin/true --secret-flag-never-search %U\n')
    desktop(appdir,'Themed.desktop','Themed','Icon=org.example.Color\n')
    legacy=out/'data/icons/nidara/scalable/apps/org.example.Color.svg';legacy.parent.mkdir(parents=True);legacy.write_text(red)
    desktop(appdir,'Text.desktop','Text');p=appdir/'Text.desktop';p.write_text(p.read_text().replace(str(out/'red.svg'),str(out/'text.svg')))
    with tempfile.TemporaryDirectory(prefix='napp-') as rt:
        address='unix:path='+rt+'/bus'
        env=dict(os.environ,HOME=str(out/'home'),XDG_DATA_HOME=str(out/'data'),XDG_DATA_DIRS=str(out/'system/share'),XDG_CONFIG_HOME=str(out/'config'),XDG_STATE_HOME=str(out/'state'),XDG_CACHE_HOME=str(out/'cache'),XDG_RUNTIME_DIR=rt,DBUS_SESSION_BUS_ADDRESS=address,DBUS_SYSTEM_BUS_ADDRESS='unix:path='+rt+'/no-system-bus',GSETTINGS_BACKEND='keyfile',GSETTINGS_SCHEMA_DIR=str(out/'schemas'),XDG_CURRENT_DESKTOP='Nidara')
        env.pop('HYALO_SOCKET',None);env.pop('WAYLAND_DISPLAY',None)
        env['GIO_USE_VFS']='local'
        config=out/'bus.xml'
        config.write_text('<busconfig><type>session</type><listen>'+address+'</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
        bus=subprocess.Popen(['dbus-daemon','--nofork','--config-file='+str(config)],env=env,stdout=subprocess.DEVNULL)
        try:
            for _ in range(100):
                if Path(rt+'/bus').exists():break
                time.sleep(.01)
            subprocess.run(['gsettings','set','org.nidara.dock','pinned',"['pinned-Sample','deleted','Case']"],env=env,check=True)
            result=subprocess.run(['/usr/bin/python3',__file__,'--inside',str(Path(binary).resolve()),str(out)],env=env)
            if result.returncode:print((out/'daemon.log').read_text(),file=sys.stderr)
            print('Evidence:',out)
            return result.returncode
        finally:bus.terminate();bus.wait(timeout=5)
if __name__=='__main__':
    if sys.argv[1]=='--inside':inside(sys.argv[2],sys.argv[3])
    else:sys.exit(outer(sys.argv[1]))
