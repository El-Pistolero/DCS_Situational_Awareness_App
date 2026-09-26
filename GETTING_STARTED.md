# Getting started with DCS SA (step by step)

This guide assumes you have never used GitHub or installed an app from it. Follow the steps in order. Each step says exactly what to click and what you should see.

**What DCS SA does:** it replays your DCS World flights on a map and in 3D (a *debrief*), and it can show your jet and the threats around you live on a second screen while you fly.

**What you need:**
- A Windows 10 or Windows 11 PC (the one you play DCS on).
- DCS World.
- A free GitHub account, only to download the app (Step 1 shows how to make one).
- An internet connection for the map pictures. Without one the app still works, but the map is dark with only grid lines.

You do **not** need to install Python, a web browser, a paid Tacview or anything else. It is one app.

---

## Step 1: Download the app

The app is built automatically every time the project changes. You download the newest build from the project's GitHub page.

1. Go to **https://github.com** and click **Sign in** at the top right. No account yet? Click **Sign up** there, make a free one, then sign in. GitHub only lets signed-in people download builds.
2. Open this page: **[DCS SA builds that worked](https://github.com/El-Pistolero/DCS_Situational_Awareness_App/actions/workflows/build-exe.yml?query=is%3Asuccess)**. It is titled **Build Windows exe** and lists the builds, newest at the top.
3. Each row has a bold title that describes a change to the app (for example *"Refuse requests from other websites…"*). The words don't matter. Click the bold title of the **top row**. It has a green circle with a white tick on its left.
   - A yellow dot means that build is still being made. It takes a few minutes. Use the next row down with a green tick, or wait and refresh the page (press **F5**).
4. On the page that opens, scroll down to the section called **Artifacts**. It has one row, **DCS-SA-windows**.
5. Click **DCS-SA-windows**. Your browser downloads **DCS-SA-windows.zip** (about 30 MB). It appears in the browser's download list (top right in Edge and Chrome). Wait until it has finished.
   - If the browser says the file *isn't commonly downloaded* or *could be dangerous*, see [If something doesn't work](#if-something-doesnt-work) at the end.
   - Builds are kept for 90 days. If the Artifacts section says the build has *expired*, ask the project owner for a new one (the owner clicks **Run workflow** on the Build Windows exe page).

## Step 2: Install it

1. Open **File Explorer** (the yellow folder icon on the taskbar, or hold the **Windows key** and press **E**) and click **Downloads** on the left. Find **DCS-SA-windows**, which has a zipper on its icon. Windows usually hides the `.zip` at the end of the name. If you downloaded it before, the newest one is called **DCS-SA-windows (1)** or similar.
2. Right-click it and choose **Extract All…**, then click **Extract**. A new window opens with two files. Windows usually hides the `.exe` ending, so they may just be called:
   - **DCS-SA-Setup**: the installer. Use this one.
   - **DCS-SA**: ignore this one.

   If only one file is there, your antivirus removed the other: see [If something doesn't work](#if-something-doesnt-work).
3. Double-click **DCS-SA-Setup**.
4. Windows will probably show a blue box: **Windows protected your PC**. This is normal for small free apps that aren't code-signed (signing costs money every year). Click the small **More info** link. It shows *Publisher: Unknown publisher*, which is expected. Then click **Run anyway**.
   - If a different box says **Smart App Control blocked an app**, there is no Run anyway button: see [If something doesn't work](#if-something-doesnt-work).
5. The installer starts. It installs for your Windows user only, so it never asks for an administrator password. Click through it like this:
   - **Select Destination Location**: leave it as it is and click **Next**.
   - **Select Additional Tasks**: **Put a DCS SA icon on the desktop** is already ticked. If you have a second monitor for flying, also tick **Also a "DCS SA Live" icon for the second screen**. Click **Next**.
   - **Ready to Install**: click **Install**. It takes a few seconds.
   - **Completing the DCS SA Setup Wizard**: leave **Start DCS SA now** ticked and click **Finish**. The app opens (give it up to 10 seconds).

From now on, open the app from the **DCS SA** icon on your desktop, or press the **Windows key**, type **DCS SA** and press **Enter**. Close its window to quit. (Clicking the icon again while it is open just brings its window to the front.)

## Step 3: Try it with a demo flight (no DCS needed)

1. Open **DCS SA**. A window titled **DCS SA - Debrief** opens on the **Flight debrief** page, with a list of recordings. Three come with the app and end in **(demo)**:
   - `sample_sortie.acmi (demo)`: takeoff, an AIM-120 kill, a dodged missile, a strafing run and a landing;
   - `sample_strike.acmi (demo)`: a JSOW strike on a vehicle column and a SAM site, plus bombs;
   - `sample_dogfight.acmi (demo)`: a turning fight with AIM-9s, an R-73 and flares.
2. Click one. A progress bar shows for a few seconds, then the flight appears on the map, stopped at the start.
3. Press the **Space bar** (or the **▶** button at the bottom left) to play or pause. Drag along the timeline at the bottom to jump around.
4. Click any aircraft, missile or ground unit to see what it is. **Right-click** it for everything you can do with it.
5. For the list of keyboard shortcuts, click the **⌨** button at the top right, or press **?** (hold **Shift** and press **/** on most keyboards). **V** switches between the map and 3D.

To go back to the list, click **Recordings** (top left). To read this guide inside the app, click **Guide** on the Flight debrief page.

## Step 4: Record your own flights

DCS already includes the Tacview recorder; you only need to switch it on, once.

1. Start **DCS World**.
2. In the DCS main menu click **OPTIONS**, then the **SPECIAL** tab along the top. In the list on the left, scroll down and click **Tacview**.
3. Tick **Tacview Module Enabled** and **Flight Data Recording Enabled**, then click **OK** at the bottom right. (The exact wording can differ between DCS versions. Switch on whatever turns on Tacview and flight recording, and leave everything else as it is. If there are separate settings for single-player and multiplayer flights, switch on the ones you fly.)
   - If Tacview isn't in the list, install the free Tacview from **tacview.net** and look again.
4. Fly a mission as normal. When you leave the mission (back to the DCS menu), the recording is saved in your **Documents\Tacview** folder, with a name starting **Tacview-** followed by the date.
5. Open **DCS SA** and click that name in the list. If DCS SA was already open, within about half a minute a bar appears at the top, **New recording: '…'**, with an **Open debrief** button. Click it.

Got an `.acmi` file from somewhere else (a squadron mate, a USB stick)? Drag it onto the DCS SA window, or click **Recordings**, then **choose a file**.

**Is it showing the right jet as yours?** The app picks *your* jet from your DCS pilot name and marks it **ME**. If it picks the wrong one, right-click your jet on the map and choose **This is me** (or click it and press **This is me** on the right). The app remembers this for that recording, and offers to remember your pilot name: click **Remember it** so it picks the right jet in your next recordings too.

## Step 5 (optional): your jet live on a second screen

This shows your aircraft, threats and missiles live on a second monitor while you fly, like a big moving map. It also makes your debriefs more accurate. Do this step with **DCS closed** if you can: it saves a restart.

1. Open the live view. If DCS SA is already open, click **Live view ↗** at the top right of its window, and a second window, **DCS SA - Live**, opens. If DCS SA isn't open, open **DCS SA Live** from the Start menu (or its desktop icon, if you ticked that box when installing).
2. In the middle of the live view it says **Waiting for telemetry**. Click the **Connect…** button under it (or **⚙ Connect** at the top right). A box called **Live source** opens.
3. At the bottom of that box, click **Install DCS bridge into Export.lua**. A pop-up says **Installed in:** followed by a folder like `C:\Users\<you>\Saved Games\DCS\Scripts`. Click **OK**. The box now says **bridge installed**. Click **Close**.
   - This puts two small script files in your `Saved Games\DCS\Scripts` folder and adds one line to its `Export.lua` file. Your other add-ons (Tacview, SRS, DCS-BIOS and so on) keep working. If you already had an `Export.lua`, a copy of the old one is kept next to it as `Export.lua.before-dcs-sa`.
   - If the pop-up says **No DCS Saved Games folder found**, start DCS once, quit it, and try again.
4. Start DCS. If it was already running, quit it completely, back to the Windows desktop, then start it again: DCS only reads the new scripts when it starts, so restarting just the mission isn't enough.
5. Start a mission and get into the cockpit. Within a few seconds the live view shows your jet, and the text at the top says **DCS bridge: receiving**.
6. To put it on your second monitor, drag the window there by its title bar, then double-click the title bar to make it fill the screen. Click **Glance** at the top (or press **G**) for a big-text layout you can read at a glance during a fight.

Flying in VR? The live view is a window on your monitor, so you won't see it in the headset. The bridge still makes your debriefs more accurate.

On multiplayer servers, the server decides what may be shown. The bridge only ever *reads* from DCS, and anything the server blocks simply doesn't appear.

To see what the live view looks like without DCS: click **Connect…**, pick a demo under **Replay a recording (practice / testing)**, and click **Play**.

## Step 6 (optional): everyone else live too

The bridge in Step 5 shows **your** jet. To also see every other aircraft and missile live, DCS SA can read the **real-time telemetry** of the Tacview recorder built into DCS. This step is optional: try it, and if it doesn't connect, skip it.

> **Do I need to buy Tacview Advanced?** You shouldn't. Tacview's paid Advanced edition is what the *Tacview program* needs to show real-time telemetry. DCS SA reads the data straight from the recorder inside DCS and doesn't use the Tacview program at all. (This hasn't been tried on every DCS version yet, which is why this step is optional.)

1. In DCS, on the same **OPTIONS → SPECIAL → Tacview** page, switch on **real-time telemetry** and click **OK**. Leave its port as it is (`42674`). If you set a password there, remember it.
2. In the DCS SA live view, click **Connect…** (or **⚙ Connect**). Under **Tacview real-time telemetry**, leave **Host** (`127.0.0.1`) and **Port** (`42674`) as they are. Fill in **Password** only if you set one in DCS. Click **Connect**.
3. Once a mission is running, the text at the top says **Tacview: connected**.

DCS SA remembers this and connects again by itself the next time you open it. To stop, open **Connect…** and click **Disconnect**.

---

## Updating to a newer version

1. Close DCS SA.
2. Download the newest build as in Step 1. The new file may be called **DCS-SA-windows (1)**.
3. Extract it and double-click **DCS-SA-Setup** in the new folder. Click through the installer as before. It replaces the old version.

Your recordings, settings and the DCS bridge stay. If you installed the bridge, DCS SA updates its scripts by itself the next time it starts; restart DCS afterwards if it was running.

## Uninstalling

- **The app:** close DCS SA. Open Windows **Settings → Apps → Installed apps** (Windows 10: **Settings → Apps → Apps & features**) and find **DCS SA** (followed by a version number). Click the **⋯** next to it (Windows 10: click the entry), choose **Uninstall**, then click **Yes** when it asks. Your recordings and settings in `Documents\DCS-SA` are kept; delete that folder too if you want them gone.
- **The DCS bridge** (only if you installed it in Step 5):
  1. Hold the **Windows key** and press **R**, type `%USERPROFILE%\Saved Games\DCS\Scripts` and press **Enter**.
  2. Delete **DCS-SA-Export.lua**. Then open the **Hooks** folder and delete **DCS-SA-Hook.lua**.
  3. Back in **Scripts**, right-click **Export.lua** → **Open with** → **Notepad**. Delete the one line that contains `DCS-SA-Export.lua` and save (**Ctrl+S**).
     If there is no file called `Export.lua.before-dcs-sa`, DCS SA created `Export.lua` itself, and you can delete the whole file instead (unless you have installed another add-on since).
  4. If you also have a `DCS.openbeta` folder next to `DCS` in Saved Games, do the same there.

## If something doesn't work

| What you see | What to do |
|---|---|
| Your browser blocks the download | **Edge:** point at the download, click **⋯** → **Keep** → **Show more** → **Keep anyway**. **Chrome:** open the download list and choose **Keep** (or **Download suspicious file**). |
| Windows Security says it found a threat in DCS-SA, or a file vanished from the folder | Some antivirus tools wrongly flag small unsigned apps. Only if you got it from this project's page: open **Windows Security → Virus & threat protection → Protection history**, click the DCS-SA entry, then **Actions → Allow on device** (or **Restore**). Then extract the zip again. |
| **Windows protected your PC** when starting the installer | Click **More info**, then **Run anyway** (Step 2). |
| **Smart App Control blocked an app** (Windows 11) | Smart App Control only lets code-signed apps run and DCS SA isn't signed, so there is no Run anyway. The only way round it is to turn it off in **Windows Security → App & browser control → Smart App Control settings**. Windows may not let you turn it back on without resetting the PC, so decide for yourself. |
| Double-clicking the icon does nothing | Wait 10 seconds: every start takes a few seconds. Still nothing? Check **Windows Security → Protection history** in case the antivirus removed DCS SA (see above), then restart the PC and try again. |
| My flights are not in the list | Check that recording is switched on (Step 4) and that a file starting **Tacview-** is in `Documents\Tacview`. The bottom of the Flight debrief page lists the folders DCS SA searched (*Searched: …*). You can always open a file with **Recordings → choose a file**. |
| The map is dark with only thin grid lines | No internet connection, or map pictures are blocked. Everything else still works. |
| The live view keeps saying **Waiting for telemetry** | Did you install the bridge and restart DCS completely (Step 5)? DCS SA must be open while you fly. On some multiplayer servers exporting is switched off. |
| **No DCS Saved Games folder found** | Start DCS once so it creates the folder, quit it, then install the bridge again. |

## For the curious

The full manual, with everything the app can do, is in the **[README](README.md)**. To run the app from its source code instead of the installer, see *Install → Option C* there.
