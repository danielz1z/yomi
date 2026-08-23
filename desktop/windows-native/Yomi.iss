#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef SourceDir
  #error SourceDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
AppId={{D7769078-33C4-4EB5-B501-C28D6E431B89}
AppName=Yomi Desktop
AppVersion={#AppVersion}
AppPublisher=RikaiDev
AppPublisherURL=https://github.com/RikaiDev/yomi
AppSupportURL=https://github.com/RikaiDev/yomi/issues
DefaultDirName={localappdata}\Programs\Yomi
DefaultGroupName=Yomi
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Yomi-Desktop-Windows-x64-{#AppVersion}-Setup
SetupIconFile=Yomi.ico
UninstallDisplayIcon={app}\Yomi.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Yomi"; Filename: "{app}\Yomi.exe"

[Run]
Filename: "{app}\Yomi.exe"; Description: "Launch Yomi Desktop"; Flags: nowait postinstall skipifsilent
