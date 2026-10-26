#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Network1 against independent NM and Secret Service peers, on disposable buses.

Invoked by cargo test (no new CI job). All mutation and agent registration stay on
these private buses. --inside is also usable from rust-session.sh with BOTH private
bus addresses provided by the outer test; never sends a write to the host NM.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from gi.repository import Gio, GLib

NM = 'org.freedesktop.NetworkManager'
ROOT = '/org/freedesktop/NetworkManager'
DEV = ROOT + '/Devices/1'
WIFI = NM + '.Device.Wireless'
DEVICE = NM + '.Device'
AP = ROOT + '/AccessPoint/1'
PROF = ROOT + '/Settings/1'
PROF_WIRED = ROOT + '/Settings/2'
PROF_HIDDEN = ROOT + '/Settings/3'
PROF_VPN = ROOT + '/Settings/4'
WIRED = ROOT + '/Devices/2'
ACTIVE = ROOT + '/ActiveConnection/1'
NET = 'org.nidara.Network'
IFACE = NET + '1'
NETPATH = '/org/nidara/Network'
AGENT = ROOT + '/SecretAgent'
SECRET = '/org/freedesktop/secrets'
SS = 'org.freedesktop.Secret'
context = GLib.MainContext.default()
def pump():
    while context.pending():
        context.iteration(False)
