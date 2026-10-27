#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Audio1 on an exclusive private bus and PW remote. Never touches the user's graph.
Build: cargo build --manifest-path session/Cargo.toml --features audio-native
Run: scripts/dev/audio-test.py [session/target/debug/nidara-sessiond]
Logs/artifacts stay in target/audio-probe; no hardware monitors or system installation.
"""
import os,sys,subprocess,time,shutil,tempfile,json,wave,struct,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]

def outer():
    for name in ['dbus-run-session','pipewire','wireplumber','pw-cli','wpctl','pw-dump','pw-play','pw-record','glib-compile-schemas']:
        if not shutil.which(name): raise SystemExit(f'missing {name}; install separately, test installs nothing')
    base=ROOT/'target/audio-probe';base.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='run-',dir=base) as d, tempfile.TemporaryDirectory(prefix='nidara-audio-', dir=os.environ.get('XDG_RUNTIME_DIR', '/tmp')) as runtime:
        run=Path(d);env=os.environ.copy()
        for key in ['DBUS_SESSION_BUS_ADDRESS','PIPEWIRE_REMOTE','PIPEWIRE_RUNTIME_DIR','WIREPLUMBER_CONFIG_DIR','GSETTINGS_SCHEMA_DIR']:
            env.pop(key,None)
        for key,part in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache'),('XDG_STATE_HOME','state'),('XDG_DATA_HOME','data'),('XDG_RUNTIME_DIR','runtime')]:
            p=run/part;p.mkdir(mode=0o700);env[key]=str(p)
        env['XDG_RUNTIME_DIR']=runtime
        env['PIPEWIRE_REMOTE']='nidara-audio-test';env['PIPEWIRE_RUNTIME_DIR']=env['XDG_RUNTIME_DIR'];env['PIPEWIRE_CORE']='nidara-audio-test'
        schema=run/'schemas';schema.mkdir();shutil.copy(ROOT/'config/gsettings/org.nidara.gschema.xml',schema)
        subprocess.run(['glib-compile-schemas',str(schema)],check=True);env['GSETTINGS_SCHEMA_DIR']=str(schema);env['GSETTINGS_BACKEND']='memory'
        cfg=run/'wp';cfg.mkdir();shutil.copy('/usr/share/wireplumber/wireplumber.conf',cfg)
        fragments=cfg/'wireplumber.conf.d';fragments.mkdir()
        (fragments/'99-private.conf').write_text('''wireplumber.profiles = { main = {
 hardware.audio = disabled
 hardware.bluetooth = disabled
 hardware.video-capture = disabled
 support.reserve-device = disabled
 support.portal-permissionstore = disabled
 support.logind = disabled
 monitor.alsa = disabled
 monitor.alsa-midi = disabled
 monitor.bluez = disabled
 monitor.bluez-midi = disabled
 monitor.v4l2 = disabled
 monitor.libcamera = disabled
} }
''')
        shutil.copy(ROOT/'config/wireplumber/60-nidara-audio.conf',fragments)
        script=cfg/'scripts/nidara';script.mkdir(parents=True)
        shutil.copy(ROOT/'config/wireplumber/nidara-audio.lua',script/'audio.lua')
        if os.environ.get('NIDARA_AUDIO_POLICY_FAULT')=='1':(script/'audio.lua').write_text("error('injected optional audio policy load failure')\n")
        env['WIREPLUMBER_DATA_DIR']=str(cfg)+':/usr/share/wireplumber'
        env['WIREPLUMBER_CONFIG_DIR']=str(cfg)
        env['GIO_USE_VFS']='local'
        pcfg=run/'pw';pcfg.mkdir()
        for name in ['pipewire.conf','client.conf','client-rt.conf']:
            source=Path('/usr/share/pipewire')/name
            if source.exists():shutil.copy(source,pcfg)
        pfrag=pcfg/'pipewire.conf.d';pfrag.mkdir()
        (pfrag/'90-audiotest.conf').write_text('context.spa-libs = { audiotestsrc = audiotestsrc/libspa-audiotestsrc }\n')
        env['PIPEWIRE_CONFIG_DIR']=str(pcfg)
        log_dir=base/'policy-fault' if os.environ.get('NIDARA_AUDIO_POLICY_FAULT')=='1' else base
        log_dir.mkdir(exist_ok=True)
        env['NIDARA_AUDIO_TEST_RUN']=str(run);env['NIDARA_AUDIO_TEST_LOG']=str(log_dir)
        binary=Path(sys.argv[1] if len(sys.argv)>1 else ROOT/'session/target/debug/nidara-sessiond').resolve()
        return subprocess.run(['dbus-run-session','--',sys.executable,__file__,'--private',str(binary)],env=env).returncode

def private(binary):
    from gi.repository import Gio,GLib
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None);processes=[];logs=[]
    finished={}
    bus.signal_subscribe(None,'org.nidara.AudioTestPlayback1','Finished',None,None,Gio.DBusSignalFlags.NONE,lambda *args:finished.__setitem__(args[2],args[5].unpack()[0]))
    bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.nidara.SettingsNative',0)),None,Gio.DBusCallFlags.NONE,3000,None)
    def spawn(args,name):
        log=open(Path(os.environ['NIDARA_AUDIO_TEST_LOG'])/f'{name}.log','w');logs.append(log)
        p=subprocess.Popen(args,stdout=log,stderr=log);processes.append(p);return p
    def call(path,iface,method,args=None):
        return bus.call_sync('org.nidara.Session',path,iface,method,args,None,Gio.DBusCallFlags.NONE,20000,None).unpack()
    def pump():
        c=GLib.MainContext.default()
        while c.pending():c.iteration(False)
    def wait(fn,label,timeout=12):
        until=time.monotonic()+timeout;error=None
        while time.monotonic()<until:
            pump()
            try:
                v=fn()
                if v:print('PASS:',label,flush=True);return v
            except Exception as e:error=e
            time.sleep(.02)
        print('DIAGNOSTIC:', subprocess.check_output(['pw-dump'],text=True)[:1600],flush=True)
        try:print('ROOT:',root(),flush=True)
        except Exception:pass
        raise AssertionError(f'{label}: {error}')
    def objects():return call('/org/nidara/Audio','org.freedesktop.DBus.ObjectManager','GetManagedObjects')[0]
    def root():return call('/org/nidara/Audio','org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',('org.nidara.Audio1',)))[0]
    def configure(key,value):
        return bus.call_sync('org.nidara.Config','/org/nidara/Config','org.nidara.Config1','Apply',GLib.Variant('(sv)',(key,value)),None,Gio.DBusCallFlags.NONE,5000,None).unpack()
    def nodes():return {k:v['org.nidara.AudioNode1'] for k,v in objects().items() if 'org.nidara.AudioNode1' in v}
    def invoke(method,signature,args):return call('/org/nidara/Audio','org.nidara.Audio1',method,GLib.Variant(signature,args))
    def make(name,cls):
        props=f'{{ factory.name=support.null-audio-sink node.name={name} node.description={name} media.class={cls} audio.position=[ FL FR ] object.linger=true }}'
        subprocess.run(['pw-cli','create-node','adapter',props],check=True,capture_output=True)
    try:
        pw=spawn(['pipewire'],'pipewire');wait(lambda:(Path(os.environ['XDG_RUNTIME_DIR'])/'nidara-audio-test').exists(),'exclusive PipeWire socket')
        wp=spawn(['wireplumber'],'wireplumber')
        daemon=spawn([binary,'--config','--audio'],'audio')
        wait(lambda:root()['State']=='ready','Audio1 ready')
        if os.environ.get('NIDARA_AUDIO_POLICY_FAULT')=='1':
            assert root()['DefaultSwitchMode']=='unsupported'
            assert wp.poll() is None
            wait(lambda:'injected optional audio policy load failure' in (Path(os.environ['NIDARA_AUDIO_TEST_LOG'])/'wireplumber.log').read_text(),'fault control actually loaded and rejected the optional script')
            make('fault-output','Audio/Sink')
            output=wait(lambda:next((k for k,v in nodes().items() if v['Name']=='fault-output'),None),'output remains available after hook failure')
            invoke('SetVolume','(od)',(output,.7))
            assert abs(nodes()[output]['Volume']-.7)<.002
            print('PASS: optional policy load failure leaves WirePlumber and Audio1 ready, with switch unsupported',flush=True)
            return 0
        wait(lambda:root()['DefaultSwitchMode']=='wireplumber-policy','private hotplug policy loaded')
        assert not nodes(),'hardware disabled, graph initially empty'
        assert not any(x['type']=='PipeWire:Interface:Device' for x in json.loads(subprocess.check_output(['pw-dump']))),'physical devices must not enter the private test graph'
        make('test-a','Audio/Sink');make('test-b','Audio/Sink')
        subprocess.run(['pw-cli','create-node','adapter','{ factory.name=audiotestsrc node.name=test-input media.class=Audio/Source/Virtual audio.position=[ FL FR ] object.linger=true node.param.Props={ live=true freq=440 volume=0.25 } }'],check=True,capture_output=True)
        wait(lambda:len(nodes())==3,'two null outputs and virtual input')
        lookup=lambda name:next(k for k,v in nodes().items() if v['Name']==name)
        a,b,source=[lookup(n) for n in ['test-a','test-b','test-input']]
        invoke('SetDefault','(o)',(a,));wait(lambda:root()['DefaultOutput']==a,'set default output')
        invoke('SetVolume','(od)',(a,.8));assert abs(nodes()[a]['Volume']-.8)<.002
        actual=subprocess.check_output(['wpctl','get-volume',str(next(x['id'] for x in json.loads(subprocess.check_output(['pw-dump'])) if x['type']=='PipeWire:Interface:Node' and x['info']['props'].get('node.name')=='test-a'))],text=True)
        assert '0.80' in actual,actual;print('PASS: cubic volume agrees with wpctl',flush=True)
        invoke('SetBalance','(od)',(a,-.5));invoke('SetVolume','(od)',(a,.6));assert abs(nodes()[a]['Balance']+.5)<.01;print('PASS: volume preserves balance',flush=True)
        configure('audio.overamplification',GLib.Variant('b',True))
        wait(lambda:root()['VolumeLimit']==1.5,'Config1 enables overamplification')
        invoke('SetVolume','(od)',(a,1.2))
        configure('audio.overamplification',GLib.Variant('b',False))
        wait(lambda:root()['VolumeLimit']==1.0 and abs(nodes()[a]['Volume']-1.0)<.002,'disabling overamplification clamps current levels')
        assert abs(nodes()[a]['Balance']+.5)<.01
        invoke('SetVolume','(od)',(a,.6))
        configure('audio.alerts-enabled',GLib.Variant('b',False))
        try:invoke('PlayAlert','(s)',('message-new-instant',));raise AssertionError('disabled alert accepted')
        except GLib.Error as e:assert 'disabled' in str(e),e
        configure('audio.alerts-enabled',GLib.Variant('b',True))
        alert=invoke('PlayAlert','(s)',('message-new-instant',))[0]
        wait(lambda:alert not in objects() and finished.get(alert)=='completed','XDG alert sound completes without ducking')
        try:invoke('PlayVolumeFeedback','(o)',(a,));raise AssertionError('disabled feedback accepted')
        except GLib.Error as e:assert 'disabled' in str(e),e
        configure('audio.volume-feedback',GLib.Variant('b',True))
        click=invoke('PlayVolumeFeedback','(o)',(a,))[0]
        wait(lambda:click not in objects() and finished.get(click)=='completed','XDG audio-volume-change feedback completes')
        invoke('SetMuted','(ob)',(a,True))
        try:invoke('TestChannel','(os)',(a,'FL'));raise AssertionError('muted test accepted')
        except GLib.Error as e:assert 'output muted' in str(e),e
        invoke('SetMuted','(ob)',(a,False))
        # Playback is a real external stream, not a made-up D-Bus roster.
        run=Path(os.environ['NIDARA_AUDIO_TEST_RUN']);wav=run/'tone.wav'
        with wave.open(str(wav),'wb') as f:
            f.setparams((2,2,48000,0,'NONE','not compressed'))
            f.writeframes(b''.join(struct.pack('<hh',int(math.sin(i*2*math.pi*220/48000)*3000),int(math.sin(i*2*math.pi*220/48000)*3000)) for i in range(48000*12)))
        playback=spawn(['pw-play','--target','test-b',str(wav)],'playback')
        stream=wait(lambda:next((k for k,v in nodes().items() if v['Kind']=='playback' and k in root()['Streams']),None),'external playback stream')
        wait(lambda:b in nodes()[stream]['Targets'] and nodes()[stream]['RequestedTarget']==b,'app explicit target is visible')
        invoke('MovePlayback','(oo)',(stream,a));wait(lambda:a in nodes()[stream]['Targets'],'move overrides original app target')
        invoke('MovePlayback','(oo)',(stream,b));wait(lambda:b in nodes()[stream]['Targets'],'move playback to second output')
        invoke('FollowDefault','(o)',(stream,));wait(lambda:a in nodes()[stream]['Targets'],'follow default output')
        meter_values=[]
        meter_signal=bus.signal_subscribe(None,'org.nidara.AudioPeakSubscription1','Peak',None,None,Gio.DBusSignalFlags.NONE,lambda *args:meter_values.append(args[5].unpack()))
        sub=invoke('SubscribePeak','(ou)',(source,20))[0];wait(lambda:bool(root()['InternalCapture']),'meter capture is exposed separately')
        wait(lambda:len(meter_values)>=4,'bounded peak stream carries samples')
        peak=max(v for _,values in meter_values for v in values)
        assert .061<peak<.064,peak
        assert all(t2-t1>=45000 for (t1,_),(t2,_) in zip(meter_values,meter_values[1:])),meter_values
        print('PASS: linear peaks match known 0.0625 signal (generator and adapter each at 0.25) and rate is bounded',flush=True)
        assert not root()['RecordingStreams'],'internal monitor not listed as external recorder'
        assert all(not(nodes()[p]['ApplicationId']=='org.nidara.Session') for p in root()['Streams'])
        peer=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
        other=peer.call_sync('org.nidara.Session','/org/nidara/Audio','org.nidara.Audio1','SubscribePeak',GLib.Variant('(ou)',(source,10)),None,Gio.DBusCallFlags.NONE,5000,None).unpack()[0]
        try:peer.call_sync('org.nidara.Session',sub,'org.nidara.AudioPeakSubscription1','Unsubscribe',None,None,Gio.DBusCallFlags.NONE,5000,None);raise AssertionError('foreign unsubscribe accepted')
        except GLib.Error as e:assert 'PermissionDenied' in str(e),e
        call(sub,'org.nidara.AudioPeakSubscription1','Unsubscribe')
        assert root()['InternalCapture'],'second subscriber retains the shared capture'
        peer.close_sync(None)
        wait(lambda:not root()['InternalCapture'] and other not in objects(),'owner loss removes subscription and last capture')
        playback.terminate();playback.wait(timeout=3)
        wait(lambda:stream not in nodes(),'external stream removed')
        capture=Path(os.environ['NIDARA_AUDIO_TEST_RUN'])/'channel.raw'
        recorder=spawn(['pw-record','--raw','--format','f32','--rate','48000','--channels','2','--target','test-a','-P','{ stream.capture.sink=true }',str(capture)],'channel-capture')
        wait(lambda:any(v['Kind']=='capture' and v['CaptureKind']=='monitor' for v in nodes().values()),'external sink monitor is classified separately')
        test=invoke('TestChannel','(os)',(a,'FL'))[0];wait(lambda:test not in objects() and finished.get(test)=='completed','channel test completes and object is removed')
        recorder.terminate();recorder.wait(timeout=3)
        samples=struct.unpack('<'+'f'*(capture.stat().st_size//4),capture.read_bytes())
        assert max(map(abs,samples[::2]))>.01 and max(map(abs,samples[1::2]))<.0001,'channel bleed or no test tone'
        print('PASS: FL test has energy only in FL',flush=True)
        wp.terminate();wp.wait(timeout=3)
        wait(lambda:root()['State']=='degraded','missing WirePlumber metadata is degraded')
        assert 'mixer' in root()['Capabilities'] and 'defaults' not in root()['Capabilities']
        invoke('SetVolume','(od)',(a,.4));assert abs(nodes()[a]['Volume']-.4)<.002
        print('PASS: degraded retains working mixer and withdraws only defaults',flush=True)
        old_generation=root()['Generation'];pw.terminate();pw.wait(timeout=3);wait(lambda:root()['State']=='unavailable','PipeWire loss is explicit')
        wp.terminate();wp.wait(timeout=3)
        pw=spawn(['pipewire'],'pipewire-restart');wait(lambda:pw.poll() is None and (Path(os.environ['XDG_RUNTIME_DIR'])/'nidara-audio-test').exists(),'restarted exclusive socket')
        wp=spawn(['wireplumber'],'wireplumber-restart');wait(lambda:root()['State']=='ready' and root()['Generation']>old_generation,'backend reconnects with fresh generation',35)
        assert a not in objects();print('PASS: stale paths do not survive reconnect',flush=True)
    finally:
        for p in reversed(processes):
            if p.poll() is None:p.terminate()
        for p in processes:
            try:p.wait(timeout=4)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        for l in logs:l.close()
    return 0
if __name__=='__main__':
    sys.exit(private(sys.argv[2]) if len(sys.argv)>1 and sys.argv[1]=='--private' else outer())
