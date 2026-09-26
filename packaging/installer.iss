; Inno Setup script: builds dist\DCS-SA-Setup.exe from dist\DCS-SA.exe.
;   iscc /DAppVersion=0.1.0 packaging\installer.iss
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{6F2A7C1E-5B7D-4C1A-9E0B-DC5A5A0F16C0}
AppName=DCS SA
AppVersion={#AppVersion}
AppPublisher=DCS SA
AppComments=DCS World situational awareness and debrief
DefaultDirName={autopf}\DCS SA
DefaultGroupName=DCS SA
DisableProgramGroupPage=yes
; Per-user install: no admin prompt, and no "install for all users?" question.
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=DCS-SA-Setup
SetupIconFile=dcs-sa.ico
UninstallDisplayIcon={app}\DCS-SA.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Put a DCS SA icon on the &desktop"; GroupDescription: "Shortcuts:"
Name: "desktopicon_live"; Description: "Also a ""DCS SA Live"" icon for the second screen"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "..\dist\DCS-SA.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\DCS SA"; Filename: "{app}\DCS-SA.exe"
Name: "{autoprograms}\DCS SA Live"; Filename: "{app}\DCS-SA.exe"; Parameters: "--live"
Name: "{autodesktop}\DCS SA"; Filename: "{app}\DCS-SA.exe"; Tasks: desktopicon
Name: "{autodesktop}\DCS SA Live"; Filename: "{app}\DCS-SA.exe"; Parameters: "--live"; Tasks: desktopicon_live

[Run]
Filename: "{app}\DCS-SA.exe"; Description: "Start DCS SA now"; Flags: nowait postinstall skipifsilent
