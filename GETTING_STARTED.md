# Getting started with DCS SA (step by step)

This guide assumes you have never used GitHub or installed an app from it. Follow the steps in order. Each step says exactly what to click and what you should see.

**What DCS SA does:** it replays your DCS World flights on a map and in 3D (a *debrief*), and it can show your jet and the threats around you live on a second screen while you fly.

**What you need:**
- A Windows 10 or Windows 11 PC (the one you play DCS on).
- DCS World.
- An internet connection for the map pictures. Without one the app still works, but the map is a plain grid.

You do **not** need to install Python, a web browser or anything else. It is one app.

---

## Step 1: Download the app

The app is built automatically every time the project changes. You download the newest build from the project's **Actions** page on GitHub.

1. Make sure you are **signed in to GitHub** (top right of github.com). GitHub only lets signed-in people download builds.
2. Open this page: **https://github.com/El-Pistolero/DCS_Situational_Awareness_App/actions/workflows/build-exe.yml**
3. You see a list of runs called **Build Windows exe**. Click the **top one** that has a **green tick** ✅ next to it (the newest working build).
4. On the page that opens, scroll to the bottom, to the section called **Artifacts**.
5. Click **DCS-SA-windows**. Your browser downloads a file called **`DCS-SA-windows.zip`** (about 33 MB).

> If the project has a **Releases** section on its GitHub front page (right-hand side), you can download **`DCS-SA-Setup.exe`** from there instead and skip to Step 2, point 3.

## Step 2: Install it

1. Open your **Downloads** folder and find **`DCS-SA-windows.zip`**.
2. Right-click it and choose **Extract All…**, then click **Extract**. A folder opens with two files in it:
   - **`DCS-SA-Setup.exe`**: the installer. Use this one.
   - `DCS-SA.exe`: the same app without an installer (see the note at the end of this step).
3. Double-click **`DCS-SA-Setup.exe`**.
4. Windows will probably show a blue box saying **"Windows protected your PC"**. This appears for any app that isn't from a big company that paid for a certificate. Click **More info**, then **Run anyway**.
5. The installer opens:
   - It installs for your Windows user only, so it doesn't ask for an administrator password.
   - On the **Shortcuts** page, the "DCS SA icon on the desktop" box is ticked. If you have a second monitor for flying, also tick **"Also a DCS SA Live icon for the second screen"**.
   - Click **Next** / **Install**, then **Finish**. With "Start DCS SA now" ticked, the app opens straight away.

From now on, open the app from the **DCS SA** icon on your desktop or in the Start menu. Close its window to quit.

> **No installer?** You can also just double-click **`DCS-SA.exe`** from the extracted folder (or move it anywhere first). The first time it runs, it adds the DCS SA icons to your desktop and Start menu by itself.

## Step 3: Try it with a demo flight (no DCS needed)

1. Open **DCS SA**. It starts on a page listing recordings. The three whose names end in **(demo)** come with the app:
   - `sample_sortie`: takeoff, an AIM-120 kill, a dodged missile, a strafing run and a landing;
   - `sample_strike`: a JSOW strike on a vehicle column and a SAM site, plus bombs;
   - `sample_dogfight`: a turning fight with AIM-9s, an R-73 and flares.
2. Click one. The flight opens on the map.
3. Press the **Space bar** to play or pause. Drag the timeline at the bottom to jump around.
4. Click any aircraft, missile or ground unit to see what it is. **Right-click** it for everything you can do with it.
5. Press **?** at any time for the list of keyboard shortcuts. **V** switches between the map and 3D.
6. The **ALL / A-A / A-G** buttons at the top switch between everything, the dogfight view and the ground-attack view.

To go back to the list, click **Recordings** (top left).

## Step 4: Record your own flights

DCS already includes the Tacview recorder; you only need to switch it on, once.

1. Start **DCS World**.
2. Go to **Options**, then the **SPECIAL** tab, then **Tacview** in the list on the left.
3. Switch **recording on** (enable it), then click **OK**.
4. Fly a mission as normal. When the mission ends, DCS saves the recording (a `.acmi` file) in your **Documents\Tacview** folder.
5. Open **DCS SA**. Your flight is in the list; click it. If DCS SA was already open when the recording was saved, a banner offers to open it for you.

