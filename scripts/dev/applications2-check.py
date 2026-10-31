#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A2 private bus + fake systemd + actual disposable child apps; no real manager/session."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import gi
gi.require_version('Gio','2.0')
from gi.repository import Gio,GLib
try:
    gi.require_version('GioUnix','2.0')
    from gi.repository import GioUnix
    DesktopAppInfo=GioUnix.DesktopAppInfo
except (ValueError,ImportError):DesktopAppInfo=Gio.DesktopAppInfo
HERE=Path(__file__).resolve()
spec=importlib.util.spec_from_file_location('a1',HERE.with_name('applications1-check.py'))
a1=importlib.util.module_from_spec(spec);spec.loader.exec_module(a1)
NAME=a1.NAME;PATH=a1.PATH;IFACE=a1.IFACE
APP='org.example.Activator'
class Services:
    def __init__(self,out):
        self.out=out;self.calls=[];self.app_calls=[];self.hold=[];self.jobs=[];self.children=[];self.ready=threading.Event()
        def run():
            ctx=GLib.MainContext.new();ctx.push_thread_default()
            self.bus=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
            manager=Gio.DBusNodeInfo.new_for_xml('''<node><interface name="org.freedesktop.systemd1.Manager"><method name="StartTransientUnit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a(sv)" direction="in"/><arg type="a(sa(sv))" direction="in"/><arg type="o" direction="out"/></method><method name="Subscribe"/><signal name="JobRemoved"><arg type="u"/><arg type="o"/><arg type="s"/><arg type="s"/></signal><method name="GetUnitByPID"><arg type="u" direction="in"/><arg type="o" direction="out"/></method></interface><interface name="org.freedesktop.systemd1.Unit"><property name="Id" type="s" access="read"/></interface></node>''')
            app=Gio.DBusNodeInfo.new_for_xml('''<node><interface name="org.freedesktop.Application"><method name="Activate"><arg type="a{sv}" direction="in"/></method><method name="Open"><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/></method><method name="ActivateAction"><arg type="s" direction="in"/><arg type="av" direction="in"/><arg type="a{sv}" direction="in"/></method></interface></node>''')
            def method(c,sender,path,iface,name,args,inv):
                values=args.unpack()
                if name=='Subscribe':inv.return_value(None);return
                if name=='GetUnitByPID':inv.return_value(GLib.Variant('(o)',('/org/freedesktop/systemd1/unit/app',)));return
                if iface=='org.freedesktop.Application':
                    self.app_calls.append((name,values));inv.return_value(None);return
                unit,mode,props,aux=values;p=dict(props);self.calls.append((unit,p))
                assert mode=='fail' and aux==[] and p['Type']=='exec' and p['ExitType']=='cgroup'
                if p['SourcePath'].endswith('Refuse.desktop'):
                    inv.return_dbus_error('org.freedesktop.systemd1.Error.Refused','secret-token body must not escape');return
                if p['SourcePath'].endswith('Hold.desktop'):
                    self.hold.append((inv,unit,len(self.calls)));return
                if p['SourcePath'].endswith('Timeout.desktop'):
                    self.hold.append((inv,unit,len(self.calls)));return
                if p['SourcePath'].endswith('Delayed.desktop'):
                    self.job_done(inv,unit,len(self.calls),None);return
                if p['SourcePath'].endswith('JobFailure.desktop'):
                    self.job_done(inv,unit,len(self.calls),'failed');return
                binary,argv,flags=p['ExecStartEx'][0]
                assert binary==argv[0] and flags==['no-env-expand']
                assert p['StandardOutput']==p['StandardError']=='journal' and p['StandardInput']=='null'
                assert p['Slice']=='app-graphical.slice'
                env=dict(os.environ)
                for setting in p['Environment']:
                    key,sep,value=setting.partition('=');assert sep;env[key]=value
                for key in p['UnsetEnvironment']:env.pop(key,None)
                child=subprocess.Popen(argv,env=env,cwd=p['WorkingDirectory'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                self.children.append(child)
                self.job_done(inv,unit,len(self.calls))
            self.ids=[self.bus.register_object('/org/freedesktop/systemd1',manager.interfaces[0],method,None,None),self.bus.register_object('/org/freedesktop/systemd1/unit/app',manager.interfaces[1],None,lambda *_:GLib.Variant('s','app-org.example.Activator@existing.service'),None),self.bus.register_object('/org/example/Activator',app.interfaces[0],method,None,None)]
            for name in ['org.freedesktop.systemd1',APP]:self.bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',(name,4)),None,Gio.DBusCallFlags.NONE,1000,None)
            self.loop=GLib.MainLoop.new(ctx,False);self.ready.set();self.loop.run();self.bus.close_sync(None);ctx.pop_thread_default()
        self.thread=threading.Thread(target=run);self.thread.start();assert self.ready.wait(5)
    def job_done(self,inv,unit,number,result='done'):
        path='/org/freedesktop/systemd1/job/'+str(number)
        inv.return_value(GLib.Variant('(o)',(path,)))
        if result is None:self.jobs.append((unit,number));return
        self.emit_job(unit,number,result)
    def emit_job(self,unit,number,result):
        path='/org/freedesktop/systemd1/job/'+str(number)
        self.bus.emit_signal(None,'/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','JobRemoved',GLib.Variant('(uoss)',(number,path,unit,result)))
    def release_jobs(self):
        jobs,self.jobs=self.jobs,[]
        for unit,number in jobs:self.emit_job(unit,number,'done')
    def release(self):
        held,self.hold=self.hold,[]
        for inv,unit,number in held:self.job_done(inv,unit,number)
    def close(self):
        self.release();self.loop.quit();self.thread.join(timeout=5)
        for child in self.children:
            if child.poll() is None:child.terminate()
            child.wait(timeout=5)
def setup(out,env):
    env.update(GTK_THEME='Empty',INVOCATION_ID='unrelated-invocation',XDG_ACTIVATION_TOKEN='unrelated-token',MEMORY_PRESSURE_WATCH='/private/fd',XDG_CONFIG_DIRS=str(out/'system-config'))
    (out/'services').mkdir();(out/'system-config/autostart').mkdir(parents=True)
    (out/'probes').mkdir();(out/'working directory').mkdir()
    probe=out/'probe.py'
    probe.write_text('''import json,os,sys\nfrom pathlib import Path\nPath(os.environ['XDG_DATA_HOME']).parent.joinpath('probes',str(os.getpid())+'.json').write_text(json.dumps(dict(argv=sys.argv[1:],cwd=os.getcwd(),env={k:os.environ.get(k) for k in ['GTK_THEME','INVOCATION_ID','XDG_ACTIVATION_TOKEN','MEMORY_PRESSURE_WATCH','GIO_LAUNCHED_DESKTOP_FILE']})))\n''')
    appdir=out/'data/applications'
    def desktop(id,fields):
        text='[Desktop Entry]\nType=Application\nName='+id.removesuffix('.desktop')+'\n'+fields
        (appdir/id).write_text(text);return text
    basic='Exec=/usr/bin/python3 '+str(probe)+' %U\nMimeType=inode/directory;x-scheme-handler/https;\n'
    desktop('Files.desktop',basic+'Path='+str(out/'working directory')+'\nActions=new-window;\n[Desktop Action new-window]\nName=New Window\nExec=/usr/bin/python3 '+str(probe)+' new-action\n')
    desktop('Literal.desktop','Name[es]=Literal App\nExec=/usr/bin/python3 '+str(probe)+' "${HOME};not-a-shell" %% %c %k %i\nIcon=example\n')
    desktop('Single.desktop','Exec=/usr/bin/python3 '+str(probe)+' %f\n')
    desktop('Many.desktop','Exec=/usr/bin/python3 '+str(probe)+' %F\n')
    desktop('Delayed.desktop','Exec=/usr/bin/python3 '+str(probe)+' %f\n');desktop('JobFailure.desktop',basic);desktop('Refuse.desktop',basic);desktop('Hold.desktop',basic);desktop('Timeout.desktop',basic)
    desktop('OnlyOne.desktop',basic+'SingleMainWindow=true\n')
    desktop(APP+'.desktop','DBusActivatable=true\nExec=/usr/bin/false %U\nMimeType=x-scheme-handler/https;inode/directory;\nActions=new-window;\n[Desktop Action new-window]\nName=New Window\n')
    desktop('org.example.NoExec.desktop','DBusActivatable=true\nName=D-Bus Only\n')
    desktop('org.example.Missing.desktop','DBusActivatable=true\nExec=/usr/bin/false\n')
    desktop('org.example.Auto.desktop','DBusActivatable=true\nExec=/usr/bin/false\n')
    desktop('Flatpak.desktop',basic+'X-Flatpak=org.example.Flat\n')
    desktop('Terminal.desktop','Exec=/usr/bin/python3 '+str(probe)+' terminal-payload\nTerminal=true\n')
    desktop('FixtureTerminal.desktop','Exec=/usr/bin/python3 '+str(probe)+' terminal-wrapper\nCategories=TerminalEmulator;\nX-TerminalArgExec=--exec\n')
    (out/'config/xdg-terminals.list').write_text('FixtureTerminal.desktop\n')
    (out/'system-config/autostart/Files.desktop').write_text('[Desktop Entry]\nType=Application\nName=Files at login\n'+basic+'Hidden=true\nOnlyShowIn=Nidara;\nX-Custom=preserve-me\n')
    # This one app is deliberately activatable on the PRIVATE bus.
    (out/'services/org.example.Auto.service').write_text('[D-BUS Service]\nName=org.example.Auto\nExec=/usr/bin/python3 '+str(HERE)+' --activated\n')

def activated():
    out=Path(os.environ['XDG_DATA_HOME']).parent
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    info=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.Application"><method name="Activate"><arg type="a{sv}" direction="in"/></method></interface></node>')
    def call(c,s,p,i,m,args,inv):
        (out/'auto-activated.json').write_text(json.dumps(args.unpack()));inv.return_value(None)
        GLib.idle_add(loop.quit)
    reg=bus.register_object('/org/example/Auto',info.interfaces[0],call,None,None)
    bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.example.Auto',4)),None,Gio.DBusCallFlags.NONE,1000,None)
    loop=GLib.MainLoop();loop.run();bus.unregister_object(reg)

def inside(binary,out):
    out=Path(out);services=Services(out);bus=Gio.bus_get_sync(Gio.BusType.SESSION,None);daemon=None
    def call(method,sig=None,args=()):return bus.call_sync(NAME,PATH,IFACE,method,GLib.Variant(sig,args) if sig else None,None,Gio.DBusCallFlags.NO_AUTO_START,10000,None).unpack()
    def wait(f,label):
        end=time.monotonic()+14
        while time.monotonic()<end:
            try:
                result=f()
                if result:return result
            except GLib.Error:pass
            time.sleep(.02)
        raise AssertionError(label)
    def fail(method,sig,args,code):
        try:call(method,sig,args)
        except GLib.Error as e:assert Gio.DBusError.get_remote_error(e).endswith('.'+code),(code,e);return
        raise AssertionError(('unexpected success',method))
    def setting(key,value):subprocess.run(['gsettings','set','org.nidara.ai',key,str(value).lower()],check=True)
    def snap():
        e,r,s=call('GetSnapshot');apps=list(s['Apps']);token=s['AppsNext'];first=token
        while token:page,token=call('ReadSnapshotPage','(ts)',(e,token));apps.extend(page)
        if first:call('CloseSnapshot','(ts)',(e,first))
        return e,r,s,{a['DesktopId']:a for a in apps}
    def request(mode='activate',**kwargs):return {'Mode':GLib.Variant('s',mode),**{k:GLib.Variant('as' if k=='Uris' else 's',v) for k,v in kwargs.items()}}
    def launch(id,req=None,generation=None):return call('Launch','(tsta{sv})',(e,id,apps[id]['Generation'] if generation is None else generation,req or {}))[0]
    def status(id):return call('GetLaunch','(ts)',(e,id))[0]
    def done(id):return wait(lambda:status(id) if status(id)['DispatchFinished'] else False,'launch dispatched/failed')
    def probes():return [json.loads(p.read_text()) for p in (out/'probes').glob('*.json')]
    try:
        # Make default handler selection through GIO in the PRIVATE profile.
        DesktopAppInfo.new_from_filename(str(out/'data/applications/Files.desktop')).set_as_default_for_type('inode/directory')
        with (out/'daemon.log').open('w') as log:
            daemon=subprocess.Popen([binary,'--applications'],stdout=log,stderr=log)
            wait(snap,'Applications1 ready');e,_,state,apps=snap()
            assert state['CatalogueComplete'] and state['LaunchAvailable']  # Unity availability is independent (A3).
            assert apps['org.example.NoExec.desktop']['DBusActivatable'] and apps['org.example.NoExec.desktop']['Launchable']
            fail('Launch','(tsta{sv})',(e,'Files.desktop',apps['Files.desktop']['Generation'],{}),'AccessDenied')
            setting('allow-config-write',False)
            setting('allow-computer-control',True)
            lid=wait(lambda:launch('Literal.desktop',request(RequestId='literal')),'launch permission')
            assert done(lid)['State']=='dispatched'
            wait(lambda:len(probes())>=1,'literal child')
            p=probes()[0];assert p['argv'][0]=='${HOME};not-a-shell' and p['argv'][1]=='%'
            assert p['env']['XDG_ACTIVATION_TOKEN'] is None and p['env']['GTK_THEME'] is None and p['env']['INVOCATION_ID'] is None and p['env']['MEMORY_PRESSURE_WATCH'] is None,p
            assert p['cwd']==str(out/'home')
            assert launch('Literal.desktop',request(RequestId='literal'))==lid
            fail('Launch','(tsta{sv})',(e,'Literal.desktop',apps['Literal.desktop']['Generation'],request('new-window',RequestId='literal')),'Conflict')
            # Accepted request remains idempotent across a later catalogue generation.
            original_gen=apps['Literal.desktop']['Generation']
            path=out/'data/applications/Literal.desktop';path.write_text(path.read_text().replace('Name=Literal','Name=ChangedLiteral'))
            wait(lambda:snap()[3]['Literal.desktop']['Generation']!=original_gen,'generation changed')
            assert launch('Literal.desktop',request(RequestId='literal'),generation=original_gen)==lid
            fail('Launch','(tsta{sv})',(e,'Literal.desktop',original_gen,{}),'Stale')
            e,_,_,apps=snap()
            uri=(out/'input with spaces.txt').as_uri()
            lid=launch('Single.desktop',request('open',Uris=[uri,(out/'two.txt').as_uri()],ActivationToken='fixture-private-token'))
            assert done(lid)['State']=='dispatched'
            wait(lambda:len(probes())>=3,'two single-file children')
            single=[p for p in probes() if p['argv'] in [[str(out/'input with spaces.txt')],[str(out/'two.txt')]]]
            assert len(single)==2 and sum(p['env']['XDG_ACTIVATION_TOKEN']=='fixture-private-token' for p in single)==1
            assert len(status(lid)['DispatchUnits'])==2
            fail('Launch','(tsta{sv})',(e,'Single.desktop',apps['Single.desktop']['Generation'],request('open',Uris=[uri],ActivationToken='fixture-private-token')),'Conflict')
            delayed=launch('Delayed.desktop',request('open',Uris=[uri,(out/'two.txt').as_uri()]))
            wait(lambda:len(status(delayed)['DispatchUnits'])==1 and services.jobs,'first start job queued')
            assert status(delayed)['State']=='accepted' and not status(delayed)['DispatchFinished']
            services.release_jobs()
            wait(lambda:len(status(delayed)['DispatchUnits'])==2 and services.jobs,'second start job queued')
            assert status(delayed)['State']=='accepted' and not status(delayed)['DispatchFinished']
            services.release_jobs();assert done(delayed)['State']=='dispatched'
            failed=launch('JobFailure.desktop');assert wait(lambda:status(failed) if status(failed)['DispatchFinished'] else False,'failed systemd job')['State']=='failed'
            lid=launch('Files.desktop',request('new-window'));assert done(lid)['State']=='dispatched'
            wait(lambda:any(p['argv']==['new-action'] for p in probes()),'declared action')
            fail('Launch','(tsta{sv})',(e,'OnlyOne.desktop',apps['OnlyOne.desktop']['Generation'],request('new-window')),'Unsupported')
            fail('Launch','(tsta{sv})',(e,'Files.desktop',apps['Files.desktop']['Generation'],request('action',Action='not-declared')),'Invalid')
            fail('Launch','(tsta{sv})',(e,'Single.desktop',apps['Single.desktop']['Generation'],request('open',Uris=['https://example.invalid/test'])),'Unsupported')
            lid=launch(APP+'.desktop',request('open',Uris=['https://example.invalid/private'],ActivationToken='dbus-private-token'))
            st=done(lid);assert st['State']=='dispatched' and st['ActualUnit']=='app-org.example.Activator@existing.service',st
            assert services.app_calls[-1]==('Open',(['https://example.invalid/private'],{'activation-token':'dbus-private-token'}))
            assert not st['FocusConfirmed'] and not st['WindowConfirmed'] and not st['PortalIdentityVerified']
            assert 'private' not in json.dumps(st)
            lid=launch(APP+'.desktop',request('new-window'));assert done(lid)['State']=='dispatched';assert services.app_calls[-1][0]=='ActivateAction'
            before=len(services.calls);lid=launch('org.example.Missing.desktop');assert done(lid)['State']=='failed';assert len(services.calls)==before
            lid=launch('org.example.Auto.desktop',request(ActivationToken='activation-private'));assert done(lid)['State']=='dispatched'
            wait(lambda:(out/'auto-activated.json').exists(),'real private D-Bus activation')
            assert json.loads((out/'auto-activated.json').read_text())==[{'activation-token':'activation-private'}]
            lid=call('OpenDirectory','(tsa{sv})',(e,(out/'working directory').as_uri(),{}))[0];assert done(lid)['State']=='dispatched'
            fail('OpenDirectory','(tsa{sv})',(e,'file:///nonexistent/nidara-test',{}),'NotFound')
            fail('OpenDirectory','(tsa{sv})',(e,'trash:///',{}),'Unsupported')
            lid=launch('Files.desktop',request('open',Uris=['trash:///']));assert done(lid)['State']=='dispatched'
            wait(lambda:any(p['argv']==['trash:///'] for p in probes()),'default-handler Trash URI')
            fail('Launch','(tsta{sv})',(e,'Files.desktop',apps['Files.desktop']['Generation'],request('open',Uris=['trash:///other'])),'Unsupported')
            cli=Path(binary).with_name('nidara-ipc')
            if not cli.exists():raise AssertionError('build nidara-ipc before running the A2 fixture')
            def native(*args):return subprocess.run([str(cli),'--session=rust',*args],capture_output=True,text=True,timeout=16)
            listed=native('listApps');assert listed.returncode==0,listed.stderr
            assert any(a['id']=='Files.desktop' for a in json.loads(listed.stdout))
            before=len(services.calls);ambiguous=native('launchApp','Fixture');assert ambiguous.returncode==1 and 'ambiguous' in ambiguous.stderr and len(services.calls)==before
            launched=native('launchApp','Files');assert launched.returncode==0,launched.stderr
            result=json.loads(launched.stdout);assert result['state']=='dispatched' and not result['focusConfirmed'] and not result['windowConfirmed']
            lid=launch('Terminal.desktop');assert done(lid)['State']=='dispatched'
            wait(lambda:any(p['argv'][:2]==['terminal-wrapper','--exec'] for p in probes()),'terminal preference argv')
            # Autostart is config-gated, preserves effective system entry, no daemon loop.
            fail('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True),'AccessDenied')
            setting('allow-config-write',True)
            state=wait(lambda:call('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True))[0],'autostart permission')
            assert state['Enabled'] and not state['Started']
            user=out/'config/autostart/Files.desktop';assert 'X-Custom=preserve-me' in user.read_text() and 'Hidden=false' in user.read_text()
            assert 'Hidden=true' in (out/'system-config/autostart/Files.desktop').read_text()
            generator=Path('/usr/lib/systemd/user-generators/systemd-xdg-autostart-generator')
            def generate(label):
                paths=[out/label/suffix for suffix in ['normal','early','late']]
                for path in paths:path.mkdir(parents=True)
                subprocess.run([str(generator),*map(str,paths)],check=True,capture_output=True,text=True)
                return [p.read_text() for path in paths for p in path.glob('*.service')]
            # A legacy tool's disabled flag must be cleared in the user copy.
            user.write_text(user.read_text().replace('X-GNOME-Autostart-enabled=true','X-GNOME-Autostart-enabled=false'))
            wait(lambda:not snap()[3]['Files.desktop']['Autostart']['Enabled'],'legacy disabled effective preference')
            restored=call('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True))[0]
            assert restored['Enabled'] and restored['PreferenceEnabled'] and 'X-GNOME-Autostart-enabled=true' in user.read_text()
            enabled_units=generate('generator-enabled')
            assert any(str(user) in unit for unit in enabled_units),'real generator did not enable user override'

            call('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],False));assert 'Hidden=true' in user.read_text()
            assert not any(str(user) in unit for unit in generate('generator-disabled'))
            for id in [APP+'.desktop','Flatpak.desktop','Terminal.desktop']:fail('SetAutostart','(tstb)',(e,id,apps[id]['Generation'],True),'Unavailable')
            user.chmod(0o444);fail('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True),'AccessDenied');user.chmod(0o600)
            original=user.read_text()
            user.write_text(original.replace('Exec=/usr/bin/python3','Exec=/usr/bin/false'))
            fail('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True),'Conflict');assert '/usr/bin/false' in user.read_text()
            user.write_text(original)
            duplicate=out/'config/autostart/another-name.desktop';duplicate.write_text(original)
            fail('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True),'Conflict');duplicate.unlink()
            real=user.with_suffix('.saved');user.rename(real);user.symlink_to(real)
            fail('SetAutostart','(tstb)',(e,'Files.desktop',apps['Files.desktop']['Generation'],True),'AccessDenied');user.unlink();real.rename(user)
            # Queued launches must recheck revocation at their effect.
            held=[launch('Hold.desktop') for _ in range(8)];wait(lambda:len(services.hold)==8,'eight workers occupied')
            queued=launch('Files.desktop');started=time.monotonic();snap();assert time.monotonic()-started<1;setting('allow-computer-control',False);time.sleep(.15);before=len(services.calls);services.release()
            assert done(queued)['State']=='failed' and 'AccessDenied' in status(queued)['Error'];assert len(services.calls)==before
            denied=native('launchApp','Files');assert denied.returncode==1 and 'AccessDenied' in denied.stderr
            public=native('listApps');assert public.returncode==0
            setting('allow-computer-control',True);time.sleep(.15)
            lid=launch('Refuse.desktop');st=done(lid);assert st['State']=='failed' and 'secret-token' not in json.dumps(st)
            # A delivery timeout is unknown and never triggers fallback/retry.
            before=len(services.calls);lid=launch('Timeout.desktop',request(RequestId='timeout'));st=done(lid);assert st['State']=='timed-out-unknown' and st['OutcomeUnknown'];assert len(services.calls)==before+1
            assert launch('Timeout.desktop',request(RequestId='timeout'))==lid and len(services.calls)==before+1
            assert all('XDG_ACTIVATION_TOKEN' not in json.dumps(a) for a in snap()[2]['ActiveLaunches'])
            print('PASS A2: native ExecStartEx argv/env/identity, single-file multiplicity+token once, actions/new-window, private real bus activation/Open/action+unit observation, no fallback, default directories, typed autostart gating/preservation, queued revocation, nonce/generation and timeout outcome unknown. Fake systemd does not prove real cgroups/portal identity.')
    finally:
        if daemon:daemon.terminate();daemon.wait(timeout=5)
        services.close()
if __name__=='__main__':
    if sys.argv[1]=='--inside':inside(sys.argv[2],sys.argv[3])
    elif sys.argv[1]=='--activated':activated()
    else:sys.exit(a1.outer(sys.argv[1],driver=str(HERE),setup=setup))