def wait(predicate, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump()
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('timeout: ' + label)
def connection(address):
    return Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
def call(bus, dest, path, iface, method, sig=None, values=(), timeout=6000):
    return bus.call_sync(dest, path, iface, method, GLib.Variant(sig, values) if sig else None, None, Gio.DBusCallFlags.NO_AUTO_START, timeout, None).unpack()
def check(ok, label):
    if not ok:
        raise AssertionError(label)
    print('PASS: ' + label, flush=True)
def fails(fn, suffix):
    try:
        fn()
    except GLib.Error as e:
        check(suffix in str(e), 'refuses ' + suffix)
        return
    raise AssertionError('accepted ' + suffix)
def v(sig, value):
    return GLib.Variant(sig, value)
def profile(uuid='wifi', kind='802-11-wireless'):
    p = {'connection': {'uuid': v('s', uuid), 'id': v('s', 'Test ' + uuid), 'type': v('s', kind), 'autoconnect': v('b', True), 'timestamp': v('t', 4)}, 'ipv4': {'method': v('s', 'auto')}, 'ipv6': {'method': v('s', 'auto')}}
    if kind == '802-11-wireless':
        p['802-11-wireless'] = {'ssid': v('ay', b'Test'), 'hidden': v('b', uuid == 'hidden')}
        p['802-11-wireless-security'] = {'psk-flags': v('u', 1), 'key-mgmt': v('s', 'wpa-psk')}
    else:
        p[kind] = {}
    return p

def fake():
    nm_bus = connection(os.environ['DBUS_SYSTEM_BUS_ADDRESS'])
    bus = connection(os.environ['DBUS_SESSION_BUS_ADDRESS'])
    for name in (NM, 'org.freedesktop.secrets', 'org.nidara.NetworkTest'):
        owner_bus = nm_bus if name == NM else bus
        assert call(owner_bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', '(su)', (name, 4))[0] in (1,4), 'fake must own its names'
    profiles = {PROF: profile(), PROF_WIRED: profile('wired', '802-3-ethernet'), PROF_HIDDEN: profile('hidden'), PROF_VPN: profile('vpn', 'vpn')}
    calls, items, retained = [], {}, []
    state = {'agent': '', 'result': None, 'radio': True, 'strength': 70, 'enterprise': False, 'reapplyFail': False, 'active': ACTIVE, 'activeProfile': PROF, 'activeState': 2, 'registrations': 0, 'carrier': True, 'autoconnect': True, 'locked': False, 'saveflags': 1, 'sequence': 0, 'noCollection': False, 'created': 4, 'lastCreated': '', 'wifiPresent': True}
    objects = {}
    modified = {}
    held_stores = []
    state.update(stores=0, clock=100, holdStores=False, heldStores=0, newNeedsSecrets=False, profileDeletes=0)
    def method_xml(name, ins=(), outs=()):
        return '<method name="'+name+'">'+''.join('<arg type="'+t+'" direction="in"/>' for t in ins)+''.join('<arg type="'+t+'" direction="out"/>' for t in outs)+'</method>'
    def export(path, iface, methods=(), props=None):
        props = props or {}
        xml = '<node><interface name="'+iface+'">'+''.join(method_xml(*m) for m in methods)+''.join('<property name="'+k+'" type="'+t+'" access="readwrite"/>' for k,t in props.items())+'</interface></node>'
        info = Gio.DBusNodeInfo.new_for_xml(xml)
        retained.append(info)
        export_bus = nm_bus if iface.startswith(NM) else bus
        obj = export_bus.register_object(path, info.interfaces[0], dispatch, getprop, setprop)
        objects[(path, iface)] = obj
    def properties(path, iface):
        if iface == NM:
            return {'WirelessEnabled': v('b', state['radio']), 'WirelessHardwareEnabled': v('b', True), 'State': v('u', 70), 'Connectivity': v('u', 4), 'ActiveConnections': v('ao', [ACTIVE] if state['active'] != '/' else [])}
        if iface == DEVICE:
            return {'DeviceType': v('u', 2 if path == DEV else 1), 'Interface': v('s', 'wlan-test' if path == DEV else 'eth-test'), 'State': v('u', 100 if state['active'] != '/' else 30), 'StateReason': v('(uu)', (100, 0)), 'Autoconnect': v('b', state['autoconnect']), 'ActiveConnection': v('o', state['active']), 'Ip4Config': v('o', ROOT+'/IP4Config/1'), 'Ip6Config': v('o', '/'), 'AvailableConnections': v('ao', ([] if not state['carrier'] else [PROF_WIRED]) if path == WIRED else [PROF, PROF_HIDDEN])}
        if iface == WIFI:
            return {'ActiveAccessPoint': v('o', AP), 'Bitrate': v('u', 54000), 'LastScan': v('x', 9)}
        if iface == NM + '.Device.Wired':
            return {'Carrier': v('b', state['carrier']), 'Speed': v('u', 1000), 'HwAddress':v('s','00:aa:bb:cc:dd:ee'), 'PermHwAddress':v('s','00:aa:bb:cc:dd:ee')}
        if iface == NM + '.AccessPoint':
            return {'Ssid': v('ay', b'Test'), 'Strength': v('y', state['strength']), 'Frequency': v('u', 5180), 'Flags': v('u', 1), 'WpaFlags': v('u', 0), 'RsnFlags': v('u', 0x200 if state['enterprise'] else 0x100), 'HwAddress': v('s', '00:11:22:33:44:55')}
        if iface == NM + '.Connection.Active':
            p = profiles.get(state['activeProfile'], profile())['connection']
            return {'Connection': v('o', state['activeProfile']), 'Uuid': p['uuid'], 'Type': p['type'], 'State': v('u', state['activeState']), 'Vpn': v('b', state['activeProfile'] == PROF_VPN), 'Default': v('b', True), 'Devices': v('ao', [DEV])}
        if iface == NM + '.IP4Config':
            return {'AddressData': v('aa{sv}', [{'address': v('s', '192.0.2.4'), 'prefix': v('u', 24)}]), 'NameserverData': v('aa{sv}', [{'address': v('s', '192.0.2.1')}]), 'Domains': v('as', ['example']), 'Gateway': v('s', '192.0.2.1')}
        if iface == SS + '.Item':
            return {'Attributes': v('a{ss}', items[path][0]), 'Locked': v('b', state['locked']), 'Modified':v('t',modified[path])}
        return {}
    def getprop(bus, sender, path, iface, key):
        return properties(path, iface).get(key)
    def setprop(bus, sender, path, iface, key, value):
        if iface == NM and key == 'WirelessEnabled':
            state['radio'] = value.unpack()
        elif iface == DEVICE and key == 'Autoconnect':
            state['autoconnect'] = value.unpack()
        else:
            return False
        calls.append(['Set', path, key, value.unpack()])
        return True
    def answer(inv, signature='()', args=()):
        inv.return_value(v(signature, args))
    def store_item(inv, p):
        props, secret, replace = p
        attrs = props[SS+'.Item.Attributes']
        existing = next((path for path,(a,_) in items.items() if a==attrs), None)
        item = existing or SECRET+'/item/'+str(len(items)+1)
        items[item] = (attrs, bytes(secret[2]).decode())
        state['clock']+=1
        modified[item]=state['clock']
        state['stores']+=1
        if (item,SS+'.Item') not in objects:
            export(item, SS+'.Item', [('Delete',(),('o',))], {'Attributes':'a{ss}', 'Locked':'b', 'Modified':'t'})
        answer(inv, '(oo)', (item,'/'))
    def dispatch(bus, sender, path, iface, method, parameters, inv):
        try:
            p = parameters.unpack()
            if iface == 'org.nidara.NetworkTest':
                if method == 'Info':
                    answer(inv, '(s)', (json.dumps(dict(state, calls=calls, items=len(items), itemUuids=[a['connection-uuid'] for a,_ in items.values()])),))
                elif method == 'ReleaseStores':
                    state['holdStores']=False
                    for pending,parameters in held_stores:
                        store_item(pending,parameters)
                    held_stores.clear()
                    answer(inv)
                elif method == 'Seed':
                    item=SECRET+'/item/'+('libsecret' if p[0]=='libsecret' else 'duplicate')
                    if p[0]=='remove_duplicate':
                        items.pop(SECRET+'/item/duplicate',None)
                    else:
                        attrs={'connection-uuid':'wifi','setting-name':'802-11-wireless-security','setting-key':'psk'}
                        if p[0]=='libsecret':
                            attrs['xdg:schema']='org.freedesktop.NetworkManager.Connection'
                        items[item]=(attrs,'old-libsecret-key' if p[0]=='libsecret' else 'old-duplicate-key')
                        modified[item]=10 if p[0]=='libsecret' else 1
                        if (item,SS+'.Item') not in objects:
                            export(item,SS+'.Item',[('Delete',(),('o',))],{'Attributes':'a{ss}','Locked':'b','Modified':'t'})
                    answer(inv)
                elif method == 'Set':
                    state[p[0]] = json.loads(p[1]); answer(inv)
                elif method == 'Drop':
                    call(nm_bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReleaseName', '(s)', (NM,)); answer(inv)
                elif method == 'Restore':
                    call(nm_bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', '(su)', (NM, 4)); answer(inv)
                elif method in ('Ask', 'Cancel', 'Save', 'Delete'):
                    s = profile()
                    # Keep raw variants: GDBus .unpack() recursively removes them.
                    s['802-11-wireless-security']['psk-flags'] = v('u', state['saveflags'])
                    if method == 'Ask' and p[1]=='802-1x':
                        s['802-1x']={'eap':v('as',['peap']), 'identity':v('s','alice'), 'password-flags':v('u',1), 'password':v('s','system-eap-private')}
                    if method == 'Ask':
                        s['802-11-wireless-security']['psk'] = v('s','system-private-sentinel')
                    if method in ('Save', 'Delete'):
                        s['802-11-wireless-security']['psk'] = v('s', 'only-in-keyring')
                    method_nm = {'Ask':'GetSecrets','Cancel':'CancelGetSecrets','Save':'SaveSecrets','Delete':'DeleteSecrets'}[method]
                    if method == 'Ask':
                        flags, setting = p
                        args = v('(a{sa{sv}}osasu)', (s, PROF, setting, [], flags))
                    elif method == 'Cancel':
                        args = v('(os)', (PROF, '802-11-wireless-security'))
                    else:
                        args = v('(a{sa{sv}}o)', (s, PROF))
                    if method != 'Cancel':
                        state['sequence'] += 1
                        state['result'] = None
                    sequence = state['sequence']
                    def done(c, res):
                        try:
                            result = c.call_finish(res).unpack()
                            if method == 'Cancel' or sequence != state['sequence']:
                                return
                            state['result'] = {'ok':True,'hasSecret':bool(result and result[0]),'value':result[0].get('802-11-wireless-security', {}).get('psk') if result and isinstance(result[0], dict) else None}
                        except GLib.Error as e:
                            if method == 'Cancel' or sequence != state['sequence']:
                                return
                            state['result'] = {'ok':False,'error':str(e)}
                    nm_bus.call(state['agent'], AGENT, NM+'.SecretAgent', method_nm, args, None, Gio.DBusCallFlags.NONE, 130000, None, done)
                    answer(inv)
                return
            calls.append([method, path])
            if method == 'RegisterWithCapabilities':
                check(p == ('org.nidara.Session.NetworkAgent', 0), 'distinct agent identity and Wi-Fi capabilities')
                state['agent'] = sender; state['registrations'] += 1; answer(inv)
            elif method == 'GetDevices':
                answer(inv, '(ao)', ([DEV,WIRED] if state['wifiPresent'] else [WIRED],))
            elif method == 'ListConnections':
                answer(inv, '(ao)', (list(profiles),))
            elif method == 'GetSettings':
                answer(inv, '(a{sa{sv}})', (profiles[path],))
            elif method == 'Update':
                raw = parameters.get_child_value(0)
                profiles[path] = {s: {k: value for k,value in keys.items()} for s,keys in raw.unpack().items()}
                # Restore types from the actual wire, without guessing integer widths.
                profiles[path] = {}
                for i in range(raw.n_children()):
                    entry = raw.get_child_value(i); setting = entry.get_child_value(0).unpack(); values = entry.get_child_value(1)
                    profiles[path][setting] = {values.get_child_value(j).get_child_value(0).unpack(): values.get_child_value(j).get_child_value(1).get_variant() for j in range(values.n_children())}
                answer(inv)
            elif method == 'Delete' and iface == NM+'.Settings.Connection':
                profiles.pop(path); state['profileDeletes']+=1; answer(inv)
            elif method in ('AddConnection', 'AddAndActivateConnection'):
                state['created'] += 1
                newpath = ROOT+'/Settings/'+str(state['created'])
                state['lastCreated'] = newpath
                profiles[newpath] = profile('new', '802-3-ethernet' if method == 'AddConnection' else '802-11-wireless')
                template = parameters.get_child_value(0)
                for i in range(template.n_children()):
                    entry=template.get_child_value(i); name=entry.get_child_value(0).unpack(); keys=entry.get_child_value(1)
                    profiles[newpath].setdefault(name,{}).update({keys.get_child_value(j).get_child_value(0).unpack():keys.get_child_value(j).get_child_value(1).get_variant() for j in range(keys.n_children())})
                export(newpath, NM+'.Settings.Connection', [('GetSettings',(),('a{sa{sv}}',)),('Update',('a{sa{sv}}',),()),('Delete',(),())])
                if method == 'AddConnection':
                    answer(inv, '(o)', (newpath,))
                else:
                    state['activeProfile'] = newpath
                    if state['newNeedsSecrets']:
                        state['activeState']=1
                        def wrong_password(c,res):
                            try:
                                c.call_finish(res)
                            except GLib.Error:
                                pass
                            state['activeState']=4
                        nm_bus.call(state['agent'],AGENT,NM+'.SecretAgent','GetSecrets',v('(a{sa{sv}}osasu)',(profiles[newpath],newpath,'802-11-wireless-security',[],3)),None,Gio.DBusCallFlags.NONE,130000,None,wrong_password)
                    answer(inv, '(oo)', (newpath, ACTIVE))
            elif method == 'GetAllAccessPoints':
                answer(inv, '(ao)', ([AP],))
            elif method in ('Disconnect','DeactivateConnection'):
                state['active'] = '/'; answer(inv)
            elif method == 'ActivateConnection':
                state['activeProfile'] = p[0]; state['active'] = ACTIVE
                answer(inv, '(o)', (ACTIVE,))
            elif method in ('RequestScan', 'Reapply'):
                if method == 'Reapply' and state['reapplyFail']:
                    inv.return_dbus_error(NM+'.Device.Error.Failed', 'reapply refused')
                else:
                    answer(inv)
            elif method == 'OpenSession':
                check(p[0] == 'plain', 'Secret Service session algorithm')
                answer(inv, '(vo)', (v('s',''), SECRET+'/session/test'))
            elif method == 'Close':
                answer(inv)
            elif method == 'SearchItems':
                matches = [path for path,(attrs,_) in items.items() if all(attrs.get(k)==value for k,value in p[0].items())]
                answer(inv, '(aoao)', ([], matches) if state['locked'] else (matches, []))
            elif method == 'Unlock':
                if state['locked']:
                    answer(inv, '(aoo)', ([], SECRET+'/prompt/test'))
                else:
                    answer(inv, '(aoo)', (p[0], '/'))
            elif method == 'Prompt':
                answer(inv)
                def complete():
                    state['locked'] = False
                    bus.emit_signal(sender, path, SS+'.Prompt','Completed',v('(bv)',(False,v('ao',list(items)))))
                    return False
                GLib.idle_add(complete)
            elif method == 'GetSecrets':
                answer(inv, '(a{o(oayays)})', ({path:(p[1],[],list(items[path][1].encode()),'text/plain') for path in p[0]},))
            elif method == 'ReadAlias':
                answer(inv, '(o)', ('/' if state['noCollection'] else SECRET+'/collection/default',))
            elif method == 'CreateCollection':
                state['noCollection'] = False
                answer(inv, '(oo)', (SECRET+'/collection/default', '/'))
            elif method == 'CreateItem':
                if state['holdStores']:
                    held_stores.append((inv,p))
                    state['heldStores']+=1
                else:
                    store_item(inv,p)
            elif method == 'Delete' and iface == SS+'.Item':
                items.pop(path); answer(inv, '(o)', ('/',))
            else:
                inv.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod',method)
        except Exception as e:
            print('fake error:', iface, method, type(e).__name__, str(e), flush=True)
            inv.return_dbus_error('org.nidara.NetworkTest.Error',type(e).__name__)
    export(ROOT, NM, [('GetDevices',(),('ao',)),('ActivateConnection',('o','o','o'),('o',)),('DeactivateConnection',('o',),()),('AddAndActivateConnection',('a{sa{sv}}','o','o'),('o','o'))], {'WirelessEnabled':'b','WirelessHardwareEnabled':'b','State':'u','Connectivity':'u','ActiveConnections':'ao'})
    export(ROOT+'/Settings', NM+'.Settings', [('ListConnections',(),('ao',)),('AddConnection',('a{sa{sv}}',),('o',))])
    for path in list(profiles):
        export(path,NM+'.Settings.Connection',[('GetSettings',(),('a{sa{sv}}',)),('Update',('a{sa{sv}}',),()),('Delete',(),())])
    for path in (DEV,WIRED):
        export(path,DEVICE,[('Disconnect',(),()),('Reapply',('a{sa{sv}}','t','u'),())],{'DeviceType':'u','Interface':'s','State':'u','StateReason':'(uu)','Autoconnect':'b','ActiveConnection':'o','Ip4Config':'o','Ip6Config':'o','AvailableConnections':'ao'})
    export(DEV,WIFI,[('GetAllAccessPoints',(),('ao',)),('RequestScan',('a{sv}',),())],{'ActiveAccessPoint':'o','Bitrate':'u','LastScan':'x'})
    export(WIRED,NM+'.Device.Wired',props={'Carrier':'b','Speed':'u','HwAddress':'s','PermHwAddress':'s'})
    export(AP,NM+'.AccessPoint',props={'Ssid':'ay','Strength':'y','Frequency':'u','Flags':'u','WpaFlags':'u','RsnFlags':'u','HwAddress':'s'})
    export(ACTIVE,NM+'.Connection.Active',props={'Connection':'o','Uuid':'s','Type':'s','State':'u','Vpn':'b','Default':'b','Devices':'ao'})
    export(ROOT+'/IP4Config/1',NM+'.IP4Config',props={'AddressData':'aa{sv}','NameserverData':'aa{sv}','Domains':'as','Gateway':'s'})
    export(ROOT+'/AgentManager',NM+'.AgentManager',[('RegisterWithCapabilities',('s','u'),())])
    export('/test','org.nidara.NetworkTest',[('Info',(),('s',)),('Seed',('s',),()),('ReleaseStores',(),()),('Set',('s','s'),()),('Ask',('u','s'),()),('Cancel',(),()),('Save',(),()),('Delete',(),()),('Drop',(),()),('Restore',(),())])
    export(SECRET,SS+'.Service',[('OpenSession',('s','v'),('v','o')),('SearchItems',('a{ss}',),('ao','ao')),('Unlock',('ao',),('ao','o')),('GetSecrets',('ao','o'),('a{o(oayays)}',)),('ReadAlias',('s',),('o',)),('CreateCollection',('a{sv}','s'),('o','o'))])
    export(SECRET+'/session/test',SS+'.Session',[('Close',(),())])
    export(SECRET+'/collection/default',SS+'.Collection',[('CreateItem',('a{sv}','(oayays)','b'),('o','o'))])
    export(SECRET+'/prompt/test',SS+'.Prompt',[('Prompt',('s',),())])
    print('READY',flush=True)
    GLib.MainLoop().run()

def exercise(binary, directory, managed=False):
    address = os.environ['DBUS_SESSION_BUS_ADDRESS']
    bus = connection(address)
    def ctrl(method, sig=None, args=()):
        return call(bus,'org.nidara.NetworkTest','/test','org.nidara.NetworkTest',method,sig,args)
    def info():
        return json.loads(ctrl('Info')[0])
    def state(key, value):
        ctrl('Set','(ss)',(key,json.dumps(value)))
    def net(method, sig=None, args=(), c=None):
        return call(c or bus,NET,NETPATH,IFACE,method,sig,args,timeout=10000)
    def snapshot():
        epoch, revision, raw = net('Snapshot')
        return epoch, revision, json.loads(raw)
    def ready():
        try:
            return snapshot()[2]['available']
        except GLib.Error:
            return False
    peer_log = open(directory/'peer.log','w+')
    daemon_log = open(directory/'daemon.log','w+')
    peer = subprocess.Popen([sys.executable,__file__,'--fake'], stdout=peer_log,stderr=peer_log)
    daemon = None
    extra = []
    try:
        wait(lambda: 'READY' in (directory/'peer.log').read_text(), 'fake services')
        if not managed:
            daemon = subprocess.Popen([binary,'--network'],stdout=daemon_log,stderr=daemon_log)
        wait(ready, 'available Network1 snapshot')
        wait(lambda: bool(info()['agent']), 'agent registration')
        e,r,s = snapshot()
        check(s['schemaVersion']==1 and len(s['devices'])==2 and len(s['profiles'])==4,'device, saved/hidden and VPN roster')
        wifi = next(d for d in s['devices'] if d['path']==DEV)
        check(wifi['accessPoints'][0]['ssid']==list(b'Test') and wifi['accessPoints'][0]['strength']==70,'byte SSID and real AP property types')
        check(wifi['ip4']['addresses'][0]['address']=='192.0.2.4','IP AddressData variant decoding')
        state('wifiPresent',False)
        wait(lambda: len(snapshot()[2]['devices'])==1,'Wi-Fi hot removal')
        state('wifiPresent',True)
        wait(lambda: len(snapshot()[2]['devices'])==2,'Wi-Fi hot addition')
        check(True,'device roster survives hotplug')
        signals = []
        bus.signal_subscribe(None,IFACE,'Updated',NETPATH,None,Gio.DBusSignalFlags.NONE,lambda *a: signals.append(a[5].unpack()))
        state('strength',88)
        wait(lambda: any(json.loads(x[2])['available'] and any(d.get('accessPoints',[{}])[0].get('strength')==88 for d in json.loads(x[2])['devices'] if d.get('accessPoints')) for x in signals),'updated AP strength')
        check(all(x[0]==e and x[1]>r for x in signals),'monotonic epoch/revision')
        net('SetWifiEnabled','(b)',(False,))
        wait(lambda: not snapshot()[2]['wirelessEnabled'],'radio write')
        check(not info()['radio'],'radio via D-Bus')
        net('Scan','(o)',(DEV,))
        net('Connect','(oos)',(DEV,AP,''))
        net('Activate','(so)',('hidden',DEV))
        net('Activate','(so)',('vpn','/'))
        check(any(c[0]=='RequestScan' for c in info()['calls']) and any(c[0]=='ActivateConnection' for c in info()['calls']),'scan, saved hidden and VPN activation')
        net('Deactivate','(o)',(ACTIVE,))
        check(info()['active']=='/','VPN deactivation')
        state('enterprise',True)
        fails(lambda: net('Connect','(oos)',(DEV,AP,'')),'NeedsProfile')
        fails(lambda: net('Connect','(oos)',(DEV,'/','')),'NeedsProfile')
        state('enterprise',False)
        net('Activate','(so)',('wifi',DEV))
        form = dict(v4=dict(method='manual',address='192.0.2.44',prefix='255.255.255.0',gateway='192.0.2.1'),v6=dict(method='auto',address='',prefix='',gateway=''),dns='1.1.1.1, 2001:4860:4860::8888',search='example')
        net('ApplyIp','(sos)',('wifi',DEV,json.dumps(form)))
        saved = json.loads(net('GetIp','(s)',('wifi',))[0])
        check(saved['v4']['address']=='192.0.2.44' and saved['v4']['prefix']=='24','manual IP persisted')
        check(saved['dns']=='1.1.1.1, 2001:4860:4860::8888','IPv4/IPv6 DNS native encodings')
        state('reapplyFail',True)
        before = len([c for c in info()['calls'] if c[0]=='ActivateConnection'])
        net('ApplyIp','(sos)',('wifi',DEV,json.dumps(form)))
        after = len([c for c in info()['calls'] if c[0]=='ActivateConnection'])
        check(after==before+1,'Reapply failure reactivates saved profile')
        net('Renew','(o)',(DEV,))
        state('reapplyFail',False)
        state('active','/')
        state('carrier',False)
        net('SetWiredEnabled','(ob)',(WIRED,False))
        net('SetWiredEnabled','(ob)',(WIRED,True))
        state('carrier',True)
        check(any(c[0]=='Update' and c[1]==PROF_WIRED for c in info()['calls']),'Ethernet switch persists profile autoconnect')
        net('ApplyIp','(sos)',('',WIRED,json.dumps(form)))
        check(any(c[0]=='AddConnection' for c in info()['calls']),'Ethernet without profile creates one')
        net('Forget','(s)',('hidden',))
        wait(lambda: all(p['uuid']!='hidden' for p in snapshot()[2]['profiles']),'forget profile')
        explicit = profile('enterprise')
        explicit['802-1x'] = {'eap': v('as',['peap'])}
        net('ConnectProfile','(ooa{sa{sv}})',(DEV,AP,explicit))
        check(any(c[0]=='AddAndActivateConnection' for c in info()['calls']),'explicit enterprise profile reaches NM')
        net('Forget','(s)',('wifi',))
        state('activeState',4)
        fails(lambda: net('Connect','(oos)',(DEV,AP,'')),'Failed')
        check(any(c[0]=='Delete' and c[1]==info()['lastCreated'] for c in info()['calls']),'failed fresh connection is removed')
        state('activeState',2)
        # Requests come only from the fake NM owner; a session peer cannot phish.
        agent_owner = info()['agent']
        system_client = connection(os.environ['DBUS_SYSTEM_BUS_ADDRESS']); extra.append(system_client)
        fails(lambda: call(system_client,agent_owner,AGENT,NM+'.SecretAgent','GetSecrets','(a{sa{sv}}osasu)',(profile(),PROF,'802-11-wireless-security',[],3)),'PermissionDenied')
        # Without a renderer there must be no question that hangs forever.
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: info()['result'] is not None,'no UI refusal')
        check('NoSecrets' in info()['result'].get('error',''),'no UI returns NoSecrets')
        ui = connection(address); extra.append(ui)
        net('RegisterSecretsUi',c=ui)
        competitor = connection(address); extra.append(competitor)
        fails(lambda: net('RegisterSecretsUi',c=competitor),'Denied')
        requested, closed, leaks = [], [], []
        ui.signal_subscribe(None,IFACE,'SecretsRequested',NETPATH,None,Gio.DBusSignalFlags.NONE,lambda *a: requested.append(a[5].unpack()))
        ui.signal_subscribe(None,IFACE,'SecretsClosed',NETPATH,None,Gio.DBusSignalFlags.NONE,lambda *a: closed.append(a[5].unpack()))
        competitor.signal_subscribe(None,IFACE,'SecretsRequested',NETPATH,None,Gio.DBusSignalFlags.NONE,lambda *a: leaks.append(a[5].unpack()))
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: bool(requested),'unicast secrets question')
        rid = requested[-1][0]
        meta = json.loads(requested[-1][1])
        check(not leaks and 'psk' not in meta['profile']['802-11-wireless-security'] and 'system-private-sentinel' not in requested[-1][1] and meta['retry'],'no secrets broadcast and retry metadata')
        fails(lambda: net('SubmitSecrets','(ta{sa{sv}})',(rid,{'802-11-wireless-security':{'psk':v('s','test-key')}}),c=competitor),'Denied')
        ctrl('Seed','(s)',('libsecret',))
        before_stores=info()['stores']
        net('SubmitSecrets','(ta{sa{sv}})',(rid,{'802-11-wireless-security':{'psk':v('s','test-key')}}),c=ui)
        wait(lambda: info()['result'] is not None,'NM secrets response')
        check(info()['result']['ok'] and info()['result']['value']=='test-key','secrets reach only NM')
        wait(lambda: info()['stores']>before_stores,'agent-owned keyring save completes')
        check(info()['items']==1,'libsecret item replaced without duplicate')
        fails(lambda: net('SubmitSecrets','(ta{sa{sv}})',(rid,{'802-11-wireless-security':{'psk':v('s','stale')}}),c=ui),'Invalid')
        ctrl('Seed','(s)',('duplicate',))
        state('locked',True)
        count = len(requested)
        ctrl('Ask','(us)',(0,'802-11-wireless-security'))
        wait(lambda: info()['result'] is not None,'keyring lookup')
        check(info()['result']['value']=='test-key' and len(requested)==count,'keyring unlock prompt and newest duplicate lookup')
        for _ in range(8):
            ctrl('Ask','(us)',(0,'802-11-wireless-security'))
            wait(lambda: info()['result'] is not None,'duplicate lookup')
            check(info()['result']['value']=='test-key','newest Modified wins independently of item order')
        ctrl('Seed','(s)',('remove_duplicate',))
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: len(requested)>count,'second question')
        net('CancelSecrets','(t)',(requested[-1][0],),c=ui)
        wait(lambda: info()['result'] is not None,'UI cancellation')
        check('UserCanceled' in info()['result'].get('error','') and net('TakeUserCancel','(s)',('wifi',))[0] and not net('TakeUserCancel','(s)',('wifi',))[0],'explicit cancellation consumed once')
        count = len(requested)
        ctrl('Ask','(us)',(3,'802-1x'))
        wait(lambda: len(requested)>count,'802.1x question')
        eap=json.loads(requested[-1][1])
        check(eap['profile']['802-1x']['eap']==['peap'] and 'system-eap-private' not in requested[-1][1],'EAP prompt keeps identity and redacts system password')
        fails(lambda: net('SubmitSecrets','(ta{sa{sv}})',(requested[-1][0],{'802-1x':{'password-flags':v('u',1)}}),c=ui),'Invalid')
        net('SubmitSecrets','(ta{sa{sv}})',(requested[-1][0],{'802-1x':{'password':v('s','eap-test-key')}}),c=ui)
        wait(lambda: info()['result'] is not None and info()['result']['ok'],'802.1x reply')
        wait(lambda: info()['items']==2,'802.1x keyring save')
        check(True,'802.1x secrets response and keyring persistence')
        count = len(requested)
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: len(requested)>count,'timeout question')
        if managed or os.environ.get('NETWORK_TEST_QUICK')=='1':
            ctrl('Cancel')
        # System-bus reply and session-bus close signal have no cross-bus ordering.
        wait(lambda: info()['result'] is not None and any(x[0]==requested[-1][0] for x in closed),'120 second NM deadline and UI withdrawal',125)
        check('UserCanceled' in info()['result'].get('error','') and any(x[0]==requested[-1][0] for x in closed),'NM deadline/cancel withdraws unanswered request')
        count = len(requested)
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: len(requested)>count,'NM cancellation question')
        ctrl('Cancel')
        wait(lambda: info()['result'] is not None and 'UserCanceled' in info()['result'].get('error','') and any(x[0]==requested[-1][0] for x in closed),'NM withdrawal closes UI and completes its request')
        count = len(requested)
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: len(requested)>count,'UI loss question')
        ui.close_sync(None)
        wait(lambda: info()['result'] is not None and 'UserCanceled' in info()['result'].get('error',''),'UI loss cancels NM')
        net('RegisterSecretsUi',c=competitor)
        state('saveflags',2)
        ctrl('Save'); wait(lambda: info()['result'] is not None,'save not-saved flag')
        ctrl('Ask','(us)',(0,'802-11-wireless-security'))
        wait(lambda: info()['result'] is not None,'keyring retained prior secret')
        check(info()['result']['value']=='test-key','not-saved flag never overwrites keyring')
        ctrl('Delete'); wait(lambda: info()['items']==0,'delete keyring')
        check('test-key' not in json.dumps(snapshot()[2]) and 'only-in-keyring' not in json.dumps(snapshot()[2]),'Snapshot never includes secrets')
        # Deliberately let NM fail before its asynchronous keyring save finishes.
        state('newNeedsSecrets',True)
        state('holdStores',True)
        state('activeState',2)
        before=len(leaks)
        before_deletes=info()['profileDeletes']
        before_stores=info()['stores']
        completion=[]
        def connected(c,res):
            try:
                c.call_finish(res)
                completion.append('unexpected-success')
            except GLib.Error as e:
                completion.append(str(e))
        bus.call(NET,NETPATH,IFACE,'Connect',v('(oos)',(DEV,AP,'')),None,Gio.DBusCallFlags.NONE,20000,None,connected)
        wait(lambda:len(leaks)>before,'new connection secret question')
        new_uuid=json.loads(leaks[-1][1])['uuid']
        net('SubmitSecrets','(ta{sa{sv}})',(leaks[-1][0],{'802-11-wireless-security':{'psk':v('s','wrong-new-key')}}),c=competitor)
        wait(lambda:info()['heldStores']>0 and info()['profileDeletes']>before_deletes,'NM failed and save is still pending')
        ctrl('ReleaseStores')
        wait(lambda:info()['stores']>before_stores,'delayed save completed')
        wait(lambda:completion and new_uuid not in info()['itemUuids'],'failed activation leaves no orphan after delayed save')
        check('Failed' in completion[0] and new_uuid not in info()['itemUuids'],'failed activation leaves no orphan after delayed save')
        state('newNeedsSecrets',False)
        state('activeState',2)
        before=len(leaks)
        ctrl('Ask','(us)',(3,'802-11-wireless-security'))
        wait(lambda: len(leaks)>before,'question before NM restart')
        ctrl('Drop')
        wait(lambda: info()['result'] is not None and 'UserCanceled' in info()['result'].get('error',''),'NM loss withdraws pending secrets')
        wait(lambda: not snapshot()[2]['available'],'NM loss clears snapshot')
        check(snapshot()[2]['devices']==[] and snapshot()[2]['profiles']==[],'no stale devices after NM loss')
        ctrl('Restore')
        wait(ready,'NM restart snapshot')
        wait(lambda: info()['registrations']>=2,'NM restart agent registration')
        check(True,'NM restart recovers state and registration')
        if managed:
            return
        daemon.terminate(); daemon.wait(timeout=5); daemon=None
        # Read-only mode must NEVER export/register an agent or mutate NM.
        registrations = info()['registrations']
        daemon = subprocess.Popen([binary,'--network-read-only'],stdout=daemon_log,stderr=daemon_log)
        wait(ready,'read-only network service')
        fails(lambda: net('SetWifiEnabled','(b)',(True,)),'Denied')
        check(info()['registrations']==registrations,'read-only mode registers no NM agent')
        check(True,'all Network1 writes used fake services')
    finally:
        for c in extra:
            if not c.is_closed():
                c.close_sync(None)
        for p in (daemon,peer):
            if p is not None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill();p.wait()
        for f in (peer_log,daemon_log):
            f.close()

