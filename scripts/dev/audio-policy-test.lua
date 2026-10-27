-- SPDX-License-Identifier: GPL-3.0-or-later
-- Runs the shipped WP hook against fake events, never a real audio graph.
local hooks = {}
function Constraint(t) return t end
function EventInterest(t) return t end
function SimpleEventHook(t) t.register=function(self) hooks[self.name]=self.execute end; return t end
package.preload['common-utils']=function() return {parseParam=function(p) return p end} end
Json={Object=function(t) return {to_string=function() return t.name end} end}
local devices, md = {}, {values={}, writes={}}
function md:set(subject,key,kind,value) self.values[key]=value;self.writes[key]=value end
function md:find(subject,key) return self.values[key] end
local source={}
function source:call(method,kind)
  if method=='schedule-rescan' then return end
  return {lookup=function(_,constraints)
    if kind=='metadata' then return md end
    local id=constraints[1][3];return devices[tostring(id)]
  end}
end
local function device(id,serial,bus,api,routes)
  local d={properties={['object.serial']=serial,['device.bus']=bus,['device.api']=api},routes=routes or {}}
  function d:iterate_params() local i=0;return function()i=i+1;return self.routes[i] end end
  devices[tostring(id)]=d;return d
end
local function node(name,device,index,class)
  return {['node.name']=name,['object.serial']=name,['device.id']=tostring(device),['card.profile.device']=tostring(index),['media.class']=class or 'Audio/Sink'}
end
local function event(kind,nodes)
  local e={data={['available-nodes']={parse=function()return nodes end}},props={['default-node.type']=kind}}
  function e:get_source()return source end
  function e:get_properties()return self.props end
  function e:get_data(k)return self.data[k] end
  function e:set_data(k,v)self.data[k]=v end
  return e
end
local policy=arg[1] or 'config/wireplumber/nidara-audio.lua'
dofile(policy)
local function control(value)
  hooks['nidara/audio-controller']({get_properties=function()return {['event.subject.id']='101',['event.subject.value']=value}end,get_source=function()return source end})
end
local function scan(outputs,inputs)
  md.writes={};local o=event('audio.sink',outputs);hooks['nidara/audio-hotplug'](o)
  local i=event('audio.source',inputs);hooks['nidara/audio-hotplug'](i)
  return o.data['selected-node'],i.data['selected-node']
end
local internal=device(1,'card1','pci','alsa')
local speaker=node('speakers',1,0);local mic=node('internal-mic',1,1,'Audio/Source')
control('1');assert(scan({speaker},{mic})==nil,'baseline must not switch')
device(2,'standalone','usb','alsa');local lone=node('usb-mic',2,0,'Audio/Source')
local _,input=scan({speaker},{mic,lone});assert(input==nil,'standalone mic must not switch')
device(3,'usb-headset','usb','alsa');local usb=node('usb-headphones',3,0);local usbmic=node('usb-headset-mic',3,1,'Audio/Source')
local output,input=scan({speaker,usb},{mic,lone,usbmic});assert(output=='usb-headphones' and input=='usb-headset-mic','paired USB switches together')
device(4,'bt-headset','bluetooth','bluez5');local a2dp=node('a2dp',4,0)
output,input=scan({speaker,usb,a2dp},{mic,lone,usbmic});assert(output=='a2dp' and input==nil,'A2DP must not steal another mic')
local hfp=node('hfp',4,0);local hfpmic=node('hfp-mic',4,1,'Audio/Source')
output,input=scan({speaker,usb,hfp},{mic,lone,usbmic,hfpmic});assert(output==nil and input==nil,'profile reenumeration is not a new device')
scan({speaker,usb},{mic,lone,usbmic})
device(4,'bt-headset-new','bluetooth','bluez5')
output,input=scan({speaker,usb,hfp},{mic,lone,usbmic,hfpmic});assert(output=='hfp' and input=='hfp-mic','new HFP pairs only its actual source')
control('0');assert(scan({speaker},{mic})==nil,'disabled is inert')
local hp={index=1,name='analog-output-headphones',direction='Output',devices={0},available='no'}
local hm={index=2,name='analog-input-headset-mic',direction='Input',devices={2},available='no'}
internal.routes={hp,hm};local headsetmic=node('headset-mic',1,2,'Audio/Source')
control('1');scan({speaker},{mic,headsetmic});hp.available='yes';hm.available='yes'
output,input=scan({speaker},{mic,headsetmic});assert(output=='speakers' and input=='headset-mic','jack chooses newly available headset input')
hp.available='no';scan({speaker},{mic,headsetmic});hp.available='yes'
output,input=scan({speaker},{mic,headsetmic});assert(output=='speakers' and input==nil,'old available mic route is not paired to a new jack event')
hooks['nidara/audio-controller-removed']({get_properties=function()return {['object.id']='101'}end})
assert(scan({speaker,usb},{mic,usbmic})==nil,'controller loss leaves normal WP policy')
print('PASS: Audio1 hotplug policy baseline, USB/HFP pairing, A2DP, profile changes, jack event, standalone mic and controller loss')
