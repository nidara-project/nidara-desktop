#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Bluetooth1 writes ONLY to BlueZ/obexd peers on two disposable buses."""
import json, math, os, subprocess, sys, tempfile, time
from pathlib import Path
from gi.repository import Gio, GLib
B='org.bluez'; O=B+'.obex'; N='org.nidara.Bluetooth'; P='/org/nidara/Bluetooth'; I=N+'1'
A='/org/bluez/hci0'; A2='/org/bluez/hci1'; D=A+'/dev_AA_BB_CC_DD_EE_FF'
T='org.nidara.BluetoothTest'; TP='/org/nidara/BluetoothTest'
ctx=GLib.MainContext.default()
def pump():
    while ctx.pending():ctx.iteration(False)
def wait(pred,label,seconds=10):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        pump()
        if pred():return
        time.sleep(.01)
    raise AssertionError('timeout: '+label)
def v(sig,value):return GLib.Variant(sig,value)
def conn(address):return Gio.DBusConnection.new_for_address_sync(address,Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
def call(bus,dest,path,iface,method,sig=None,args=(),timeout=8000):return bus.call_sync(dest,path,iface,method,v(sig,args) if sig else None,None,Gio.DBusCallFlags.NO_AUTO_START,timeout,None).unpack()
def check(ok,label):
    if not ok:raise AssertionError(label)
    print('PASS: '+label,flush=True)
def fails(fn,error):
    try:fn()
    except GLib.Error as e:
        check(error in str(e),'refuses '+error);return
    raise AssertionError('unexpected acceptance: '+error)
def fake(root):
    system=conn(os.environ['DBUS_SYSTEM_BUS_ADDRESS']);session=conn(os.environ['DBUS_SESSION_BUS_ADDRESS'])
    root=Path(root);(root/'obex').mkdir(exist_ok=True)
    state=dict(writes=0,bluezRegisters=0,obexRegisters=0,obexAttempts=0,agent='',agentPath='',obexAgent='',obexPath='',incomingRoot=str(root/'obex'),pairKind='confirm',pairResult=None,promptResult=None,incomingResult=None,lastTransfer='',sequence=0,removedSessions=[],cancelCalls=0,heldCancels=0,holdCancel=False,trustFail=False,obexReject=False)
    exports=[];retained=[];objects={};pair_wait=[];held_cancels=[];registrations={};removed_device={};discovery_clients={}
    def own(bus,name):assert call(bus,'org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName','(su)',(name,4))[0] in (1,4)
    own(system,B);own(session,O);own(session,T)
    def props(path,iface):return objects.get(path,{}).get(iface,{})
    def changed(bus,path,iface,p):
        bus.emit_signal(None,path,'org.freedesktop.DBus.Properties','PropertiesChanged',v('(sa{sv}as)',(iface,p,[])))
    def setp(bus,path,iface,key,value):props(path,iface)[key]=value;changed(bus,path,iface,{key:value})
    def answer(inv,sig=None,args=()):inv.return_value(v(sig,args) if sig else None)
    def method_xml(name,ins=(),outs=()):return '<method name="'+name+'">'+''.join('<arg type="'+s+'" direction="in"/>' for s in ins)+''.join('<arg type="'+s+'" direction="out"/>' for s in outs)+'</method>'
    def export(bus,path,iface,methods=(),p=None):
        p=p or {};objects.setdefault(path,{})[iface]=p
        xml='<node><interface name="'+iface+'">'+''.join(method_xml(*m)for m in methods)+''.join('<property name="'+k+'" type="'+value.get_type_string()+'" access="readwrite"/>' for k,value in p.items())+'</interface></node>'
        info=Gio.DBusNodeInfo.new_for_xml(xml);retained.append(info)
        def getprop(c,s,path,iface,key):return props(path,iface).get(key)
        def setprop(c,s,path,iface,key,value):
            state['writes']+=1
            if key=='Trusted' and state['trustFail']:return False
            setp(bus,path,iface,key,value);return True
        registration=bus.register_object(path,info.interfaces[0],dispatch,getprop,setprop);exports.append((bus,registration));registrations[(bus.get_unique_name(),path,iface)]=registration
    def invoke_agent(method,sig,args,key='promptResult',pair_inv=None):
        state[key]=None
        def done(c,res):
            try:result={'ok':True,'value':c.call_finish(res).unpack()}
            except GLib.Error as e:result={'ok':False,'error':str(e)}
            state[key]=result
            if pair_inv is not None:
                if pair_inv not in pair_wait:return
                pair_wait.remove(pair_inv)
                if result['ok']:setp(system,D,B+'.Device1','Paired',v('b',True));answer(pair_inv)
                else:pair_inv.return_dbus_error(B+'.Error.AuthenticationCanceled','cancelled')
        system.call(state['agent'],state['agentPath'],B+'.Agent1',method,v(sig,args),None,Gio.DBusCallFlags.NONE,130000,None,done)
    def new_session(outgoing,address='AA:BB:CC:DD:EE:FF'):
        state['sequence']+=1;path='/org/bluez/obex/'+('client'if outgoing else 'server')+'/session'+str(state['sequence'])
        export(session,path,O+'.Session1',(),{'Source':v('s','00:11:22:33:44:55'),'Destination':v('s',address),'Root':v('s',state['incomingRoot'])})
        if outgoing:export(session,path,O+'.ObjectPush1',[('SendFile',('s',),('o','a{sv}'))])
        return path
    def new_transfer(parent,name,size):
        path=parent+'/transfer1';p={'Session':v('o',parent),'Name':v('s',name),'Status':v('s','queued'),'Transferred':v('t',0)}
        if size is not None:p['Size']=v('t',size)
        export(session,path,O+'.Transfer1',[('Cancel',(),())],p);state['lastTransfer']=path;return path
    def control(command,data):
        nonlocal system,session
        if command=='Info':return dict(state,adapters=[p for p in objects if B+'.Adapter1'in objects[p]])
        if command=='Set':state.update(data);return {}
        if command=='ReleaseCancel':
            for inv in held_cancels:answer(inv)
            held_cancels.clear();state['heldCancels']=0;state['holdCancel']=False;return {}
        if command=='Device':
            if data:objects[D]=dict(removed_device)
            else:removed_device.update(objects.pop(D))
            return {}
        if command=='ExternalVisible':setp(system,A,B+'.Adapter1','Discoverable',v('b',data));setp(system,A,B+'.Adapter1','DiscoverableTimeout',v('u',0 if data else 180));return {}
        if command=='Battery':
            if data is None:
                objects[D].pop(B+'.Battery1',None);system.unregister_object(registrations.pop((system.get_unique_name(),D,B+'.Battery1')))
            else:
                if B+'.Battery1'not in objects[D]:export(system,D,B+'.Battery1',(),{'Percentage':v('y',data)})
                else:setp(system,D,B+'.Battery1','Percentage',v('y',data))
            return {}
        if command=='Prompt':
            kind=data['kind'];value=data.get('value',7)
            methods={'pin':('RequestPinCode','(o)',(D,)),'passkey':('RequestPasskey','(o)',(D,)),'confirm':('RequestConfirmation','(ou)',(D,value)),'authorize':('RequestAuthorization','(o)',(D,)),'service':('AuthorizeService','(os)',(D,data.get('uuid','test-service'))),'display':('DisplayPasskey','(ouq)',(D,value,data.get('entered',0))),'cancel':('Cancel','()',())}
            method,sig,args=methods[kind];invoke_agent(method,sig,args);return {}
        if command=='Advertise':setp(system,A,B+'.Adapter1','UUIDs',v('as',data));return {}
        if command=='Trusted':setp(system,D,B+'.Device1','Trusted',v('b',data));return {}
        if command=='Paired':setp(system,D,B+'.Device1','Paired',v('b',data));return {}
        if command=='Incoming':
            parent=new_session(False);path=new_transfer(parent,data.get('name','incoming.txt'),data.get('size'))
            state['incomingResult']=None
            def done(c,res):
                try:state['incomingResult']={'ok':True,'path':c.call_finish(res).unpack()[0]}
                except GLib.Error as e:state['incomingResult']={'ok':False,'error':str(e)}
            session.call(state['obexAgent'],state['obexPath'],O+'.Agent1','AuthorizePush',v('(o)',(path,)),None,Gio.DBusCallFlags.NONE,60000,None,done)
            return {'transfer':path}
        if command=='Complete':
            result=state['incomingResult'];assert result and result['ok']
            payload=data.get('payload','hello').encode();Path(result['path']).write_bytes(payload)
            path=state['lastTransfer'];setp(session,path,O+'.Transfer1','Transferred',v('t',len(payload)));setp(session,path,O+'.Transfer1','Status',v('s','complete'))
            if data.get('remove'):objects.pop(path)
            return {}
        if command=='Progress':
            path=state['lastTransfer'];setp(session,path,O+'.Transfer1','Transferred',v('t',data['bytes']));setp(session,path,O+'.Transfer1','Status',v('s',data.get('status','active')));return {}
        if command=='Burst':
            state['burst']=0
            def update():
                state['burst']+=1;setp(system,D,B+'.Device1','RSSI',v('n',-20-state['burst']%50))
                return state['burst']<100
            GLib.timeout_add(10,update);return {}
        if command=='ObexDrop':
            call(session,'org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName','(s)',(O,));return {}
        if command=='ObexRestore':
            session=conn(os.environ['DBUS_SESSION_BUS_ADDRESS']);state['obexAgent']='';state['obexPath']=''
            methods={O+'.AgentManager1':[('RegisterAgent',('o',),())],O+'.Client1':[('CreateSession',('s','a{sv}'),('o',)),('RemoveSession',('o',),())],O+'.ObjectPush1':[('SendFile',('s',),('o','a{sv}'))],O+'.Transfer1':[('Cancel',(),())],O+'.Session1':[]}
            for path,ifaces in list(objects.items()):
                for iface,p in list(ifaces.items()):
                    if iface in methods:export(session,path,iface,methods[iface],p)
            own(session,O);return {}
        if command=='Drop':
            call(system,'org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName','(s)',(B,));return {}
        if command=='Restore':
            system=conn(os.environ['DBUS_SYSTEM_BUS_ADDRESS'])
            for path,ifaces in list(objects.items()):
                for iface,p in list(ifaces.items()):
                    if iface==B+'.Adapter1':export(system,path,iface,[('StartDiscovery',(),()),('StopDiscovery',(),()),('RemoveDevice',('o',),())],p)
                    elif iface==B+'.Device1':export(system,path,iface,[('Pair',(),()),('CancelPairing',(),()),('Connect',(),()),('Disconnect',(),())],p)
                    elif iface==B+'.Battery1':export(system,path,iface,(),p)
            export(system,'/', 'org.freedesktop.DBus.ObjectManager',[('GetManagedObjects',(),('a{oa{sa{sv}}}',))]);export(system,'/org/bluez',B+'.AgentManager1',[('RegisterAgent',('o','s'),()),('RequestDefaultAgent',('o',),())]);own(system,B);return {}
        raise AssertionError(command)
    def dispatch(c,sender,path,iface,method,parameters,inv):
        p=parameters.unpack()
        try:
            if iface==T:answer(inv,'(s)',(json.dumps(control(p[0],json.loads(p[1]))),));return
            if method=='GetManagedObjects':answer(inv,'(a{oa{sa{sv}}})',({path:{iface:p for iface,p in interfaces.items()if iface.startswith(B+'.') and not iface.startswith(O+'.')}for path,interfaces in objects.items()if any(iface.startswith(B+'.')and not iface.startswith(O+'.')for iface in interfaces)},));return
            state['writes']+=1
            if iface==B+'.AgentManager1':
                if method=='RegisterAgent':state['agent']=sender;state['agentPath']=p[0];state['bluezRegisters']+=1
                answer(inv);return
            if iface==O+'.AgentManager1':
                state['obexAttempts']+=1
                if state['obexReject']:inv.return_dbus_error(O+'.Error.AlreadyExists','other agent');return
                state['obexAgent']=sender;state['obexPath']=p[0];state['obexRegisters']+=1;answer(inv);return
            if iface==B+'.Adapter1':
                if method=='StartDiscovery':discovery_clients.setdefault(path,set()).add(sender);setp(system,path,iface,'Discovering',v('b',True))
                elif method=='StopDiscovery':discovery_clients.setdefault(path,set()).discard(sender);setp(system,path,iface,'Discovering',v('b',bool(discovery_clients[path])))
                elif method=='RemoveDevice':objects.pop(p[0],None)
                answer(inv);return
            if iface==B+'.Device1':
                if method=='Pair':
                    pair_wait.append(inv);invoke_agent('RequestConfirmation','(ou)',(path,7),'pairResult',inv);return
                if method=='CancelPairing':invoke_agent('Cancel','()',());
                if method in ('Connect','Disconnect'):setp(system,path,iface,'Connected',v('b',method=='Connect'))
                answer(inv);return
            if iface==O+'.Client1':
                if method=='CreateSession':answer(inv,'(o)',(new_session(True,p[0]),))
                elif method=='RemoveSession':state['removedSessions'].append(p[0]);answer(inv)
                return
            if iface==O+'.ObjectPush1':
                file=Path(p[0]);assert file.is_file();path=new_transfer(path,file.name,file.stat().st_size);answer(inv,'(oa{sv})',(path,props(path,O+'.Transfer1')));return
            if iface==O+'.Transfer1' and method=='Cancel':
                state['cancelCalls']+=1
                if state['holdCancel']:held_cancels.append(inv);state['heldCancels']+=1;return
                setp(session,path,iface,'Status',v('s','error'));answer(inv);return
            raise AssertionError((iface,method))
        except Exception as e:inv.return_dbus_error('org.nidara.Test.Error',str(e));print('FAKE ERROR',e,flush=True)
    export(session,TP,T,[('Command',('s','s'),('s',))])
    export(system,'/','org.freedesktop.DBus.ObjectManager',[('GetManagedObjects',(),('a{oa{sa{sv}}}',))])
    export(system,'/org/bluez',B+'.AgentManager1',[('RegisterAgent',('o','s'),()),('RequestDefaultAgent',('o',),())])
    for adapter,address in [(A,'00:11:22:33:44:55'),(A2,'00:11:22:33:44:66')]:
        export(system,adapter,B+'.Adapter1',[('StartDiscovery',(),()),('StopDiscovery',(),()),('RemoveDevice',('o',),())],{'Powered':v('b',True),'Discoverable':v('b',False),'DiscoverableTimeout':v('u',180),'Discovering':v('b',False),'Pairable':v('b',True),'Address':v('s',address),'Name':v('s','Fixture adapter'),'Alias':v('s','Fixture adapter'),'UUIDs':v('as',[])})
    export(system,D,B+'.Device1',[('Pair',(),()),('CancelPairing',(),()),('Connect',(),()),('Disconnect',(),())],{'Adapter':v('o',A),'Address':v('s','AA:BB:CC:DD:EE:FF'),'Name':v('s','Fixture keyboard'),'Alias':v('s','\u202eFixture\u200e keyboard\u200f\u061c\n'),'Paired':v('b',False),'Trusted':v('b',False),'Blocked':v('b',False),'Connected':v('b',False),'RSSI':v('n',-30),'ServicesResolved':v('b',False),'UUIDs':v('as',['test-service'])})
    export(system,D,B+'.Battery1',(),{'Percentage':v('y',70)})
    export(session,'/org/bluez/obex',O+'.AgentManager1',[('RegisterAgent',('o',),())])
    export(session,'/org/bluez/obex',O+'.Client1',[('CreateSession',('s','a{sv}'),('o',)),('RemoveSession',('o',),())])
    print('READY',flush=True);GLib.MainLoop().run()
def exercise(binary,root,managed=False):
    root=Path(root);session=conn(os.environ['DBUS_SESSION_BUS_ADDRESS']);system=conn(os.environ['DBUS_SYSTEM_BUS_ADDRESS'])
    logs=[(root/'peer.log').open('w'),(root/'daemon.log').open('w')];peer=daemon=None;extra=[]
    try:
        peer=subprocess.Popen([sys.executable,__file__,'--fake',str(root)],stdout=logs[0],stderr=logs[0])
        def ctrl(cmd,data=None):return json.loads(call(session,T,TP,T,'Command','(ss)',(cmd,json.dumps(data)))[0])
        wait(lambda:'READY'in(root/'peer.log').read_text(),'fake ready')
        if not managed:daemon=subprocess.Popen([binary,'--bluetooth'],stdout=logs[1],stderr=logs[1])
        def bt(method,sig=None,args=(),bus=None,timeout=8000):return call(bus or session,N,P,I,method,sig,args,timeout)
        def snapshot():return json.loads(bt('Snapshot')[2])
        def ready():
            try:return snapshot().get('pairAgentRegistered') and snapshot().get('receiveAgentRegistered')
            except GLib.Error:return False
        wait(ready,'agents registered')
        check(ctrl('Info')['agentPath']!='/org/nidara/bluetooth/agent','agent identity differs from TS')
        check(len(snapshot()['adapters'])==2 and snapshot()['devices'][0]['adapter']==A,'multiple adapters and typed device parent')
        check(snapshot()['devices'][0]['batteryPercent']==70,'Battery1 percentage')
        ctrl('Battery',None);wait(lambda:snapshot()['devices'][0]['batteryPercent']is None,'battery interface removal')
        ctrl('Battery',0);wait(lambda:snapshot()['devices'][0]['batteryPercent']==0,'zero battery distinct from absent')
        bt('SetPowered','(ob)',(A2,False));check(not snapshot()['adapters'][1]['powered'] and snapshot()['adapters'][0]['powered'],'power targets explicit adapter')
        bt('SetAdapterAlias','(os)',(A,'Test host'));check(snapshot()['adapters'][0]['alias']=='Test host','adapter alias confirmed before reply')
        bt('SetBlocked','(ob)',(D,True));check(snapshot()['devices'][0]['blocked'],'block device')
        bt('SetBlocked','(ob)',(D,False));bt('Connect','(o)',(D,));check(snapshot()['devices'][0]['connected'],'connect confirmed')
        bt('Disconnect','(o)',(D,));check(not snapshot()['devices'][0]['connected'],'disconnect confirmed')
        ui=conn(os.environ['DBUS_SESSION_BUS_ADDRESS']);spy=conn(os.environ['DBUS_SESSION_BUS_ADDRESS']);extra.extend([ui,spy]);questions=[];updates=[];closed=[];leaks=[];announced=[]
        for member,dest in [('Request',questions),('RequestUpdated',updates),('RequestClosed',closed),('Updated',announced)]:ui.signal_subscribe(None,I,member,P,None,Gio.DBusSignalFlags.NONE,lambda c,s,p,i,m,x,dest=dest:dest.append(x.unpack()))
        spy.signal_subscribe(None,I,'Request',P,None,Gio.DBusSignalFlags.NONE,lambda c,s,p,i,m,x:leaks.append(x.unpack()))
        bt('RegisterUi',bus=ui);fails(lambda:bt('RegisterUi',bus=spy),'Busy')
        for method,sig,args in [('RequestPinCode','(o)',(D,)),('Cancel',None,())]:fails(lambda:call(system,ctrl('Info')['agent'],ctrl('Info')['agentPath'],B+'.Agent1',method,sig,args),'NotAuthorized')
        for method,sig,args in [('AuthorizePush','(o)',('/org/bluez/obex/server/not_ours',)),('Cancel',None,())]:
            fails(lambda:call(session,ctrl('Info')['obexAgent'],ctrl('Info')['obexPath'],O+'.Agent1',method,sig,args),'NotAuthorized')
        before=len(questions);completion=[]
        def done(c,res):
            try:c.call_finish(res);completion.append(True)
            except GLib.Error as e:completion.append(str(e))
        session.call(N,P,I,'Pair',v('(o)',(D,)),None,Gio.DBusCallFlags.NONE,150000,None,done)
        wait(lambda:len(questions)>before,'pairing question');epoch,rid,raw=questions[-1];check(json.loads(raw)['deviceName']=='_Fixture_ keyboard___'and json.loads(raw)['address']=='AA:BB:CC:DD:EE:FF','pair consent sanitizes remote label and keeps address');check(json.loads(raw)['code']=='000007','pairing confirmation formatted')
        fails(lambda:bt('ReplyRequest','(ttbs)',(epoch,rid,True,''),bus=spy),'Denied')
        bt('ReplyRequest','(ttbs)',(epoch,rid,True,''),bus=ui);wait(lambda:completion,'Pair completes')
        check(completion==[True] and snapshot()['devices'][0]['paired'] and snapshot()['devices'][0]['trusted'],'pair trusts only after success without UI deadlock')
        check(not leaks,'consent requests unicast only');check('000007'not in bt('Snapshot')[2],'Snapshot redacts passcodes')
        for kind,value in [('pin','abc123'),('passkey','000008')]:
            before=len(questions);ctrl('Prompt',{'kind':kind});wait(lambda:len(questions)>before,kind+' question');epoch,rid,_=questions[-1]
            if kind=='passkey':fails(lambda:bt('ReplyRequest','(ttbs)',(epoch,rid,True,'12x'),bus=ui),'Invalid')
            bt('ReplyRequest','(ttbs)',(epoch,rid,True,value),bus=ui);wait(lambda:ctrl('Info')['promptResult']is not None,'prompt answer');check(ctrl('Info')['promptResult']['ok'],'typed '+kind+' answer')
            fails(lambda:bt('ReplyRequest','(ttbs)',(epoch,rid,True,value),bus=ui),'Conflict')
        before=len(questions);ctrl('Prompt',{'kind':'display','entered':0});wait(lambda:len(questions)>before,'display question')
        ctrl('Prompt',{'kind':'display','entered':3});wait(lambda:updates,'entered progress');check(json.loads(updates[-1][2])['entered']==3 and len(questions)==before+1,'DisplayPasskey updates same dialog')
        ctrl('Prompt',{'kind':'cancel'});wait(lambda:closed,'display close')
        ctrl('Trusted',False);ctrl('Paired',False)
        for kind in ('authorize','service'):
            before=len(questions);ctrl('Prompt',{'kind':kind});wait(lambda:len(questions)>before,'untrusted '+kind)
            q=questions[-1];bt('ReplyRequest','(ttbs)',(q[0],q[1],False,''),bus=ui)
            wait(lambda:ctrl('Info')['promptResult']is not None,'untrusted rejection');check(not ctrl('Info')['promptResult']['ok'],'untrusted '+kind+' requires consent')
        before=len(questions);ctrl('Prompt',{'kind':'pin'});wait(lambda:len(questions)>before,'question before device removal')
        ctrl('Device',False);wait(lambda:ctrl('Info')['promptResult']is not None,'device loss cancels request');check(not ctrl('Info')['promptResult']['ok'],'removed device cannot retain a pending question')
        ctrl('Device',True);wait(lambda:len(snapshot()['devices'])==1,'device reappears');ctrl('Trusted',True);ctrl('Paired',True)
        for trusted in (True,False):
            ctrl('Trusted',trusted);ctrl('Paired',trusted)
            for uuid in ('1106','00001106-0000-1000-8000-00805F9B34FB'):
                before=len(questions);ctrl('Prompt',{'kind':'service','uuid':uuid});wait(lambda:ctrl('Info')['promptResult']is not None,'FTP refusal')
                check(not ctrl('Info')['promptResult']['ok']and len(questions)==before,'FTP denied before paired/trusted authorization')
        ctrl('Trusted',True);ctrl('Paired',True)
        ctrl('Advertise',['00001106-0000-1000-8000-00805f9b34fb','00005005-0000-1000-8000-0002ee000001'])
        wait(lambda:len(snapshot()['fileReceptionPolicy']['advertisedUnsupportedServers'])==2,'local file-server advertisement warning')
        check(snapshot()['fileReceptionPolicy']['deploymentStatus']=='unsupported-server-advertised','Snapshot warns without attributing UUIDs to obexd')
        ctrl('Advertise',[]);wait(lambda:snapshot()['fileReceptionPolicy']['deploymentStatus']=='unverified','absence is not proof of safe deployment')
        before=len(questions);ctrl('Prompt',{'kind':'service'});wait(lambda:ctrl('Info')['promptResult']is not None,'trusted authorization');check(ctrl('Info')['promptResult']['ok']and len(questions)==before,'trusted service authorization is distinct from file consent')
        client=conn(os.environ['DBUS_SESSION_BUS_ADDRESS']);extra.append(client)
        h1=bt('HoldDiscovery','(o)',(A,),bus=ui)[0];h2=bt('HoldDiscovery','(o)',(A,),bus=client)[0]
        fails(lambda:bt('ReleaseDiscovery','(t)',(h1,),bus=spy),'Denied')
        bt('ReleaseDiscovery','(t)',(h1,),bus=ui);check(snapshot()['adapters'][0]['discovering'],'discovery retains other lease')
        client.close_sync(None);wait(lambda:not snapshot()['adapters'][0]['discovering'],'discovery client death releases last lease')
        visible=bt('HoldDiscoverable','(o)',(A,),bus=ui)[0];check(snapshot()['adapters'][0]['discoverable']and snapshot()['adapters'][0]['discoverableTimeout']==180,'visibility has finite BlueZ timeout')
        bt('ReleaseDiscoverable','(t)',(visible,),bus=ui);check(not snapshot()['adapters'][0]['discoverable'],'last visibility hold turns off own visibility')
        ctrl('ExternalVisible',True);visible=bt('HoldDiscoverable','(o)',(A,),bus=ui)[0]
        bt('ReleaseDiscoverable','(t)',(visible,),bus=ui);check(snapshot()['adapters'][0]['discoverable']and snapshot()['adapters'][0]['discoverableTimeout']==0,'preexisting external visibility is preserved')
        ctrl('ExternalVisible',False)
        call(system,B,A,B+'.Adapter1','StartDiscovery');own=bt('HoldDiscovery','(o)',(A,),bus=ui)[0]
        bt('ReleaseDiscovery','(t)',(own,),bus=ui);check(snapshot()['adapters'][0]['discovering'],'release does not stop another BlueZ discovery client')
        call(system,B,A,B+'.Adapter1','StopDiscovery');wait(lambda:not snapshot()['adapters'][0]['discovering'],'external discovery ends')
        pump();before=len(announced);started=time.monotonic();ctrl('Burst');wait(lambda:ctrl('Info').get('burst')==100,'RSSI burst');wait(lambda:snapshot()['devices'][0]['rssi']==-20,'last RSSI wins');pump();check(len(announced)-before<=math.ceil((time.monotonic()-started)*4)+1,'discovery updates coalesced to four per second plus boundary')
        # File consent: every incoming object asks even for a paired/trusted peer.
        def incoming(name='received.txt',size=5):
            before=len(questions);ctrl('Incoming',{'name':name,'size':size});wait(lambda:len(questions)>before,'incoming consent');return questions[-1]
        def accept(q):epoch,rid,_=q;bt('ReplyRequest','(ttbs)',(epoch,rid,True,''),bus=ui);wait(lambda:ctrl('Info')['incomingResult']is not None,'incoming result');check(ctrl('Info')['incomingResult']['ok'],'consented incoming receives private stage')
        q=incoming();check(json.loads(q[2])['size']==5,'incoming consent includes known size');check(json.loads(q[2])['deviceName']=='_Fixture_ keyboard___'and json.loads(q[2])['address']=='AA:BB:CC:DD:EE:FF','file consent sanitizes remote label and keeps address')
        bt('ReplyRequest','(ttbs)',(q[0],q[1],False,''),bus=ui);wait(lambda:ctrl('Info')['incomingResult']is not None,'incoming reject');check(not ctrl('Info')['incomingResult']['ok'],'trusted file still requires explicit consent')
        downloads=root/'downloads';downloads.mkdir(exist_ok=True);(downloads/'received.txt').write_text('preserve')
        outside=root/'outside';outside.write_text('untouched');(downloads/'received (1).txt').symlink_to(outside)
        accept(incoming());ctrl('Complete',{'payload':'hello','remove':True});wait(lambda:any(t['status']=='received'for t in snapshot()['transfers']),'received status after vanished complete object')
        check((downloads/'received.txt').read_text()=='preserve'and outside.read_text()=='untouched'and(downloads/'received (2).txt').read_text()=='hello','collision and symlink never overwrite')
        received=next(t for t in snapshot()['transfers']if t['status']=='received');check(received['publishedName']=='received (2).txt'and received['direction']=='incoming','published name and incoming direction retained')
        q=incoming('../../unsafe\\name',None);check(json.loads(q[2])['size']is None,'unknown size is null, not zero');accept(q);ctrl('Complete',{'payload':'hello'})
        wait(lambda:sum(t['status']=='received'for t in snapshot()['transfers'])==2,'unknown-size publication');check(all('/'not in t['publishedName']and'..'not in t['publishedName'] for t in snapshot()['transfers']if t['status']=='received'),'incoming names contain no traversal')
        with tempfile.TemporaryDirectory(prefix='nidara-bt-ram-',dir='/dev/shm') as other:
            ctrl('Set',{'incomingRoot':other});q=incoming('ram-root.txt')
            bt('ReplyRequest','(ttbs)',(q[0],q[1],True,''),bus=ui);wait(lambda:ctrl('Info')['incomingResult']is not None,'RAM root refused')
            check(not ctrl('Info')['incomingResult']['ok']and not list(Path(other).iterdir()),'RAM-backed obex root never authorizes staging')
            wait(lambda:any(t['error']=='persistent-root-required'for t in snapshot()['transfers']),'RAM-root refusal exposed in Snapshot')
            ctrl('Set',{'incomingRoot':str(root/'obex')})
        before=len(questions);ctrl('Incoming',{'name':'too-large.txt','size':2**64-1});wait(lambda:ctrl('Info')['incomingResult']is not None,'oversized admission refusal')
        check(not ctrl('Info')['incomingResult']['ok']and not (downloads/'too-large.txt').exists(),'known size overflow refuses before payload staging');check(len(questions)==before,'known insufficient space rejects without consent prompt')
        wait(lambda:any(t['error']=='no-space'for t in snapshot()['transfers']),'disk refusal visible in Snapshot')
        accept(incoming('cancel.txt'));transfer=next(t for t in snapshot()['transfers']if t['status']=='queued');stage=Path(ctrl('Info')['incomingResult']['path'])
        bt('CancelTransfer','(tt)',(transfer['epoch'],transfer['id']));wait(lambda:not stage.exists(),'cancel removes own incoming partial')
        accept(incoming('racy.txt'));transfer=next(t for t in snapshot()['transfers']if t['status']=='queued')
        ctrl('Set',{'holdCancel':True});late=[]
        def late_cancel(c,res):
            try:c.call_finish(res);late.append('ok')
            except GLib.Error as e:late.append(str(e))
        session.call(N,P,I,'CancelTransfer',v('(tt)',(transfer['epoch'],transfer['id'])),None,Gio.DBusCallFlags.NONE,10000,None,late_cancel)
        wait(lambda:ctrl('Info')['heldCancels']==1,'cancel pending at provider');ctrl('Complete',{'payload':'hello'})
        wait(lambda:any(t['publishedName']=='racy.txt'for t in snapshot()['transfers']),'publication wins cancellation race');ctrl('ReleaseCancel')
        wait(lambda:late,'late cancel reply');check('Conflict'in late[0]and(downloads/'racy.txt').read_text()=='hello','late cancel cannot relabel or remove a received file')
        source=root/'send.txt';source.write_text('outgoing')
        outgoing=bt('SendFile','(os)',(D,str(source)))[0];ctrl('Progress',{'bytes':4});wait(lambda:any(t['id']==outgoing and t['transferred']==4 for t in snapshot()['transfers']),'outgoing progress')
        transfer=next(t for t in snapshot()['transfers']if t['id']==outgoing);bt('CancelTransfer','(tt)',(transfer['epoch'],outgoing));check(ctrl('Info')['cancelCalls']>=2,'cancel reaches obexd for both directions');wait(lambda:ctrl('Info')['removedSessions'],'cancel releases only own outgoing session')
        fails(lambda:bt('SendFile','(os)',(D,str(root))),'Invalid')
        # No UI and a vanished UI must reject without authorizing storage.
        bt('UnregisterUi',bus=ui);ctrl('Incoming',{'name':'no-ui','size':5});wait(lambda:ctrl('Info')['incomingResult']is not None,'no UI rejects');check(not ctrl('Info')['incomingResult']['ok'],'missing UI cannot accept files')
        bt('RegisterUi',bus=ui);q=incoming('ui-lost');ui.close_sync(None);wait(lambda:ctrl('Info')['incomingResult']is not None,'UI death rejects');check(not ctrl('Info')['incomingResult']['ok'],'UI loss rejects incoming request')
        ui=conn(os.environ['DBUS_SESSION_BUS_ADDRESS']);extra.append(ui);questions.clear();ui.signal_subscribe(None,I,'Request',P,None,Gio.DBusSignalFlags.NONE,lambda c,s,p,i,m,x:questions.append(x.unpack()));bt('RegisterUi',bus=ui)
        q=incoming('timeout');
        if managed or os.environ.get('BLUETOOTH_TEST_QUICK')=='1':bt('CancelRequest','(tt)',(q[0],q[1]),bus=ui)
        wait(lambda:ctrl('Info')['incomingResult']is not None,'incoming deadline/cancel',50)
        check(not ctrl('Info')['incomingResult']['ok'],'incoming consent deadline/cancel rejects unanswered request')
        fails(lambda:bt('ReplyRequest','(ttbs)',(q[0],q[1],True,''),bus=ui),'Conflict')
        q=incoming('obex-lost');ctrl('ObexDrop');wait(lambda:ctrl('Info')['incomingResult']is not None,'obex owner loss cancels consent')
        check(not ctrl('Info')['incomingResult']['ok'],'OBEX loss invalidates pending consent')
        wait(lambda:not snapshot()['obexAvailable'],'obex unavailable')
        ctrl('Set',{'obexReject':True});attempts=ctrl('Info')['obexAttempts'];ctrl('ObexRestore')
        wait(lambda:ctrl('Info')['obexAttempts']>attempts,'refused agent registration')
        check(snapshot()['available']and not snapshot()['receiveAgentRegistered'],'foreign OBEX agent refusal leaves Bluetooth available without receive')
        bt('SetBlocked','(ob)',(D,True));check(snapshot()['devices'][0]['blocked'],'device control independent of OBEX agent')
        ctrl('Set',{'obexReject':False});wait(ready,'OBEX retry registers only our own agent')
        old_epoch=bt('Snapshot')[0];ctrl('Drop');wait(lambda:not snapshot()['available'],'BlueZ loss clears devices');check(snapshot()['devices']==[]and 'fileReceptionPolicy'in snapshot()and not snapshot()['pairAgentRegistered'],'no stale BlueZ devices or capabilities')
        ctrl('Restore');wait(ready,'BlueZ restart and registration');check(bt('Snapshot')[0]!=old_epoch,'provider restart advances epoch')
        if managed:return
        daemon.terminate();daemon.wait(timeout=5);daemon=None
        before=ctrl('Info');daemon=subprocess.Popen([binary,'--bluetooth-read-only'],stdout=logs[1],stderr=logs[1])
        def readonly_ready():
            try:return bool(snapshot().get('available'))
            except GLib.Error:return False
        wait(readonly_ready,'readonly ready')
        for method,sig,args in [('SetPowered','(ob)',(A,False)),('HoldDiscovery','(o)',(A,)),('HoldDiscoverable','(o)',(A,)),('SendFile','(os)',(D,str(source))),('RegisterUi',None,())]:fails(lambda:bt(method,sig,args),'Denied')
        after=ctrl('Info');check(after['writes']==before['writes']and after['bluezRegisters']==before['bluezRegisters']and after['obexRegisters']==before['obexRegisters'],'readonly has zero provider writes or registrations')
        check(True,'all Bluetooth1 mutations used two private fake providers')
    finally:
        for c in extra:
            if not c.is_closed():c.close_sync(None)
        for process in (daemon,peer):
            if process is not None:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
        for f in logs:f.close()
def outer(binary):
    repo=Path(__file__).resolve().parents[2];(repo/'target').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='bluetooth-',dir=repo/'target')as temp:
        root=Path(temp);buses=[]
        try:
            addresses=[]
            for name in ('system','session'):
                address='unix:path='+str(root/name);buses.append(subprocess.Popen(['dbus-daemon','--session','--nofork','--nopidfile','--address='+address]));addresses.append(address);wait(lambda:(root/name).exists(),'private '+name+' socket')
            (root/'config').mkdir();(root/'downloads').mkdir();(root/'config/user-dirs.dirs').write_text('XDG_DOWNLOAD_DIR="'+str(root/'downloads')+'"\n')
            env={'PATH':os.environ.get('PATH','/usr/bin'),'HOME':temp,'XDG_CONFIG_HOME':temp+'/config','XDG_DATA_HOME':temp+'/data','XDG_CACHE_HOME':temp+'/cache','XDG_STATE_HOME':temp+'/state','DBUS_SYSTEM_BUS_ADDRESS':addresses[0],'DBUS_SESSION_BUS_ADDRESS':addresses[1],'BLUETOOTH_TEST_QUICK':os.environ.get('BLUETOOTH_TEST_QUICK','')}
            result=subprocess.run([sys.executable,__file__,'--inside',str(Path(binary).resolve()),temp],env=env)
            if result.returncode:
                for name in ('daemon.log','peer.log'):print((root/name).read_text())
            return result.returncode
        finally:
            for bus in buses:bus.terminate();bus.wait(timeout=5)
if __name__=='__main__':
    if sys.argv[1]=='--fake':fake(sys.argv[2])
    elif sys.argv[1]=='--inside':exercise(sys.argv[2],sys.argv[3])
    else:sys.exit(outer(sys.argv[1]))
