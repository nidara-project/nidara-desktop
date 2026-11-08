#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Local private-bus notification disk-fault and 100-arrival burst check.
No CI wiring, installed session, real full disk or system permissions changed.
"""
import argparse,json,os,subprocess,sys,tempfile,time
from pathlib import Path


def run(binary, out):
    from gi.repository import Gio, GLib
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    cache=Path(os.environ['XDG_CACHE_HOME'])/'nidara/notifd'
    cache.mkdir(parents=True)
    journal=cache/'history.jsonl'
    damaged=b'{"op":"remove","ids":[]}\nbroken interior\n{"op":"remove","ids":[]}\n'
    journal.write_bytes(damaged)
    public='org.freedesktop.Notifications';private='org.nidara.Notifications1'
    def call(method, params=None, internal=True):
        return bus.call_sync('org.nidara.Session' if internal else public,
            '/org/nidara/Notifications' if internal else '/org/freedesktop/Notifications',
            private if internal else public, method,params,None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()
    def rows():return json.loads(call('List')[0])
    def notify(summary):
        return call('Notify',GLib.Variant('(susssasa{sv}i)',('disk check',0,'',summary,'',[],{},0)),False)[0]
    context=GLib.MainContext.default()
    changes=[]
    bus.signal_subscribe(None,private,'Changed','/org/nidara/Notifications',None,Gio.DBusSignalFlags.NONE,
        lambda c,s,p,i,m,a,*_:changes.append(json.loads(a.unpack()[1])))
    def wait(test):
        end=time.monotonic()+10
        while time.monotonic()<end:
            while context.pending():context.iteration(False)
            try:
                if test():return
            except GLib.Error:pass
            time.sleep(.01)
        raise AssertionError('private daemon did not reach expected state')
    def start(log):
        p=subprocess.Popen([binary,'--config'],stdout=log,stderr=subprocess.STDOUT)
        wait(lambda:call('Snapshot') is not None)
        xml=bus.call_sync('org.nidara.Session','/org/nidara/Config','org.freedesktop.DBus.Introspectable','Introspect',
            None,None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
        assert 'org.nidara.Config1' in xml,'notification startup failure took down Config1'
        return p
    def stop(p):
        p.terminate();p.wait(timeout=5)
        wait(lambda:not bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',
            GLib.Variant('(s)',('org.nidara.Session',)),None,Gio.DBusCallFlags.NONE,5000,None).unpack()[0])
    log_path=out/'daemon.log'
    report={}
    with log_path.open('w') as log:
        p=start(log)
        try:
            saved=list(cache.glob('history.jsonl.broken-*'))
            assert len(saved)==1 and saved[0].read_bytes()==damaged
            assert rows()==[]
            report['corrupt input preserved; notification and Config1 services available']=True
            first=notify('before failed disk')
            # Writes to this private symlink fail with ENOSPC; no disk is filled.
            journal.unlink();journal.symlink_to('/dev/full')
            temporary=cache/'history.jsonl.tmp'
            temporary.symlink_to('/dev/full')
            second=notify('during full disk')
            call('Dismiss',GLib.Variant('(u)',(first,)))
            third=notify('still during full disk')
            assert {n['id'] for n in rows()}=={second,third}
            wait(lambda:any(v.get('put',{}).get('id')==second for v in changes))
            assert log_path.read_text().count('history is not durable')==2 # corrupt startup + this outage
            report['ENOSPC preserves live puts, dismissal and renderer stream; one warning per outage']=True
            # A blocked directory must also leave live clear/arrivals operable.
            journal.unlink();journal.write_text('')
            temporary.unlink()
            journal.chmod(0o400);cache.chmod(0o500)
            call('DismissAll')
            fourth=notify('during denied writes')
            assert [n['id'] for n in rows()]==[fourth]
            assert log_path.read_text().count('history is not durable')==2
            assert 'No space left on device' in log_path.read_text()
            cache.chmod(0o700);journal.chmod(0o600)
            fifth=notify('after disk recovery')
            assert [n['id'] for n in rows()]==[fourth,fifth]
            report['denied directory writes allow clearing and arrivals']=True
            stop(p);p=None
            p=start(log)
            assert {n['id'] for n in rows()}=={fourth,fifth}
            assert saved[0].read_bytes()==damaged
            report['recovery compacts live state; restart never resurrects discarded notices']=True
            start_time=time.monotonic()
            for i in range(100):notify(f'burst {i}')
            elapsed=time.monotonic()-start_time
            assert len(rows())==102
            assert elapsed<2.,f'100 synced notifications took {elapsed:.3f}s'
            report['100 notification burst_seconds']=elapsed
            print(json.dumps(report,indent=2),flush=True)
            (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        finally:
            cache.chmod(0o700)
            if journal.exists() and not journal.is_symlink():journal.chmod(0o600)
            if p and p.poll() is None:stop(p)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary',type=lambda p:str(Path(p).resolve()))
    parser.add_argument('output',type=lambda p:Path(p).resolve())
    parser.add_argument('--private',action='store_true')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    if args.private:
        run(args.binary,args.output)
    else:
        with tempfile.TemporaryDirectory(prefix='notification-disk-fault-') as cache:
            raise SystemExit(subprocess.run(['dbus-run-session','--',sys.executable,__file__,args.binary,str(args.output),'--private'],
                env={**os.environ,'XDG_CACHE_HOME':cache,'XDG_CONFIG_HOME':cache+'/config',
                     'XDG_DATA_HOME':cache+'/data','XDG_STATE_HOME':cache+'/state',
                     'GSETTINGS_BACKEND':'memory','GIO_USE_VFS':'local'},timeout=90).returncode)
