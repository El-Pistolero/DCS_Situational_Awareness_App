-- Offline test: mock DCS GUI + mission environments and a UDP socket.
local sent, inbox = {}, {}
package.loaded["socket"] = { udp = function()
  return { settimeout = function() end, setsockname = function() return 1 end,
    receive = function() return table.remove(inbox, 1) end,
    sendto = function(_, d) sent[#sent + 1] = d end, close = function() end }
end }
-- Mission environment: flat 50 m ground, sea west of 41.6E, a runway strip.
local mission_env = {
  string = string, math = math, table = table, tostring = tostring, ipairs = ipairs, pairs = pairs, pcall = pcall, type = type,
  env = { mission = { theatre = "Caucasus" } },
  coord = {
    LLtoLO = function(lat, lon) return { x = lat * 1000, y = 0, z = lon * 1000 } end,
    LOtoLL = function(p) return p.x / 1000, p.z / 1000 end,
  },
  land = {
    getHeight = function(v) return (v.y / 1000 < 41.6) and 0 or 50 + (v.x / 1000 - 41) * 100 end,
    getSurfaceType = function(v) return (v.y / 1000 < 41.6) and 3 or 1 end,
  },
  world = { getAirbases = function() return { {
    getName = function() return "Batumi" end,
    getDesc = function() return { category = 0 } end,
    getPoint = function() return { x = 41610, y = 10, z = 41600 } end,
    getRunways = function() return { { Name = "13", course = -2.199, length = 2400, width = 60, position = { x = 41610, y = 10, z = 41600 } } } end,
  } } end },
}
local runs = 0
net = { dostring_in = function(state, code)
  assert(state == "server")
  runs = runs + 1
  local f = assert(loadstring(code))
  setfenv(f, mission_env)
  return f()
end }
local t = 0
DCS = { getRealTime = function() return t end, setUserCallbacks = function(cb) _G.CB = cb end }
dofile("dcs-scripts/DCS-SA-Hook.lua")
CB.onSimulationStart()
inbox[#inbox + 1] = '{"op":"tile","z":11,"x":1260,"y":757,"n":5}'
inbox[#inbox + 1] = '{"op":"airbases"}'
inbox[#inbox + 1] = '{"op":"tile","z":99,"x":1,"y":1}'   -- rejected: bad zoom
for i = 1, 10 do t = i * 0.1; CB.onSimulationFrame() end
CB.onSimulationStop()
for _, d in ipairs(sent) do print(d) end

-- ---- DCS events: install handler in the mission env, fire events, drain ----
sent = {}
local handler = nil
mission_env.world.addEventHandler = function(h) handler = h end
mission_env.timer = { getTime = function() return 123.5 end }
mission_env.DCSSA_EVENTS = nil
local function unit(name, typ, player, coal, x, z)
  return {
    getName = function() return name end, getTypeName = function() return typ end,
    getPlayerName = function() return player end, getCoalition = function() return coal end,
    getPoint = function() return { x = x, y = 1000, z = z } end,
  }
end
local shell = { getTypeName = function() return "M61_20_HE" end, getDesc = function() return { category = 0 } end }
CB.onSimulationStart()
t = 20; CB.onSimulationFrame()                       -- installs the handler
assert(handler, "event handler must be installed in the mission environment")
local me = unit("Viper 1-1", "F-16C_50", "Ethan|Test", 2, 41610, 41600)
local btr = unit("Convoy-1", "BTR-80", nil, 1, 41780, 41790)
handler:onEvent({ id = 2, time = 280.25, initiator = me, target = btr, weapon = shell })
handler:onEvent({ id = 28, time = 280.8, initiator = me, target = btr, weapon_name = "M61_20_HE" })
handler:onEvent({ id = 23, time = 279.0, initiator = me, weapon_name = "M61A1" })
handler:onEvent({ id = 99, time = 1 })                -- unknown id: ignored
t = 21; CB.onSimulationFrame()
local got = nil
for _, d in ipairs(sent) do if string.find(d, '"dcs-events"', 1, true) then got = d end end
assert(got, "events packet must be sent")
print(got)
-- mission restart: env loses DCSSA_EVENTS -> hook reinstalls
mission_env.DCSSA_EVENTS = nil; handler = nil
t = 22; CB.onSimulationFrame(); t = 23; CB.onSimulationFrame()
assert(handler, "handler must be reinstalled after the mission environment resets")
print("events ok")

-- ---- shots: guidance and the weapon's own target (DCS's shot event has none) ----
local function nfields(line) local n = 0 for _ in string.gmatch(line .. "|", "([^|]*)|") do n = n + 1 end return n end
local bandit = unit("Bandit 1", "MiG-29S", nil, 1, 41900, 41950)
local aim9 = { getTypeName = function() return "AIM_9X" end, getDesc = function() return { category = 1, guidance = 2 } end,
  getTarget = function() return bandit end }
local rocket = { getTypeName = function() return "HYDRA_70_M151" end, getDesc = function() return { category = 2 } end,
  getTarget = function() return nil end }
local function fire()
  handler:onEvent({ id = 1, time = 300.5, initiator = me, weapon = aim9 })
  handler:onEvent({ id = 1, time = 301.0, initiator = me, weapon = rocket })         -- no target
  handler:onEvent({ id = 1, time = 301.2, initiator = me, weapon_name = "AGM_65D" })  -- no weapon object
  handler:onEvent({ id = 2, time = 301.5, initiator = me, target = btr, weapon = shell })
end
fire()
local lines = {}
for l in string.gmatch(mission_env.DCSSA_EVENTS.drain(), "[^\n]+") do lines[#lines + 1] = l end
assert(#lines == 4, "every event queued")
for i = 1, 3 do assert(nfields(lines[i]) == 26, "shot line has 26 fields: " .. lines[i]) end
assert(nfields(lines[4]) == 18, "other events keep 18 fields: " .. lines[4])
sent = {}
fire()
t = 24; CB.onSimulationFrame()
got = nil
for _, d in ipairs(sent) do if string.find(d, '"dcs-events"', 1, true) then got = d end end
assert(got, "events packet must be sent")
print(got)
assert(string.find(got, '"weapon":"AIM_9X","weaponCategory":1,"guidance":2,"weaponTarget":{"name":"Bandit 1","type":"MiG-29S",', 1, true),
  "IR shot carries guidance 2 and the missile's target")
assert(string.find(got, '"weapon":"HYDRA_70_M151","weaponCategory":2,"guidance":null,"weaponTarget":null}', 1, true))
assert(string.find(got, '"weapon":"AGM_65D","weaponCategory":null,"guidance":null,"weaponTarget":null}', 1, true))
assert(string.find(got, '"weapon":"M61_20_HE","weaponCategory":0}', 1, true), "hits carry no shot fields")
-- A handler installed by an older hook writes 18-field shot lines: still read.
local old = table.concat({ "shot", "102.000", "Viper 1-1", "F-16C_50", "Ethan", "2", "41.610000", "41.600000", "1000.0",
  "", "", "", "", "", "", "", "AIM_120C", "1" }, "|")
mission_env.DCSSA_EVENTS = { drain = function() local s = old; old = ""; return s end }
sent = {}
t = 25; CB.onSimulationFrame()
got = nil
for _, d in ipairs(sent) do if string.find(d, '"dcs-events"', 1, true) then got = d end end
assert(got and string.find(got, '"weapon":"AIM_120C","weaponCategory":1}]}', 1, true), "old 18-field line still parsed")
assert(not string.find(got, '"guidance"', 1, true))
print(got)
print("shot guidance ok")
