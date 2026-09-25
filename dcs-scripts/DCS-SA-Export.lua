-- DCS-SA-Export.lua  -  DCS World -> DCS Situational Awareness bridge
--
-- Streams your own aircraft's state (flight data, control surfaces, gear/
-- flaps, stores, countermeasures, RWR contacts) to the DCS SA app over UDP on
-- this PC, several times a second.
--
-- Install: copy this file to  Saved Games\DCS\Scripts\  and add this line to
-- the END of  Saved Games\DCS\Scripts\Export.lua  (create it if missing):
--
--   local dcssalfs=require('lfs'); dofile(dcssalfs.writedir()..'Scripts/DCS-SA-Export.lua')
--
-- (The DCS SA app's "Install DCS bridge" button does this for you.)
--
-- It chains to every other exporter already in Export.lua (Tacview, SRS,
-- DCS-BIOS, ...) and never calls LoSetCommand: it only reads.  Multiplayer
-- servers that disable export will simply return nothing for the restricted
-- functions, and the script copes.

local DCSSA = {
  host = "127.0.0.1",
  port = 42680,
  rate = 10,          -- snapshots per second
  world_every = 1.0,  -- seconds between world-object sweeps (single player only)
  world_max = 150,
  world_range = 185000,
}

local prev = {
  LuaExportStart = LuaExportStart,
  LuaExportStop = LuaExportStop,
  LuaExportAfterNextFrame = LuaExportAfterNextFrame,
}

local socket_ok, socket = pcall(function()
  package.path = package.path .. ";.\\LuaSocket\\?.lua"
  package.cpath = package.cpath .. ";.\\LuaSocket\\?.dll"
  return require("socket")
end)

local udp = nil
local next_send = 0
local next_world = 0
local cached_world = nil
local R2D = 180 / math.pi

-- ---------------------------------------------------------------------------
-- Minimal JSON encoder (DCS's export environment has none built in)
-- ---------------------------------------------------------------------------

local function esc(s)
  s = string.gsub(s, '[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == "\\" then return "\\\\" end
    if c == "\n" then return "\\n" end
    return string.format("\\u%04x", string.byte(c))
  end)
  return s
end

local function is_array(t)
  local n = 0
  for k, _ in pairs(t) do
    if type(k) ~= "number" or k < 1 or math.floor(k) ~= k then return false end
    n = n + 1
  end
  return n == #t
end

local function encode(v, depth)
  depth = depth or 0
  if depth > 8 then return "null" end
  local tv = type(v)
  if tv == "nil" then return "null"
  elseif tv == "boolean" then return v and "true" or "false"
  elseif tv == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.floor(v) == v and math.abs(v) < 1e15 then return string.format("%d", v) end
    return string.format("%.6g", v)
  elseif tv == "string" then return '"' .. esc(v) .. '"'
  elseif tv == "table" then
    local parts = {}
    if next(v) == nil then return "{}" end
    if is_array(v) then
      for i = 1, #v do parts[#parts + 1] = encode(v[i], depth + 1) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, val in pairs(v) do
      if type(val) ~= "function" and type(val) ~= "userdata" then
        parts[#parts + 1] = '"' .. esc(tostring(k)) .. '":' .. encode(val, depth + 1)
      end
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end
DCSSA.encode = encode

-- ---------------------------------------------------------------------------
-- Safe access to DCS export functions
-- ---------------------------------------------------------------------------

local function call(name, ...)
  local fn = _G[name]
  if type(fn) ~= "function" then return nil end
  local ok, res = pcall(fn, ...)
  if ok then return res end
  return nil
end

local function num(x) if type(x) == "number" then return x end return nil end
local function deg(x) if type(x) == "number" then return x * R2D end return nil end
local function pick(t, ...)
  local cur = t
  for _, k in ipairs({...}) do
    if type(cur) ~= "table" then return nil end
    cur = cur[k]
  end
  return cur
end

local COALITION = { [0] = "Neutral", [1] = "Enemies", [2] = "Allies" }
local SIGNAL = {
  scan = "scan", lock = "lock", missile_radio_guided = "missile",
  track_while_scan = "tws", missile_active_homing = "missile",
}

local function build_self()
  local s = call("LoGetSelfData")
  if type(s) ~= "table" then return nil end
  local lla = s.LatLongAlt or {}
  local acc = call("LoGetAccelerationUnits")
  local me = {
    name = s.Name,
    unit = s.UnitName,
    group = s.GroupName,
    pilot = call("LoGetPilotName"),
    coalition = COALITION[s.CoalitionID] or s.Coalition,
    country = s.Country,
    lat = num(lla.Lat), lon = num(lla.Long), alt = num(lla.Alt),
    agl = num(call("LoGetAltitudeAboveGroundLevel")),
    hdg = deg(s.Heading), pitch = deg(s.Pitch), bank = deg(s.Bank),
    hdm = deg(call("LoGetMagneticYaw")),
    ias = num(call("LoGetIndicatedAirSpeed")),
    tas = num(call("LoGetTrueAirSpeed")),
    mach = num(call("LoGetMachNumber")),
    aoa = deg(call("LoGetAngleOfAttack")),
    aos = deg(call("LoGetAngleOfSlide")),
    vs = num(call("LoGetVerticalVelocity")),
    g = type(acc) == "table" and { x = num(acc.x), y = num(acc.y), z = num(acc.z) } or nil,
    ils = { glide = num(call("LoGetGlideDeviation")), side = num(call("LoGetSideDeviation")) },
    slip = num(call("LoGetSlipBallPosition")),
  }
  if me.hdg and me.hdg < 0 then me.hdg = me.hdg + 360 end
  return me
end

local function build_mech()
  local m = call("LoGetMechInfo")
  if type(m) ~= "table" then return nil, nil end
  local mech = {
    gear = num(pick(m, "gear", "value")),
    flaps = num(pick(m, "flaps", "value")),
    speedbrakes = num(pick(m, "speedbrakes", "value")),
    hook = num(pick(m, "hook", "value")),
    canopy = num(pick(m, "canopy", "value")),
    wheelbrakes = num(pick(m, "wheelbrakes", "value")),
    refuelingboom = num(pick(m, "refuelingboom", "value")),
  }
  -- Control-surface deflection (-1..1).  For conventional aircraft this
  -- tracks your stick and pedals directly; for fly-by-wire jets it is what
  -- the flight computer commanded.
  local cs = m.controlsurfaces
  local controls = nil
  if type(cs) == "table" then
    local el = num(pick(cs, "elevator", "left")) or num(pick(cs, "elevator", "right"))
    local al = num(pick(cs, "eleron", "left")) or num(pick(cs, "aileron", "left"))
    local ar = num(pick(cs, "eleron", "right")) or num(pick(cs, "aileron", "right"))
    local ru = num(pick(cs, "rudder", "left")) or num(pick(cs, "rudder", "right"))
    local roll = nil
    if al and ar then roll = (al - ar) / 2 elseif al then roll = al end
    controls = { pitch = el, roll = roll, yaw = ru, source = "surfaces" }
  end
  return mech, controls
end

local function build_engine()
  local e = call("LoGetEngineInfo")
  if type(e) ~= "table" then return nil end
  return {
    fuel_internal = num(e.fuel_internal),
    fuel_external = num(e.fuel_external),
    rpm = { left = num(pick(e, "RPM", "left")), right = num(pick(e, "RPM", "right")) },
    temp = { left = num(pick(e, "Temperature", "left")), right = num(pick(e, "Temperature", "right")) },
    flow = { left = num(pick(e, "FuelConsumption", "left")), right = num(pick(e, "FuelConsumption", "right")) },
  }
end

local function build_payload()
  local p = call("LoGetPayloadInfo")
  if type(p) ~= "table" then return nil end
  local out = { current = p.CurrentStation, gun = num(pick(p, "Cannon", "shells")), stations = {} }
  if type(p.Stations) == "table" then
    for i, st in ipairs(p.Stations) do
      if type(st) == "table" and (st.count or 0) > 0 then
        local w = st.weapon or {}
        local name = st.CLSID
        -- Friendly name lookup when the DCS database is reachable.
        if type(LoGetNameByType) == "function" and w.level1 then
          local ok, nm = pcall(LoGetNameByType, w.level1, w.level2, w.level3, w.level4)
          if ok and type(nm) == "string" and nm ~= "" then name = nm end
        end
        out.stations[#out.stations + 1] = {
          station = i, clsid = st.CLSID, name = name, count = st.count,
          selected = (i == p.CurrentStation), container = st.container,
        }
      end
    end
  end
  return out
end

local function build_rwr()
  local tws = call("LoGetTWSInfo")
  if type(tws) ~= "table" or type(tws.Emitters) ~= "table" then return nil end
  local list = {}
  for _, e in ipairs(tws.Emitters) do
    local label = nil
    local tp = e.Type
    if type(tp) == "table" and type(LoGetNameByType) == "function" then
      local ok, nm = pcall(LoGetNameByType, tp.level1, tp.level2, tp.level3, tp.level4)
      if ok and type(nm) == "string" then label = string.sub(nm, 1, 6) end
    end
    list[#list + 1] = {
      id = e.ID, azimuth = num(e.Azimuth), elevation = num(e.Elevation),
      power = num(e.Power), priority = num(e.Priority),
      signal = SIGNAL[e.SignalType] or e.SignalType, label = label,
    }
  end
  return { mode = tws.Mode, emitters = list }
end

local function build_lock()
  local locked = call("LoGetLockedTargetInformation")
  if type(locked) ~= "table" or not locked[1] then return nil end
  local t = locked[1]
  -- fim/fin are the horizontal/vertical viewing angles in own body axes;
  -- delta_psi is the target's aspect, not where it is.
  return {
    id = t.ID, distance = num(t.distance), closure = num(t.convergence_velocity),
    mach = num(t.mach), azimuth = deg(t.fim), elevation = deg(t.fin), aspect = deg(t.delta_psi),
  }
end

-- F-16C: the FCR's scan width (A6/A3/A2/A1) and bars (4B/3B/2B/1B) as shown
-- on the MFDs.  Clickable modules do not fill LoGetSightingSystemInfo, but the
-- MFD text is exported; node names change between patches, so match loosely.
local F16_AZ = { A6 = 60, A3 = 30, A2 = 25, A1 = 10 }
local function f16_fcr()
  if type(list_indication) ~= "function" then return nil end
  local az, bars, standby, seen = nil, nil, false, false
  for _, mfd in ipairs({ 4, 5 }) do
    local ok, text = pcall(list_indication, mfd)
    if ok and type(text) == "string" and string.find(text, "FCR", 1, true) then
      seen = true
      for piece in string.gmatch(text, "[^\n]+") do
        local v = string.match(piece, "^%s*(A[1236])%s*$")
        if v and not az then az = F16_AZ[v] end
        local b = string.match(piece, "^%s*([1-4])B%s*$")
        if b and not bars then bars = tonumber(b) end
        if string.find(piece, "STBY", 1, true) or string.find(piece, "OFF", 1, true) == 1 then standby = true end
      end
    end
  end
  if not seen or not az then return nil end
  bars = bars or 4
  -- Elevation half-angle from the bar pattern: 2.2 deg bar spacing, 3.2 deg beam.
  return { source = "F-16C FCR", azHalf = az, elHalf = ((bars - 1) * 2.2 + 3.2) / 2,
    centerAz = 0, centerEl = 0, bars = bars, on = not standby, label = "A" .. (az == 60 and 6 or az == 30 and 3 or az == 25 and 2 or 1) .. " " .. bars .. "B" }
end

-- Your radar's actual scan zone.  FC3 aircraft export it through
-- LoGetSightingSystemInfo (angles in radians; size taken as the full extent).
local function build_scan(me)
  if type(LoIsSensorExportAllowed) == "function" then
    local ok, allowed = pcall(LoIsSensorExportAllowed)
    if ok and allowed == false then return nil end
  end
  local s = call("LoGetSightingSystemInfo")
  if type(s) == "table" and type(s.ScanZone) == "table" then
    local size, pos = s.ScanZone.size or {}, s.ScanZone.position or {}
    local az = num(size.azimuth)
    if az and az > 0 then
      local el = num(size.elevation)
      return {
        source = "ScanZone", azHalf = deg(az) / 2, elHalf = el and deg(el) / 2 or nil,
        centerAz = deg(pos.azimuth) or 0, centerEl = deg(pos.elevation) or 0,
        range = num(pick(s, "scale", "distance")), on = s.radar_on,
        covMin = num(pick(s.ScanZone, "coverage_H", "min")), covMax = num(pick(s.ScanZone, "coverage_H", "max")),
      }
    end
  end
  if me and type(me.name) == "string" and string.find(me.name, "F-16", 1, true) then return f16_fcr() end
  return nil
end

local function build_world(me)
  if type(LoGetWorldObjects) ~= "function" or not me or not me.lat then return nil end
  local ok, objs = pcall(LoGetWorldObjects)
  if not ok or type(objs) ~= "table" then return nil end
  local near, own = {}, call("LoGetPlayerPlaneId")
  local cos_lat = math.cos(me.lat * math.pi / 180)
  for id, o in pairs(objs) do
    if id ~= own and type(o) == "table" and type(o.LatLongAlt) == "table" then
      local dlat = (o.LatLongAlt.Lat - me.lat) * 111320
      local dlon = (o.LatLongAlt.Long - me.lon) * 111320 * cos_lat
      local d2 = dlat * dlat + dlon * dlon
      if d2 < DCSSA.world_range * DCSSA.world_range then
        -- Weapons in flight (Type.level1 == 4) first: a missile at me must never be cut.
        local weapon = type(o.Type) == "table" and o.Type.level1 == 4
        near[#near + 1] = { id = id, o = o, key = (weapon and 0 or 1e12) + d2 }
      end
    end
  end
  table.sort(near, function(a, b) return a.key < b.key end)
  local out = {}
  for i = 1, math.min(#near, DCSSA.world_max) do
    local id, o = near[i].id, near[i].o
    local hdg = deg(o.Heading)
    if hdg and hdg < 0 then hdg = hdg + 360 end
    local flags = type(o.Flags) == "table" and o.Flags or {}
    out[#out + 1] = {
      id = id, name = o.Name, pilot = o.UnitName, group = o.GroupName,
      coalition = COALITION[o.CoalitionID] or o.Coalition,
      type = o.Type, lat = o.LatLongAlt.Lat, lon = o.LatLongAlt.Long, alt = o.LatLongAlt.Alt,
      hdg = hdg, pitch = deg(o.Pitch), bank = deg(o.Bank),
      -- DCS's own "radar is on" flag for this unit (pointing is not exported).
      radar = flags.RadarActive, jamming = flags.Jamming, human = flags.Human,
    }
  end
  return out
end

function DCSSA.snapshot(t)
  local me = build_self()
  if not me then return nil end
  local mech, controls = build_mech()
  local packet = {
    v = 1,
    t = t,
    self = me,
    mech = mech,
    controls = controls,
    engine = build_engine(),
    payload = build_payload(),
    cm = call("LoGetSnares"),
    rwr = build_rwr(),
    lock = build_lock(),
    scan = build_scan(me),
  }
  if t >= next_world then
    next_world = t + DCSSA.world_every
    cached_world = build_world(me)
  end
  packet.world = cached_world
  return packet
end

-- ---------------------------------------------------------------------------
-- Export hooks (chained)
-- ---------------------------------------------------------------------------

function LuaExportStart()
  if socket_ok and socket then
    udp = socket.udp()
    if udp then udp:settimeout(0) end
  end
  next_send, next_world = 0, 0
  if prev.LuaExportStart then pcall(prev.LuaExportStart) end
end

function LuaExportAfterNextFrame()
  if prev.LuaExportAfterNextFrame then pcall(prev.LuaExportAfterNextFrame) end
  if not udp then return end
  local t = call("LoGetModelTime") or 0
  if t < next_send then return end
  next_send = t + 1 / DCSSA.rate
  local ok, packet = pcall(DCSSA.snapshot, t)
  if ok and packet then
    local ok2, data = pcall(encode, packet)
    if ok2 then pcall(udp.sendto, udp, data, DCSSA.host, DCSSA.port) end
  end
end

function LuaExportStop()
  if udp then pcall(udp.close, udp); udp = nil end
  if prev.LuaExportStop then pcall(prev.LuaExportStop) end
end

return DCSSA
