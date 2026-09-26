# Getting started with DCS SA (step by step)

This guide assumes you have never used GitHub or installed an app from it. Follow the steps in order. Each step says exactly what to click and what you should see.

**What DCS SA does:** it replays your DCS World flights on a map and in 3D (a *debrief*), and it can show your jet and the threats around you live on a second screen while you fly.

**What you need:**
- A Windows 10 or Windows 11 PC (the one you play DCS on).
- DCS World.
- **Tacview** (the free version), which puts the flight recorder into DCS. Step 4 shows how. You never have to open the Tacview program itself, and you don't need its paid editions.
- An internet connection for the map pictures. Without one the app still works, but the map is dark with only grid lines.

You do **not** need to install Python, a web browser, or any paid Tacview edition.

---

## Step 1: Download the app

Every time the app changes, a new version is published automatically. You just take the newest one. No GitHub account needed.

1. Open this page: **[DCS SA — latest version](https://github.com/El-Pistolero/DCS_Situational_Awareness_App/releases/latest)**
2. Scroll down to **Assets** and click **DCS-SA-Setup.exe**. Your browser downloads it (about 30 MB). It appears in the browser's download list (top right in Edge and Chrome). Wait until it has finished.
   - If the browser says the file *isn't commonly downloaded* or *could be dangerous*, see [If something doesn't work](#if-something-doesnt-work) at the end.
   - `DCS-SA.exe` is next to it in the list. Ignore that one; it's the app without an installer.

That's the whole download. There is nothing to unzip.

> **Page not found, or no Assets?** A version is probably still being built, which takes a few minutes. Wait and refresh (**F5**).

## Step 2: Install it

1. Open your **Downloads** folder: in File Explorer (the yellow folder icon on the taskbar, or hold the **Windows key** and press **E**), click **Downloads** on the left. You can also click **Show in folder** next to the file in your browser's download list.
2. Find **DCS-SA-Setup** and double-click it. Windows usually hides the `.exe` at the end of the name. If you have downloaded it before, the newest one is called **DCS-SA-Setup (1)** or similar.
   - Not there at all? Your antivirus may have removed it: see [If something doesn't work](#if-something-doesnt-work).
3. Windows will probably show a blue box: **Windows protected your PC**. This is normal for small free apps that aren't code-signed (signing costs money every year). Click the small **More info** link. It shows *Publisher: Unknown publisher*, which is expected. Then click **Run anyway**.
   - If a different box says **Smart App Control blocked an app**, there is no Run anyway button: see [If something doesn't work](#if-something-doesnt-work).
4. The installer starts. It installs for your Windows user only, so it never asks for an administrator password. Click through it like this:
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
6. If anything ever looks wrong, press **Shift+C** for the **Console**: a plain list of what DCS SA is doing — telemetry arriving, the DCS bridge connecting, files loaded, and any warnings or errors. Nothing in it is sent anywhere. **Copy** puts it on the clipboard if you want to show someone.
7. The **⚙** button at the top right opens **Settings**, where you can change the look: **Cockpit green** (green on black, the default), **Bright** (black on white, for a lit room) or **Night blue**. Your choice is remembered.

To go back to the list, click **Recordings** (top left). To read this guide inside the app, click **Guide** on the Flight debrief page.

## Step 4: Record your own flights

The recordings are made by **Tacview's recorder**, a small add-on that sits inside DCS. DCS SA reads what it writes. You install it once, switch it on once, then forget about it.

### 4a: Get the recorder into DCS

Tacview's own program puts the recorder into DCS for you. The free version is enough, and you never have to open the Tacview program again afterwards.

1. **Close DCS completely** (back to the Windows desktop). Tacview can't install into DCS while DCS is running.
2. Install Tacview if you haven't: the free download from **https://www.tacview.net**, or the Tacview app on Steam. Either is fine.
3. **Start Tacview once** and let it finish loading. That is when it copies its recorder into DCS. Then close it.
   - On Steam it must be launched **from Steam** at least once, so its install script runs.
4. Start **DCS World**, click **OPTIONS**, then the **SPECIAL** tab along the top, and look down the list on the left for **Tacview**.

**Still no Tacview in that list?** Then the recorder didn't reach your DCS folder, and you can copy it across yourself:

1. Find Tacview's own folder. On Steam: right-click **Tacview** in your library, then **Manage** and **Browse local files**. Otherwise it is usually `C:\Program Files (x86)\Tacview`.
2. Inside it, open the **DCS** folder. It holds a **Mods** folder and a **Scripts** folder. Copy both.
3. Hold the **Windows key** and press **R**, type `%USERPROFILE%\Saved Games` and press **Enter**. Open your DCS folder there. It is usually called **DCS**, but may be **DCS.openbeta**. If both exist, do this in both.
4. Paste the two folders in. If Windows asks about merging or replacing files, say yes.
5. Start DCS and look under **OPTIONS → SPECIAL** again.

DCS SA tells you which of these you are missing: if it can see your DCS folder but no recorder, the Flight debrief page and the live view's **Connect…** box say so.

### 4b: Switch recording on and fly

1. In **OPTIONS → SPECIAL → Tacview**, tick **Tacview Module Enabled** and **Flight Data Recording Enabled**, then click **OK** at the bottom right. (The exact wording can differ between versions. Switch on whatever turns on Tacview and flight recording, and leave everything else as it is. If there are separate settings for single-player and multiplayer flights, switch on the ones you fly.)
2. Fly a mission as normal. When you leave the mission (back to the DCS menu), the recording is saved in your **Documents\Tacview** folder, with a name starting **Tacview-** followed by the date.
3. Open **DCS SA** and click that name in the list. If DCS SA was already open, within about half a minute a bar appears at the top, **New recording: '…'**, with an **Open debrief** button. Click it.

Got an `.acmi` file from somewhere else (a squadron mate, a USB stick)? Drag it onto the DCS SA window, or click **Recordings**, then **choose a file**.

**Is it showing the right jet as yours?** The app picks *your* jet from your DCS pilot name and marks it **ME**. If it picks the wrong one, right-click your jet on the map and choose **This is me** (or click it and press **This is me** on the right). The app remembers this for that recording, and offers to remember your pilot name: click **Remember it** so it picks the right jet in your next recordings too.

## Step 5 (optional): your jet live on a second screen

This shows your aircraft, threats and missiles live on a second monitor while you fly, like a big moving map. It also makes your debriefs more accurate. Do this step with **DCS closed** if you can: it saves a restart.

**Quickest way:** on the **Flight debrief** page, if the bridge isn't installed yet, DCS SA offers it with an **Install it** button. Click that, then restart DCS, and skip to point 4. Otherwise:

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

The **Flight debrief** page always shows which version you have, just under the Guide line: *"DCS SA 0.1.51 · up to date"*, with a **Check again** link. When a newer one exists it says so instead — *"DCS SA 0.1.52 is out (you have 0.1.51)"* — with a **Get it** button. DCS SA checks about once an hour, and never downloads or installs anything by itself.

1. Click **Get it**. Your browser opens the download page. Click **DCS-SA-Setup.exe** under **Assets**.
2. Close DCS SA.
3. Double-click the downloaded **DCS-SA-Setup** and click through the installer as before. It replaces the old version.

Your recordings, settings and the DCS bridge stay. You never have to reinstall the bridge: DCS SA brings its scripts up to date by itself each time it starts, and DCS picks them up the next time you start DCS.

Don't want it looking for updates? Make a file called `dcs-sa.toml` next to the app with the line `update_check = false`.

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
| Windows Security says it found a threat in DCS-SA, or a file vanished from the folder | Some antivirus tools wrongly flag small unsigned apps. Only if you got it from this project's page: open **Windows Security → Virus & threat protection → Protection history**, click the DCS-SA entry, then **Actions → Allow on device** (or **Restore**). Then download it again. |
| **Windows protected your PC** when starting the installer | Click **More info**, then **Run anyway** (Step 2). |
| **Smart App Control blocked an app** (Windows 11) | Smart App Control only lets code-signed apps run and DCS SA isn't signed, so there is no Run anyway. The only way round it is to turn it off in **Windows Security → App & browser control → Smart App Control settings**. Windows may not let you turn it back on without resetting the PC, so decide for yourself. |
| Double-clicking the icon does nothing | Wait 10 seconds: every start takes a few seconds. Still nothing? Check **Windows Security → Protection history** in case the antivirus removed DCS SA (see above), then restart the PC and try again. |
| My flights are not in the list | Check that Tacview's recorder is installed and switched on (Step 4) and that a file starting **Tacview-** is in `Documents\Tacview`. The bottom of the Flight debrief page lists the folders DCS SA searched (*Searched: …*). You can always open a file with **Recordings → choose a file**. |
| The map is dark with only thin grid lines | No internet connection, or map pictures are blocked. Everything else still works. |
| The live view keeps saying **Waiting for telemetry** | Did you install the bridge and restart DCS completely (Step 5)? DCS SA must be open while you fly. On some multiplayer servers exporting is switched off. |
| **No DCS Saved Games folder found** | Start DCS once so it creates the folder, quit it, then install the bridge again. |
| There is no **Tacview** in DCS under **OPTIONS → SPECIAL** | Tacview's recorder isn't in your DCS yet. See Step 4a, including the copy-it-yourself steps. |

## For the curious

The full manual, with everything the app can do, is in the **[README](README.md)**. To run the app from its source code instead of the installer, see *Install → Option C* there.
