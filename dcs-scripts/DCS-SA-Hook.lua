-- DCS-SA-Hook.lua  -  lets DCS SA ask DCS World about its own map
--
-- Lives in  Saved Games\DCS\Scripts\Hooks\  (loaded automatically by DCS).
-- Answers requests from the DCS SA app on this PC (UDP 127.0.0.1:42682):
--   * terrain tiles: ground height and surface type (land / water / road /
--     runway) sampled from DCS's own terrain via the land.* scripting API
--   * airbases: every airfield, helipad and ship deck with its runways
--   * combat events as DCS itself reports them (shots, hits, kills, gun
--     start/stop, takeoffs, landings, crashes, ejections), so the debrief can
--     say "DCS confirmed" instead of inferring hits and kills from geometry;
--     shots also carry the weapon's guidance type and its target at launch
-- Replies go to the app on UDP 127.0.0.1:42680.
--
-- Uses only the official scripting API - no game files are read.  Works in
-- single player and on servers you host; as a client on someone else's
-- server the mission environment is not reachable and the app falls back to
-- public elevation data.

local HOOK = { req_port = 42682, app_host = "127.0.0.1", app_port = 42680, tile_interval = 0.08 }

local socket_ok, socket = pcall(function()
  package.path = package.path .. ";.\\LuaSocket\\?.lua"
  package.cpath = package.cpath .. ";.\\LuaSocket\\?.dll"
  return require("socket")
end)

local rx, tx = nil, nil
local queue = {}
local next_tile, next_hello, next_drain = 0, 0, 0
local theatre = nil
local events_installed = false

