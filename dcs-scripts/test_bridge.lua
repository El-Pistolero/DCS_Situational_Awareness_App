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
dofile("dcs-scripts/DCS-SA-Export.lua")
LuaExportStart()
for i = 1, 30 do t = i * 0.05; LuaExportAfterNextFrame() end
LuaExportStop()
assert(chained == 30, "previous export hook must be chained")
assert(#sent >= 14 and #sent <= 16, "expected ~10 Hz, got " .. #sent)
assert(sent[1][2] == "127.0.0.1" and sent[1][3] == 42680)
print("packets:", #sent, "chained:", chained)
print(sent[#sent][1])
