-- Offline test: mock the DCS export API and a UDP socket, run the bridge.
local sent = {}
package.loaded["socket"] = {
  udp = function()
    return { settimeout = function() end,
             sendto = function(_, data, host, port) sent[#sent + 1] = {data, host, port} end,
             close = function() end }
  end,
}
local chained = 0
LuaExportAfterNextFrame = function() chained = chained + 1 end
local t = 0
function LoGetModelTime() return t end
function LoGetSelfData() return { Name = "F-16C_50", UnitName = "Viper 1-1", CoalitionID = 2,
  LatLongAlt = { Lat = 41.61, Long = 41.60, Alt = 3000 }, Heading = -0.5, Pitch = 0.05, Bank = 0.2 } end
function LoGetPilotName() return 'Ethan "Test"' end
function LoGetIndicatedAirSpeed() return 150 end
function LoGetAngleOfAttack() return 0.1 end
function LoGetAccelerationUnits() return { x = 0, y = 1.5, z = 0 } end
function LoGetMechInfo() return { gear = { value = 0 }, flaps = { value = 0.5 },
  controlsurfaces = { elevator = { left = -0.2, right = -0.2 }, eleron = { left = 0.3, right = -0.3 }, rudder = { left = 0.1 } } } end
function LoGetPayloadInfo() return { CurrentStation = 2, Cannon = { shells = 510 },
  Stations = { { CLSID = "{AIM-120C}", count = 1, weapon = { level1 = 4 } }, { CLSID = "{AIM-9X}", count = 1 }, { CLSID = "{TANK}", count = 0 } } } end
function LoGetSnares() return { chaff = 60, flare = 60 } end
function LoGetTWSInfo() return { Mode = 0, Emitters = { { ID = 7, Power = 0.8, Azimuth = 0.5, SignalType = "lock", Type = { level1 = 1 } } } } end
function LoGetNameByType() return "MiG-29S" end
function LoGetEngineInfo() error("simulated module without engine data") end
function LoGetSightingSystemInfo() return { radar_on = true, ScanZone = { size = { azimuth = 1.0472, elevation = 0.1745 },
  position = { azimuth = 0.1, elevation = 0 }, coverage_H = { min = 0, max = 20000 } }, scale = { distance = 74080 } } end
function LoGetLockedTargetInformation() return { { ID = 7, distance = 30000, fim = 0.2, fin = -0.05, delta_psi = 2.9 } } end
function LoGetWorldObjects() return { [7] = { Name = "MiG-29S", CoalitionID = 1, LatLongAlt = { Lat = 41.7, Long = 41.7, Alt = 6000 },
  Heading = 3.3, Flags = { RadarActive = true, Jamming = false } } } end
function LoGetPlayerPlaneId() return 1 end
dofile("dcs-scripts/DCS-SA-Export.lua")
LuaExportStart()
for i = 1, 30 do t = i * 0.05; LuaExportAfterNextFrame() end
LuaExportStop()
assert(chained == 30, "previous export hook must be chained")
assert(#sent >= 14 and #sent <= 16, "expected ~10 Hz, got " .. #sent)
assert(sent[1][2] == "127.0.0.1" and sent[1][3] == 42680)
local last = sent[#sent][1]
assert(string.find(last, '"scan":{', 1, true), "scan zone must be exported")
assert(string.find(last, '"source":"ScanZone"', 1, true))
assert(string.find(last, '"radar":true', 1, true), "world radar flag must be exported")
print("packets:", #sent, "chained:", chained)
print(sent[#sent][1])

-- F-16C: no ScanZone, read the FCR's A/B settings from the MFD text instead.
LoGetSightingSystemInfo = function() return nil end
LoGetSelfData = function() return { Name = "F-16C_50", LatLongAlt = { Lat = 41.6, Long = 41.6, Alt = 3000 }, Heading = 0 } end
list_indication = function(n)
  if n == 4 then
    return "-----------------------------------------\nFCR_NotModeMenu_RootAA.2.Table. Root. Unic ID: _id:8.1.Text.1\n2B\n" ..
           "-----------------------------------------\nFCR_NotModeMenu_RootAA.2.Table. Root. Unic ID: _id:9.1.Text.2\nA3\n"
  end
  return ""
end
local DCSSA = dofile("dcs-scripts/DCS-SA-Export.lua")
local pkt = DCSSA.snapshot(5)
assert(pkt.scan and pkt.scan.source == "F-16C FCR", "F-16 FCR scan must be parsed")
assert(pkt.scan.azHalf == 30 and pkt.scan.bars == 2, "A3 2B -> +/-30 deg, 2 bars")
print("f16 fcr:", DCSSA.encode(pkt.scan))

-- An aircraft with nothing on its pylons must still send a list.
do
  local empty = DCSSA.encode({ stations = DCSSA.array(), emitters = DCSSA.array({}) })
  assert(empty:find('"stations":%[%]'), "empty stations must encode as [], got " .. empty)
  assert(empty:find('"emitters":%[%]'), "empty emitters must encode as [], got " .. empty)
  local one = DCSSA.encode({ stations = DCSSA.array({ { station = 1 } }) })
  assert(one:find('"stations":%[{'), "a filled list still encodes as an array, got " .. one)
  local obj = DCSSA.encode({ a = 1 })
  assert(obj:find('^{"a":1}'), "plain tables still encode as objects, got " .. obj)
  print("empty list encoding ok")
end
