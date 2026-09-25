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
