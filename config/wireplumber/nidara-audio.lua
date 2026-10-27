-- SPDX-License-Identifier: GPL-3.0-or-later
-- Default selection stays inside WirePlumber. Inert without an Audio1 controller.
-- No mixer writes, links, state files, role grouping or ducking.
local utils = require("common-utils")
local controllers, previous, paired = {}, nil, nil
local function enabled()
  for _, value in pairs(controllers) do if value then return true end end
  return false
end
local function metadata(event)
  return event:get_source():call("get-object-manager", "metadata"):lookup {
    Constraint { "metadata.name", "=", "default" }
  }
end
SimpleEventHook {
  name = "nidara/audio-announce",
  interests = { EventInterest { Constraint { "event.type", "=", "metadata-added" },
    Constraint { "metadata.name", "=", "default" } } },
  execute = function(event)
    event:get_subject():set(0, "nidara.audio.switch-policy", "Spa:Id", "1")
  end
}:register()
SimpleEventHook {
  name = "nidara/audio-controller",
  interests = { EventInterest { Constraint { "event.type", "=", "metadata-changed" },
    Constraint { "metadata.name", "=", "default" },
    Constraint { "event.subject.key", "=", "nidara.audio.switch-on-connect" } } },
  execute = function(event)
    local p = event:get_properties()
    controllers[p["event.subject.id"]] = p["event.subject.value"] == "1" or nil
    -- Enabling or disabling starts a baseline; startup enumeration is not hotplug.
    previous, paired = nil, nil
    event:get_source():call("schedule-rescan", "default-nodes")
  end
}:register()
SimpleEventHook {
  name = "nidara/audio-controller-removed",
  interests = { EventInterest { Constraint { "event.type", "=", "client-removed" } } },
  execute = function(event)
    local id = tostring(event:get_properties()["object.id"])
    if controllers[id] then controllers[id] = nil; previous, paired = nil, nil end
  end
}:register()
local function contains(values, id)
  for _, value in ipairs(values or {}) do if tostring(value) == tostring(id) then return true end end
  return false
end
local function headset_routes(device, index)
  local outputs, inputs = {}, {}
  if not device then return outputs, inputs end
  for pod in device:iterate_params("EnumRoute") do
    local route = utils.parseParam(pod, "EnumRoute")
    if route and route.available == "yes" and (index == nil or contains(route.devices, index)) then
      local name = route.name or ""
      if route.direction == "Output" and (name:find("headphone") or name:find("headset")) then outputs[tostring(route.index)] = true end
      if route.direction == "Input" and name:find("headset") and name:find("mic") then inputs[tostring(route.index)] = true end
    end
  end
  return outputs, inputs
end
local function info(event, props)
  local device_id = props["device.id"]
  local om = event:get_source():call("get-object-manager", "device")
  local device = device_id and om:lookup { Constraint { "bound-id", "=", device_id, type="gobject" } }
  if not device then return nil end -- excludes virtual nodes and bare null sinks
  local dp = device.properties
  local external = dp["device.bus"] == "usb" or dp["device.api"] == "bluez5"
  local out, input = headset_routes(device, props["card.profile.device"])
  local _, card_mics = headset_routes(device, nil)
  return { device = tostring(dp["object.serial"]), external = external,
    outputs = out, inputs = input, card_mics = card_mics, name = props["node.name"], serial = props["object.serial"] }
end
local function new_route(now, before)
  for index in pairs(now or {}) do if not (before or {})[index] then return true end end
  return false
end
SimpleEventHook {
  name = "nidara/audio-hotplug",
  after = { "default-nodes/find-selected-default-node", "default-nodes/find-stored-default-node", "default-nodes/find-best-default-node" },
  before = "default-nodes/apply-default-node",
  interests = { EventInterest { Constraint { "event.type", "=", "select-default-node" } } },
  execute = function(event)
    local announce = metadata(event)
    if announce and announce:find(0, "nidara.audio.switch-policy") ~= "1" then
      announce:set(0, "nidara.audio.switch-policy", "Spa:Id", "1")
    end
    if not enabled() then return end
    local kind = event:get_properties()["default-node.type"]
    local nodes = event:get_data("available-nodes")
    nodes = nodes and nodes:parse() or {}
    if kind == "audio.sink" then
      local current, candidates = {}, {}
      for _, props in ipairs(nodes) do
        local item = info(event, props)
        if item then
          current[item.name] = item
          local old = previous and previous[item.name]
          -- Profile re-enumeration within the same device is not a new apparatus.
          local seen_device = false
          for _, v in pairs(previous or {}) do if v.device == item.device then seen_device = true end end
          if previous and ((item.external and not old and not seen_device) or
              (old and new_route(item.outputs, old.outputs))) then candidates[#candidates+1] = item end
        end
      end
      local old = previous
      previous, paired = current, nil
      -- Multiple simultaneous eligible devices are ambiguous: retain WP's decision.
      if #candidates ~= 1 then return end
      local choice = candidates[1]
      local md = metadata(event)
      if not md then return end
      md:set(0, "default.configured.audio.sink", "Spa:String:JSON", Json.Object { name=choice.name }:to_string())
      event:set_data("selected-node", choice.name)
      event:set_data("selected-node-priority", 1000000)
      -- Input selection is evaluated in the same rescan, not on a future mic event.
      paired = { device=choice.device, external=choice.external,
        headset_new = new_route(choice.card_mics, old[choice.name] and old[choice.name].card_mics) }
    elseif kind == "audio.source" and paired then
      local pairing = paired
      paired = nil
      local candidates = {}
      for _, props in ipairs(nodes) do
        if props["media.class"] == "Audio/Source" then
          local item = info(event, props)
          if item and item.device == pairing.device then
            -- USB/BT share the actual Device; A2DP has no matching Audio/Source.
            -- On an integrated card require an available headset mic route.
            if pairing.external or (pairing.headset_new and next(item.inputs)) then candidates[#candidates+1] = item end
          end
        end
      end
      if #candidates == 1 then
        local md = metadata(event)
        if md then
          md:set(0, "default.configured.audio.source", "Spa:String:JSON", Json.Object { name=candidates[1].name }:to_string())
          event:set_data("selected-node", candidates[1].name)
          event:set_data("selected-node-priority", 1000000)
        end
      end
    end
  end
}:register()
