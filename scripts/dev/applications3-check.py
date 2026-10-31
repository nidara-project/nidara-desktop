#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A3: real private D-Bus/Unity, fake coherent H1 and fake systemd, no live session."""
import importlib.util,json,os,socket,subprocess,sys,threading,time
from pathlib import Path
import gi
gi.require_version('Gio','2.0')
from gi.repository import Gio,GLib
HERE=Path(__file__).resolve()
spec=importlib.util.spec_from_file_location('a2',HERE.with_name('applications2-check.py'));a2=importlib.util.module_from_spec(spec);spec.loader.exec_module(a2)
NAME=a2.NAME;PATH=a2.PATH;IFACE=a2.IFACE
class Hyalo:
    def __init__(self,path):
        self.path=path;self.lock=threading.RLock();self.subs=[];self.connections=[];self.stop=False;self.allow=True;self.serial=0;self.run=7;self.now=int(time.monotonic()*1e6)+1000000;self.number=0;self.early=True;self.seen=[]
        self.flags=dict(locked=False,idle=False,session_active=True,sleeping=False)
        self.windows=[dict(id=1,app_id='Files',initial_app_id='Files',focused=True,visible=True,minimized=False)]
        self.server=socket.socket(socket.AF_UNIX);self.server.bind(path);self.server.listen();self.server.settimeout(.1)
        def accept():
            while not self.stop:
                try:c,_=self.server.accept()
                except socket.timeout:continue
                except OSError:return
                self.connections.append(c);threading.Thread(target=self.client,args=(c,),daemon=True).start()
        self.thread=threading.Thread(target=accept);self.thread.start()
    def stamp(self,v):return dict(v,epoch=self.run,serial=self.serial,time_us=self.now)
    def snapshot(self):return self.stamp(dict(event='snapshot',windows=self.windows,workspaces=[],focus=next((w['id'] for w in self.windows if w['focused']),None),idle_since_us=self.now,**self.flags))
    def write(self,c,v):c.sendall((json.dumps(v)+'\n').encode())
    def client(self,c):
        try:
            f=c.makefile('rb')
            for line in f:
                r=json.loads(line)
                with self.lock:
                    if r['request']=='event_stream':
                        if not self.allow:return
                        self.write(c,{'ok':{'kind':'handled'}});self.write(c,self.snapshot());self.subs.append(c);return
                    if r['request']=='observe_launch':
                        self.number+=1;n=self.number;self.seen.append(n)
                        if self.early:self.emit(dict(event='launch_outcome',launch=n,outcome='activated',window=1))
                        self.write(c,{'ok':dict(kind='launch_observed',launch=n,already=None)})
                    else:self.write(c,{'error':'unsupported fake request'})
        except (OSError,ValueError):pass
    def emit(self,event,seconds=0,skip=0):
        with self.lock:
            self.now+=int(seconds*1e6)+1;self.serial+=1+skip;alive=[]
            for c in self.subs:
                try:self.write(c,self.stamp(event));alive.append(c)
                except OSError:pass
            self.subs=alive
    def focus(self,id,seconds=0):
        with self.lock:
            for w in self.windows:w['focused']=w['id']==id
            app=next((w['app_id'] for w in self.windows if w['id']==id),None)
            self.emit(dict(event='focus_transition',id=id,app_id=app),seconds)
    def window_list(self,seconds=0):self.emit(dict(event='windows_changed',windows=self.windows),seconds)
    def close(self):
        self.stop=True;self.server.close()
        for c in self.connections:
            try:c.shutdown(socket.SHUT_RDWR);c.close()
            except OSError:pass
        self.thread.join(timeout=3)
def setup(out,env):
    a2.setup(out,env);env['HYALO_SOCKET']=str(Path(env['XDG_RUNTIME_DIR'])/'a3.sock')
