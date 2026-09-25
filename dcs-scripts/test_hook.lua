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