-- Installed once into the mission scripting environment: queues DCS events
-- as '|'-separated lines for the hook to drain:
--   kind|time|initiator (7)|target (7)|weapon|weaponCategory            18 fields
-- Shots add, at the end (older hooks stop at 18):
--   ...|guidance|weapon's own target (7)                                26 fields
-- The unit groups are name|type|player|coalition|lat|lon|alt.
local EVENT_INSTALL = [[
if DCSSA_EVENTS then return "ok" end
local NAMES = { [1]="shot", [2]="hit", [3]="takeoff", [4]="land", [5]="crash", [6]="ejection",
  [8]="dead", [9]="pilot_dead", [23]="shooting_start", [24]="shooting_end", [28]="kill" }
local q = {}
local function clean(s) return (string.gsub(tostring(s or ""), "[|\n\r]", " ")) end
local function obj(o)
  if not o then return { "", "", "", "", "", "", "" } end
  local function get(f) local ok, v = pcall(f, o) if ok then return v end return nil end
  local p = get(function(x) return x:getPoint() end)
  local lat, lon, alt = "", "", ""
  if p then
    local la, lo = coord.LOtoLL(p)
    lat, lon, alt = string.format("%.6f", la), string.format("%.6f", lo), string.format("%.1f", p.y)
  end
  return { clean(get(function(x) return x:getName() end)), clean(get(function(x) return x:getTypeName() end)),
    clean(get(function(x) return x.getPlayerName and x:getPlayerName() end)),
    clean(get(function(x) return x:getCoalition() end)), lat, lon, alt }
end
DCSSA_EVENTS = {}
function DCSSA_EVENTS.drain()
  if #q == 0 then return "" end
  local s = table.concat(q, "\n")
  q = {}
  return s
end
world.addEventHandler({ onEvent = function(self, e)
  local kind = NAMES[e.id]
  if not kind then return end
  local ok, line = pcall(function()
    local w, wcat, guid = "", "", ""
    if e.weapon then
      local okw, n = pcall(function() return e.weapon:getTypeName() end)
      if okw then w = clean(n) end
      local okd, d = pcall(function() return e.weapon:getDesc() end)
      if okd and d and d.category then wcat = tostring(d.category) end
      if okd and d and d.guidance then guid = clean(d.guidance) end
    elseif e.weapon_name then
      w = clean(e.weapon_name)
    end
    local f = { kind, string.format("%.3f", e.time or timer.getTime()),
      table.concat(obj(e.initiator), "|"), table.concat(obj(e.target), "|"), w, wcat }
    if kind == "shot" then
      -- A shot event has no target: add the weapon's guidance type and what
      -- the weapon itself is guiding on at launch.
      local okt, wt = pcall(function() return obj(e.weapon:getTarget()) end)
      f[#f + 1] = guid
      f[#f + 1] = table.concat(okt and wt or obj(nil), "|")
    end
    return table.concat(f, "|")
  end)
  if ok and line then
    q[#q + 1] = line
    if #q > 2000 then table.remove(q, 1) end
  end
end })
return "ok"
]]

local function log_info(msg) if log and log.write then pcall(log.write, "DCS-SA", log.INFO, msg) end end

local function jstr(s)
  return '"' .. string.gsub(tostring(s), '[%c"\\]', function(c)
    if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
    return string.format("\\u%04x", string.byte(c))
  end) .. '"'
end

local function send(json)
  if tx then pcall(tx.sendto, tx, json, HOOK.app_host, HOOK.app_port) end
end

-- Run code in the mission scripting environment and return its string result.
local function in_mission(code)
  if not (net and net.dostring_in) then return nil end
  local ok, res = pcall(net.dostring_in, "server", code)
  if ok and type(res) == "string" and res ~= "" then return res end
  return nil
end

local function now()
  if DCS and DCS.getRealTime then return DCS.getRealTime() end
  return os.clock()
end

-- Web Mercator tile maths (mirrors the app).
local function tile_lon(x, z) return x / 2 ^ z * 360 - 180 end
local function tile_lat(y, z)
  local n = math.pi - 2 * math.pi * y / 2 ^ z
  return math.deg(math.atan(0.5 * (math.exp(n) - math.exp(-n))))
end

local function do_tile(z, x, y, n)
  local lats, lons = {}, {}
  for j = 0, n - 1 do lats[#lats + 1] = string.format("%.7f", tile_lat(y + j / (n - 1), z)) end
  for i = 0, n - 1 do lons[#lons + 1] = string.format("%.7f", tile_lon(x + i / (n - 1), z)) end
  local code = "local lats={" .. table.concat(lats, ",") .. "} local lons={" .. table.concat(lons, ",") .. "} " .. [[
    local h, s = {}, {}
    for j = 1, #lats do
      for i = 1, #lons do
        local p = coord.LLtoLO(lats[j], lons[i], 0)
        local v = { x = p.x, y = p.z }
        h[#h + 1] = string.format("%d", math.floor(land.getHeight(v) + 0.5))
        s[#s + 1] = tostring(land.getSurfaceType(v))
      end
    end
    return table.concat(h, ",") .. "|" .. table.concat(s)
  ]]
  local res = in_mission(code)
  if not res then
    send('{"type":"terrain","z":' .. z .. ',"x":' .. x .. ',"y":' .. y .. ',"ok":false}')
    return
  end
  local heights, surface = string.match(res, "^([^|]*)|(.*)$")
  send('{"type":"terrain","ok":true,"z":' .. z .. ',"x":' .. x .. ',"y":' .. y .. ',"n":' .. n ..
    ',"theatre":' .. jstr(theatre or "") .. ',"h":[' .. (heights or "") .. '],"s":' .. jstr(surface or "") .. '}')
end

local function do_airbases()
  local res = in_mission([[
    local out = {}
    for _, ab in ipairs(world.getAirbases() or {}) do
      local okd, desc = pcall(ab.getDesc, ab)
      local p = ab:getPoint()
      local lat, lon = coord.LOtoLL(p)
      local rws = {}
      local okr, runways = pcall(ab.getRunways, ab)
      if okr and type(runways) == "table" then
        for _, rw in ipairs(runways) do
          if rw.position then
            local la, lo = coord.LOtoLL(rw.position)
            rws[#rws + 1] = string.format("%s;%.6f;%.6f;%.4f;%.1f;%.1f", tostring(rw.Name or ""), la, lo,
              rw.course or 0, rw.length or 0, rw.width or 0)
          end
        end
      end
      out[#out + 1] = string.format("%s~%s~%.6f~%.6f~%.1f~%s", ab:getName(),
        tostring(okd and desc and desc.category or -1), lat, lon, p.y, table.concat(rws, "^"))
    end
    return table.concat(out, "\n")
  ]])
  if not res then send('{"type":"airbases","ok":false}') return end
  local items = {}
  for line in string.gmatch(res, "[^\n]+") do
    local name, cat, lat, lon, alt, rws = string.match(line, "^(.-)~(.-)~(.-)~(.-)~(.-)~(.*)$")
    if name then
      local rw = {}
      for r in string.gmatch(rws, "[^%^]+") do
        local rn, la, lo, crs, len, wid = string.match(r, "^(.-);(.-);(.-);(.-);(.-);(.-)$")
        if rn then
          rw[#rw + 1] = '{"name":' .. jstr(rn) .. ',"lat":' .. la .. ',"lon":' .. lo .. ',"course":' .. crs ..
            ',"length":' .. len .. ',"width":' .. wid .. '}'
        end
      end
      items[#items + 1] = '{"name":' .. jstr(name) .. ',"category":' .. (tonumber(cat) or -1) .. ',"lat":' .. lat ..
        ',"lon":' .. lon .. ',"alt":' .. alt .. ',"runways":[' .. table.concat(rw, ",") .. ']}'
    end
  end
  send('{"type":"airbases","ok":true,"theatre":' .. jstr(theatre or "") .. ',"airbases":[' .. table.concat(items, ",") .. ']}')
end

local UNIT_FIELDS = { "name", "type", "player", "coalition", "lat", "lon", "alt" }

local function unit_json(parts, first)
  local out = {}
  for k, key in ipairs(UNIT_FIELDS) do
    local v = parts[first + k - 1] or ""
    if key == "lat" or key == "lon" or key == "alt" or key == "coalition" then
      out[#out + 1] = '"' .. key .. '":' .. (tonumber(v) and v or "null")
    else
      out[#out + 1] = '"' .. key .. '":' .. jstr(v)
    end
  end
  return "{" .. table.concat(out, ",") .. "}"
end

-- A unit, or null when all its fields are empty (no such object).
local function unit_or_null(parts, first)
  for k = first, first + #UNIT_FIELDS - 1 do
    if (parts[k] or "") ~= "" then return unit_json(parts, first) end
  end
  return "null"
end

local function drain_events()
  if not events_installed then
    events_installed = in_mission(EVENT_INSTALL) == "ok"
    if not events_installed then return end
  end
  local ok, res = pcall(net.dostring_in, "server", "return DCSSA_EVENTS and DCSSA_EVENTS.drain() or 'gone'")
  if not ok or res == nil then return end
  if res == "gone" then events_installed = false return end
  if res == "" then return end
  local batch, size = {}, 0
  local function flush()
    if #batch > 0 then send('{"type":"dcs-events","events":[' .. table.concat(batch, ",") .. ']}') end
    batch, size = {}, 0
  end
  for line in string.gmatch(res, "[^\n]+") do
    local parts = {}
    for f in string.gmatch(line .. "|", "([^|]*)|") do parts[#parts + 1] = f end
    if #parts >= 18 then
      local ev = '{"kind":' .. jstr(parts[1]) .. ',"t":' .. (tonumber(parts[2]) and parts[2] or "null") ..
        ',"initiator":' .. unit_json(parts, 3) .. ',"target":' .. unit_json(parts, 10) ..
        ',"weapon":' .. jstr(parts[17]) .. ',"weaponCategory":' .. (tonumber(parts[18]) and parts[18] or "null")
      if #parts >= 26 then  -- shots: guidance and the weapon's own target
        ev = ev .. ',"guidance":' .. (tonumber(parts[19]) and parts[19] or "null") ..
          ',"weaponTarget":' .. unit_or_null(parts, 20)
      end
      batch[#batch + 1] = ev .. '}'
      size = size + #ev
      -- Stay well inside one UDP datagram (64 KB).
      if #batch >= 150 or size > 48000 then flush() end
    end
  end
  flush()
end

local function hello()
  theatre = in_mission("return env and env.mission and env.mission.theatre or ''") or theatre
  send('{"type":"dcs-hook","v":1,"mission":' .. tostring(theatre ~= nil) .. ',"theatre":' .. jstr(theatre or "") .. '}')
end

local function poll()
  if not rx then return end
  for _ = 1, 50 do
    local data = rx:receive()
    if not data then break end
    local op = string.match(data, '"op"%s*:%s*"(%a+)"')
    if op == "tile" then
      local z = tonumber(string.match(data, '"z"%s*:%s*(%d+)'))
      local x = tonumber(string.match(data, '"x"%s*:%s*(%d+)'))
      local y = tonumber(string.match(data, '"y"%s*:%s*(%d+)'))
      local n = tonumber(string.match(data, '"n"%s*:%s*(%d+)')) or 41
      if z and x and y and z <= 16 and n >= 2 and n <= 129 then
        queue[#queue + 1] = { z, x, y, n }
        while #queue > 200 do table.remove(queue, 1) end
      end
    elseif op == "airbases" then
      queue[#queue + 1] = { "airbases" }
    elseif op == "hello" then
      next_hello = 0
    end
  end
end

local callbacks = {}

function callbacks.onSimulationStart()
  if socket_ok and socket then
    rx = socket.udp()
    if rx then
      rx:settimeout(0)
      local ok = rx:setsockname("127.0.0.1", HOOK.req_port)
      if not ok then rx = nil; log_info("request port busy") end
    end
    tx = socket.udp()
    if tx then tx:settimeout(0) end
  end
  queue, next_tile, next_hello, next_drain = {}, 0, 0, 0
  events_installed = false
  log_info("DCS-SA hook started")
end

function callbacks.onSimulationFrame()
  if not tx then return end
  local t = now()
  if t >= next_hello then next_hello = t + 5; pcall(hello) end
  pcall(poll)
  if t >= next_drain then next_drain = t + 0.2; pcall(drain_events) end
  if #queue > 0 and t >= next_tile then
    next_tile = t + HOOK.tile_interval
    local job = table.remove(queue, 1)
    if job[1] == "airbases" then pcall(do_airbases) else pcall(do_tile, job[1], job[2], job[3], job[4]) end
  end
end

function callbacks.onSimulationStop()
  if rx then pcall(rx.close, rx); rx = nil end
  if tx then send('{"type":"dcs-hook","v":1,"mission":false}'); pcall(tx.close, tx); tx = nil end
end

if DCS and DCS.setUserCallbacks then DCS.setUserCallbacks(callbacks) end
HOOK.callbacks = callbacks
HOOK.do_tile = do_tile
return HOOK