def inside(binary,out):
    out=Path(out);h=Hyalo(os.environ['HYALO_SOCKET']);services=a2.Services(out);daemon=None
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None);senders=[]
    def call(method,sig=None,args=()):return bus.call_sync(NAME,PATH,IFACE,method,GLib.Variant(sig,args) if sig else None,None,Gio.DBusCallFlags.NO_AUTO_START,10000,None).unpack()
    def wait(f,label):
        end=time.monotonic()+15
        while time.monotonic()<end:
            try:
                r=f()
                if r:return r
            except GLib.Error:pass
            time.sleep(.02)
        raise AssertionError(label)
    def snap():
        e,r,s=call('GetSnapshot');apps=list(s['Apps']);token=s['AppsNext'];first=token
        while token:page,token=call('ReadSnapshotPage','(ts)',(e,token));apps.extend(page)
        matches=list(s['WindowMatches']);token=s['WindowMatchesNext'];window_first=token
        while token:page,token=call('ReadSnapshotPage','(ts)',(e,token));matches.extend(page)
        if first or window_first:call('CloseSnapshot','(ts)',(e,first or window_first))
        s['WindowMatches']=matches
        return e,r,s,{a['DesktopId']:a for a in apps}
    def fail(method,sig,args,code):
        try:call(method,sig,args)
        except GLib.Error as e:assert Gio.DBusError.get_remote_error(e).endswith('.'+code),(code,e);return
        raise AssertionError((method,'unexpected success'))
    def setting(k,v):subprocess.run(['gsettings','set','org.nidara.ai',k,str(v).lower()],check=True)
    def start(require_usage=True):
        nonlocal daemon
        with (out/'daemon.log').open('a') as log:daemon=subprocess.Popen([binary,'--applications'],stdout=log,stderr=log)
        wait(lambda:snap()[2]['LauncherAvailable'] and (snap()[2]['UsageAvailable'] if require_usage else True),'A3 ready')
    def stop():
        nonlocal daemon
        daemon.terminate();daemon.wait(timeout=5);daemon=None
    def sender():
        b=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None);senders.append(b);return b
    def update(b,props,id='Files.desktop',path='/any/object/path'):
        b.emit_signal(None,path,'com.canonical.Unity.LauncherEntry','Update',GLib.Variant('(sa{sv})',('application://'+id,props)));b.flush_sync(None)
    def launcher():return snap()[3]['Files.desktop']['Launcher']
    def record(lid):return call('GetLaunch','(ts)',(e,lid))[0]
    try:
        start();e,_,state,apps=snap();layout=state['LayoutRevision'];generation=apps['Files.desktop']['Generation'];initial_epoch=state['HyaloEpoch']
        wait(lambda:(out/'state/nidara/applications-v1.json').exists(),'durable baseline')
        assert not any(a['IsNew'] for a in apps.values())
        matched=call('ResolveWindow','(tst)',(e,initial_epoch,1))[0];assert matched['DesktopId']=='Files.desktop' and matched['MatchKind']=='exact-app-id'
        # A pending uninterrupted watch is not committed at checkpoints; idle credits only 30 s.
        assert apps['Files.desktop']['ForegroundScore']==0
        h.flags['idle']=True;h.emit(dict(event='idle_changed',idle=True,since_us=h.now),300)
        wait(lambda:snap()[3]['Files.desktop']['ForegroundScore']>0,'idle cap committed')
        score=snap()[3]['Files.desktop']['ForegroundScore'];assert abs(score-30/3630)<.0001,score
        state=snap()[2];assert state['LayoutRevision']==layout and snap()[3]['Files.desktop']['Generation']==generation
        # New identity survives metadata changes and restart; explicit ack is separately gated.
        new=out/'data/applications/New.desktop';new.write_text('[Desktop Entry]\nType=Application\nName=New Fixture\nExec=/usr/bin/true\n')
        wait(lambda:snap()[3].get('New.desktop',{}).get('IsNew'),'new marker')
        first=snap()[3]['New.desktop']['NewlyObservedAt'];new.write_text(new.read_text().replace('New Fixture','Renamed Fixture'))
        wait(lambda:snap()[3]['New.desktop']['Name']=='Renamed Fixture','metadata edit')
        assert snap()[3]['New.desktop']['IsNew'] and snap()[3]['New.desktop']['NewlyObservedAt']==first
        wait(lambda:json.loads((out/'state/nidara/applications-v1.json').read_text())['apps'].get('New.desktop',{}).get('is_new'),'marker persisted')
        stop();start();e,_,state,apps=snap();assert apps['New.desktop']['IsNew']
        fail('AcknowledgeNew','(tas)',(e,['New.desktop']),'AccessDenied');setting('allow-computer-control',True);setting('allow-config-write',False);time.sleep(.15)
        fail('AcknowledgeNew','(tas)',(e,['New.desktop']),'AccessDenied');setting('allow-config-write',True)
        time.sleep(.15)
        usage_file=out/'state/nidara/applications-v1.json';usage_file.chmod(0o444)
        fail('AcknowledgeNew','(tas)',(e,['New.desktop']),'AccessDenied');assert snap()[3]['New.desktop']['IsNew'];usage_file.chmod(0o600)
        wait(lambda:call('AcknowledgeNew','(tas)',(e,['New.desktop'])),'ack permission');assert not snap()[3]['New.desktop']['IsNew']
        # A new window's actual foreground use clears its marker, independent of launch count.
        used=out/'data/applications/Used.desktop';used.write_text('[Desktop Entry]\nType=Application\nName=Used Fixture\nExec=/usr/bin/true\n');wait(lambda:snap()[3].get('Used.desktop',{}).get('IsNew'),'second new marker')
        h.windows.append(dict(id=2,app_id='Used',initial_app_id='Used',focused=False,visible=True,minimized=False));h.window_list();h.flags['idle']=False;h.emit(dict(event='idle_changed',idle=False,since_us=h.now));h.focus(2)
        wait(lambda:not snap()[3]['Used.desktop']['IsNew'],'foreground acknowledged marker')
        assert not json.loads((out/'state/nidara/applications-v1.json').read_text())['apps']['Used.desktop']['is_new']
        h.focus(1,5)
        wait(lambda:snap()[3]['Used.desktop']['ForegroundScore']>0,'foreground seconds')
        # Degraded roots preserve the last healthy baseline, not reinstall all old apps.
        root=out/'system/share/applications';saved=root.with_name('temporarily-away');root.rename(saved)
        wait(lambda:not snap()[2]['CatalogueComplete'],'degraded root');saved.rename(root);wait(lambda:snap()[2]['CatalogueComplete'],'root recovery')
        assert not snap()[3]['Files.desktop']['IsNew'] and not snap()[3]['New.desktop']['IsNew']
        # Unity: actual signal senders; latest WHOLE entry, partial own updates, loss fallback.
        a=sender();b=sender();update(a,{'count':GLib.Variant('x',3),'count-visible':GLib.Variant('b',True)});wait(lambda:launcher()['Count']==3,'sender A')
        variant=bus.call_sync(NAME,PATH,IFACE,'GetSnapshot',None,None,Gio.DBusCallFlags.NO_AUTO_START,10000,None)
        state_variant=variant.get_child_value(2);records=state_variant.lookup_value('Apps',None)
        checked_count_type=False
        for i in range(records.n_children()):
            record_variant=records.get_child_value(i)
            if record_variant.lookup_value('DesktopId',None).get_string()=='Files.desktop':
                assert record_variant.lookup_value('Launcher',None).lookup_value('Count',None).get_type_string()=='x';checked_count_type=True
        assert checked_count_type
        next_token=state_variant.lookup_value('AppsNext',None).get_string()
        if next_token:call('CloseSnapshot','(ts)',(e,next_token))
        update(b,{'count':GLib.Variant('x',7),'count-visible':GLib.Variant('b',True),'progress':GLib.Variant('d',1.5),'progress-visible':GLib.Variant('b',True)})
        wait(lambda:launcher()['Count']==7,'sender B');assert launcher()['Progress']==1
        update(a,{'urgent':GLib.Variant('b',True)});wait(lambda:launcher()['Urgent'],'partial A');assert launcher()['Count']==3 and not launcher()['ProgressVisible']
        rev=snap()[2]['LauncherRevision'];update(a,{'count':GLib.Variant('x',-2)});update(a,{'progress':GLib.Variant('d',float('nan'))});update(a,{'count':GLib.Variant('s','wrong')});update(a,{'unknown':GLib.Variant('s','x'*70000)})
        time.sleep(.2);assert snap()[2]['LauncherRevision']==rev and launcher()['Count']==3
        update(b,{'count':GLib.Variant('x',99)});b.close_sync(None);wait(lambda:launcher()['Count']==3,'owner loss does not resurrect final signal');time.sleep(.2);assert launcher()['Count']==3
        a.close_sync(None);wait(lambda:not launcher()['CountVisible'] and not launcher()['Urgent'],'all senders gone')
        # One immutable snapshot session owns BOTH app and matching page domains.
        original_windows=list(h.windows)
        h.windows=original_windows+[dict(id=i,app_id='Files',initial_app_id='Files',visible=True,minimized=False,focused=False) for i in range(10,310)]
        h.window_list();wait(lambda:len(snap()[2]['WindowMatches'])>256,'paged window matches')
        se,sr,ss=call('GetSnapshot');at=ss['AppsNext'];wt=ss['WindowMatchesNext'];assert at and wt
        assert call('ReadSnapshotPage','(ts)',(se,at))[0] and call('ReadSnapshotPage','(ts)',(se,wt))[0]
        call('CloseSnapshot','(ts)',(se,at));fail('ReadSnapshotPage','(ts)',(se,wt),'Stale')
        h.windows=original_windows;h.window_list()
        # Correlation result can arrive before observe_launch replies. It must not cancel dispatch.
        h.focus(1);time.sleep(.1);e,_,state,apps=snap()
        before=len(services.calls)
        req={'ActivationToken':GLib.Variant('s','a3-private-token')}
        lid=call('Launch','(tsta{sv})',(e,'Files.desktop',apps['Files.desktop']['Generation'],req))[0]
        st=wait(lambda:record(lid) if record(lid)['DispatchFinished'] else None,'observed dispatch')
        assert st['State']=='existing-window-activated' and st['CausalConfirmed'] and st['WindowConfirmed'] and st['WindowId']==1,st
        assert len(services.calls)==before+1 and h.seen and 'a3-private-token' not in json.dumps(st)
        # A stream gap stops observation, and same-run reconnect has a new connection identity.
        previous=snap()[2]['HyaloEpoch'];h.allow=False;h.emit(dict(event='anything'),skip=1)
        wait(lambda:not snap()[2]['UsageAvailable'],'gap unavailable')
        assert not snap()[2]['MatchingAvailable'] and not snap()[2]['WindowMatches']
        h.allow=True;wait(lambda:snap()[2]['UsageAvailable'],'resync');assert snap()[2]['HyaloEpoch']!=previous
        fail('ResolveWindow','(tst)',(e,previous,1),'Stale')
        # Both acknowledgement and scores survive restart without crediting stopped wall time.
        wait(lambda:json.loads((out/'state/nidara/applications-v1.json').read_text())['apps']['New.desktop']['is_new']==False,'ack persisted')
        stop();start();e,_,state,apps=snap();assert not apps['New.desktop']['IsNew'] and apps['Used.desktop']['ForegroundScore']>0
        # An occupied Unity compatibility name is passive, never replaced. Fresh updates still work.
        stop();holder=sender()
        owned=holder.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('com.canonical.Unity',4)),None,Gio.DBusCallFlags.NONE,1000,None).unpack()[0];assert owned==1
        start();e,_,state,apps=snap();assert state['LauncherHydrationIncomplete']
        update(holder,{'count':GLib.Variant('x',2),'count-visible':GLib.Variant('b',True)})
        wait(lambda:launcher()['Count']==2,'passive fresh update');assert snap()[2]['LauncherAvailable']
        holder.close_sync(None);wait(lambda:not snap()[2]['LauncherHydrationIncomplete'] and not launcher()['CountVisible'],'compatibility name recovery')
        # Incompatible/corrupt durable state is not overwritten or turned into a new baseline.
        stop();usage_file=out/'state/nidara/applications-v1.json';good=usage_file.read_bytes();usage_file.write_text('{\"version\":999}')
        bad=usage_file.read_bytes();start(False);assert not snap()[2]['UsageAvailable'] and not snap()[2]['NewAppsAvailable'];time.sleep(.2);assert usage_file.read_bytes()==bad
        stop();usage_file.write_bytes(good)
        print('PASS A3: coherent H1 matching/gap/resync; 30s pending-watch cap; durable new identity/metadata/foreground/ack policy; Unity real signals/whole-sender selection/types/progress/loss; early token correlation without cancelling dispatch. Fake H1/systemd, no installed/visual/Orca acceptance.')
    finally:
        if daemon:stop()
        for b in senders:
            try:b.close_sync(None)
            except GLib.Error:pass
        h.close();services.close()
if __name__=='__main__':
    if sys.argv[1]=='--inside':inside(sys.argv[2],sys.argv[3])
    else:sys.exit(a2.a1.outer(sys.argv[1],driver=str(HERE),setup=setup))