def outer(binary):
    # The child inherits no session/system bus, real settings, cache or HOME.
    root = Path(__file__).resolve().parents[2]
    (root/'target').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='network-',dir=root/'target') as tmp:
        directory = Path(tmp)
        address='unix:path='+str(directory/'bus')
        bus=subprocess.Popen(['dbus-daemon','--session','--nofork','--nopidfile','--address='+address],stdout=subprocess.DEVNULL)
        try:
            wait(lambda:(directory/'bus').exists(),'private bus socket')
            env={'PATH':os.environ.get('PATH','/usr/bin'),'HOME':tmp,'XDG_CONFIG_HOME':tmp+'/config','XDG_CACHE_HOME':tmp+'/cache','XDG_DATA_HOME':tmp+'/data','XDG_STATE_HOME':tmp+'/state','DBUS_SESSION_BUS_ADDRESS':address,'DBUS_SYSTEM_BUS_ADDRESS':address, 'NETWORK_TEST_QUICK':os.environ.get('NETWORK_TEST_QUICK','')}
            result=subprocess.run([sys.executable,__file__,'--inside',str(Path(binary).resolve()),tmp],env=env)
            if result.returncode:
                for name in ('daemon.log','peer.log'):
                    print((directory/name).read_text())
            return result.returncode
        finally:
            bus.terminate();bus.wait(timeout=5)
if __name__=='__main__':
    if sys.argv[1]=='--fake':
        fake()
    elif sys.argv[1] in ('--inside','--inside-managed'):
        exercise(sys.argv[2],Path(sys.argv[3]),sys.argv[1]=='--inside-managed')
    else:
        sys.exit(outer(sys.argv[1]))
