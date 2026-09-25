-- DCS-SA-Hook.lua  -  lets DCS SA ask DCS World about its own map
--
-- Lives in  Saved Games\DCS\Scripts\Hooks\  (loaded automatically by DCS).
-- Answers requests from the DCS SA app on this PC (UDP 127.0.0.1:42682):
--   * terrain tiles: ground height and surface type (land / water / road /
--     runway) sampled from DCS's own terrain via the land.* scripting API
--   * airbases: every airfield, helipad and ship deck with its runways
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
local next_tile, next_hello = 0, 0
local theatre = nil

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
  queue, next_tile, next_hello = {}, 0, 0
  log_info("DCS-SA hook started")
end

function callbacks.onSimulationFrame()
  if not tx then return end
  local t = now()
  if t >= next_hello then next_hello = t + 5; pcall(hello) end
  pcall(poll)
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
