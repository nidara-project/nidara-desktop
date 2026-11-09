#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Disposable Network1 source for the local B2.3 UI walk."""
import json,sys
from pathlib import Path
import gi
gi.require_version('Gio','2.0')
from gi.repository import Gio,GLib
control,log=map(Path,sys.argv[1:3]);bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
state={'revision':1,'present':True,'wired':True,'active':[]}
xml='''<node><interface name="org.nidara.Network1">
<method name="Snapshot"><arg type="t" direction="out"/><arg type="t" direction="out"/><arg type="s" direction="out"/></method>
<method name="SetWiredEnabled"><arg type="o" direction="in"/><arg type="b" direction="in"/></method>
<method name="Activate"><arg type="s" direction="in"/><arg type="o" direction="in"/><arg type="o" direction="out"/></method>
<method name="Deactivate"><arg type="o" direction="in"/></method>
<signal name="Updated"><arg type="t"/><arg type="t"/><arg type="s"/></signal>
</interface></node>'''
def doc():return json.dumps({'schemaVersion':1,'available':True,'wirelessEnabled':False,'wirelessHardwareEnabled':False,
 'devices':[{'path':'/device/wired','kind':1,'interface':'eth-test','state':100 if state['wired'] else 30,'wiredEnabled':state['wired'],'carrier':True,'ip4':{'addresses':[{'address':'192.0.2.10','prefix':24}],'gateway':'192.0.2.1'}}] if state['present'] else [],
 'profiles':[{'uuid':'test-vpn','type':'vpn','name':'Fixture VPN'},{'uuid':'test-wireguard','type':'wireguard','name':'Fixture WireGuard'}] if state['present'] else [],'active':state['active']})
def update():
 state['revision']+=1;bus.emit_signal(None,'/org/nidara/Network','org.nidara.Network1','Updated',GLib.Variant('(tts)',(1,state['revision'],doc())))
def invoke(c,s,p,i,m,args,inv):
 values=args.unpack()
 if m=='Snapshot':inv.return_value(GLib.Variant('(tts)',(1,state['revision'],doc())));return
 with log.open('a') as file:file.write(json.dumps([m,values])+'\n')
 if m=='SetWiredEnabled':assert values[0]=='/device/wired';state['wired']=values[1]
 if m=='Activate':
  assert values[1]=='/' and values[0] in ['test-vpn','test-wireguard'];kind='vpn' if values[0]=='test-vpn' else 'wireguard';state['active']=[{'path':'/active/test','uuid':values[0],'type':kind,'vpn':kind=='vpn','state':2}]
 if m=='Deactivate':assert values[0]=='/active/test';state['active']=[]
 update();inv.return_value(GLib.Variant('(o)',('/active/test',)) if m=='Activate' else None)
bus.register_object('/org/nidara/Network',Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0],invoke,None,None)
def poll():
 try:present=control.read_text().strip()!='absent'
 except OSError:present=True
 if present!=state['present']:state['present']=present;update()
 return True
GLib.timeout_add(200,poll);Gio.bus_own_name_on_connection(bus,'org.nidara.Network',0,None,None);GLib.MainLoop().run()