You can also drag any `.acmi` file onto the DCS SA window to open it.

**Optional:** the app picks *your* jet in each recording from your DCS pilot name. If it picks the wrong one, click your jet and choose **This is me**.

## Step 5 (optional): your jet live on a second screen

This shows your aircraft, threats and missiles live while you fly, like a big moving map. It also lets the 3D view use DCS's own terrain, and lets debriefs show hits and kills exactly as DCS reported them.

1. Open the live view: use the **DCS SA Live** icon, or click **Live view ↗** at the top of the DCS SA window.
2. Click **⚙ Connect** (top right).
3. Click **Install DCS bridge into Export.lua**. A message says where it was installed.
   - This copies two small script files into your `Saved Games\DCS` folder. Your other add-ons (Tacview, SRS, DCS-BIOS and so on) keep working. If you already had an `Export.lua`, a backup copy is kept as `Export.lua.before-dcs-sa`.
   - If it says **"No DCS Saved Games folder found"**, start DCS once, close it, and try again.
4. **Restart DCS** (quit it completely and start it again).
5. Start a mission. The live view shows your jet within a few seconds.
6. To put it on your second monitor, drag the window there and maximise it. Click **Glance** at the top (or press **G**) for a big-text layout you can read at a glance during a fight.

On multiplayer servers, the server decides what may be shown. The bridge only ever *reads* from DCS, and anything the server blocks simply doesn't appear.

## Step 6 (optional): everyone else live too

The bridge in Step 5 shows **your** jet. To also see every other aircraft and missile live, the app can connect to the **real-time telemetry** of the Tacview exporter that comes with DCS.

> **Do I need to buy Tacview Advanced?** You shouldn't. Tacview's paid Advanced edition is what the *Tacview program* needs to show real-time telemetry, but DCS SA connects to DCS's exporter directly and doesn't use the Tacview program at all. Try the free setup below first. Everything else in this guide (recordings, debriefs, your own jet live) never needs a paid Tacview.

1. In DCS, in the same **Options → SPECIAL → Tacview** page, switch **real-time telemetry** on.
2. In the DCS SA live view, click **⚙ Connect**. Under **Tacview real-time telemetry**, leave the address as it is (`127.0.0.1`, port `42674`) and click **Connect**.

---

## Updating to a newer version

Download the newest build as in Step 1 and run **`DCS-SA-Setup.exe`** again. It replaces the old version; your recordings and settings stay.

## Uninstalling

- **The app:** Windows **Settings → Apps → Installed apps** (on Windows 10: **Apps & features**), find **DCS SA**, and choose **Uninstall**.
- **The DCS bridge** (only if you installed it in Step 5): in your `Saved Games\DCS\Scripts` folder, delete `DCS-SA-Export.lua` and `Hooks\DCS-SA-Hook.lua`. Then open `Export.lua` in Notepad and delete the one line that mentions `DCS-SA-Export.lua` (or, if you had no other add-ons, delete `Export.lua`).

## If something doesn't work

| What you see | What to do |
|---|---|
| "Windows protected your PC" when starting the installer | Click **More info → Run anyway** (Step 2). |
| Your browser or antivirus blocks the download or deletes the file | The app is new and not signed by a big company, so some antivirus tools are cautious. Allow the file, or add an exception for it. |
| Double-clicking the icon does nothing | Wait 10 seconds: the first start can be slow. If still nothing, restart the PC and try again. |
| My flights are not in the list | Check that recording is switched on (Step 4) and that a `.acmi` file exists in `Documents\Tacview`. You can always drag the file onto the window. |
| The map is a grey grid | No internet connection, or map pictures are blocked. Everything else still works. |
| The live view keeps saying **"Waiting for telemetry"** | Did you install the bridge and **restart DCS** (Step 5)? DCS SA must be open while you fly. On some multiplayer servers exporting is switched off. |
| "No DCS Saved Games folder found" | Start DCS once so it creates the folder, then install the bridge again. |

## For the curious

The full manual, with everything the app can do, is in the **[README](README.md)**. To run the app from its source code instead of the installer, see *Install → Option C* there.
