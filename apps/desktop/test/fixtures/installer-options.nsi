Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "ARC installer options regression"
OutFile "${TEST_OUTPUT}"
!addincludedir "${BUILDER_TEMPLATES}\include"
!addplugindir /x86-unicode "${TEST_PLUGINS}"
!include StdUtils.nsh
!include Win\COM.nsh

!macro _isNoDesktopShortcut _a _b _t _f
  ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`

!include "${PRODUCTION_INCLUDE}"
!include MUI2.nsh
!define INSTALL_REGISTRY_KEY "Software\ARCInstallerOptionsTest-${TEST_ID}"
!define APP_ID "org.arc.installer-options-test.${TEST_ID}"
!define APP_DESCRIPTION "ARC isolated installer options test"
Var installMode
Var hasPerMachineInstallation
Var appExe
Var launchLink
Var keepShortcuts
Var oldMenuDirectory
Var oldStartMenuLink
Var newStartMenuLink
Var oldDesktopLink
Var newDesktopLink
Var TestInput
Var TestResult
Var TestValue
Var TestCase

!ifdef BUILD_UNINSTALLER
  !ifdef DO_NOT_CREATE_DESKTOP_SHORTCUT
    !error "Installer suppression must not disable desktop cleanup in the uninstaller"
  !endif
  !ifdef DO_NOT_CREATE_START_MENU_SHORTCUT
    !error "Installer suppression must not disable Start menu cleanup in the uninstaller"
  !endif
  !insertmacro customUnWelcomePage
  !insertmacro MUI_UNPAGE_INSTFILES
  !insertmacro customUninstallPage
  !insertmacro MUI_UNPAGE_FINISH
  !insertmacro MUI_LANGUAGE "English"
  Section
    WriteUninstaller "${TEST_ROOT}\uninstaller.exe"
  SectionEnd
  Section "Uninstall"
    !insertmacro customUnInstall
  SectionEnd
!else
  !define HIDE_RUN_AFTER_FINISH
  !insertmacro customWelcomePage
  !insertmacro MUI_PAGE_DIRECTORY
  !insertmacro customPageAfterChangeDir
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro customFinishPage
  !insertmacro MUI_LANGUAGE "English"
  !insertmacro customHeader
  !include "${BUILDER_TEMPLATES}\include\installer.nsh"

  !macro SeedPreference NAME
    ReadINIStr $0 $TestInput input ${NAME}Type
    ReadINIStr $1 $TestInput input ${NAME}
    ${If} $0 == "dword"
      WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" Arc${NAME}Shortcut $1
    ${ElseIf} $0 == "string"
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" Arc${NAME}Shortcut $1
    ${EndIf}
  !macroend

  !macro ReadShortcutTarget NAME PATH
    StrCpy $2 ""
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
    ${If} $0 P<> 0
      ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
      ${If} $1 P<> 0
        ${IPersistFile::Load} $1 '("${PATH}",0).r3'
        ${If} $3 == 0
          ${IShellLink::GetPath} $0 '(.r2,${NSIS_MAX_STRLEN},0,0).r3'
        ${EndIf}
        ${IUnknown::Release} $1 ""
      ${EndIf}
      ${IUnknown::Release} $0 ""
    ${EndIf}
    WriteINIStr $TestResult result ${NAME}Target $2
  !macroend

  Function .onInit
    SetShellVarContext current
    SetRegView 32
    ${StdUtils.GetParameter} $TestCase "case" ""
    StrCpy $INSTDIR "${TEST_ROOT}\$TestCase"
    StrCpy $TestInput "$INSTDIR\input.ini"
    StrCpy $TestResult "$INSTDIR\result.ini"
    IfFileExists $TestInput +3
      SetErrorLevel 71
      Quit
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    !insertmacro SeedPreference Desktop
    !insertmacro SeedPreference StartMenu
    StrCpy $installMode CurrentUser
    ReadINIStr $hasPerMachineInstallation $TestInput input machineInstallation
    StrCpy $0 "register-sentinel"
    !insertmacro customInit
    WriteINIStr $TestResult result preservedRegister $0
    WriteINIStr $TestResult result initialDesktop $ArcDesktopShortcut
    WriteINIStr $TestResult result initialStartMenu $ArcStartMenuShortcut
    WriteINIStr $TestResult result installMode $installMode
    WriteINIStr $TestResult result cachedMode $ArcOptionsInstallMode
    ReadRegDWORD $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ArcDesktopShortcut
    WriteINIStr $TestResult result restoredContextDesktop $1
    ReadINIStr $TestValue $TestInput input probeScope
    ${If} $TestValue == "1"
      DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
      SetErrorLevel 0
      Quit
    ${EndIf}
    ReadINIStr $TestValue $TestInput input reload
    ${If} $TestValue == "1"
      WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" ArcDesktopShortcut 1
      WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" ArcStartMenuShortcut 0
      Call ArcLoadOptions
      WriteINIStr $TestResult result sameModeDesktop $ArcDesktopShortcut
      WriteINIStr $TestResult result sameModeStartMenu $ArcStartMenuShortcut
      StrCpy $installMode "different-scope"
      Call ArcLoadOptions
      WriteINIStr $TestResult result changedModeDesktop $ArcDesktopShortcut
      WriteINIStr $TestResult result changedModeStartMenu $ArcStartMenuShortcut
    ${EndIf}
  FunctionEnd

  Section
    SetOutPath $INSTDIR
    StrCpy $appExe "$INSTDIR\arc-test-target.exe"
    CopyFiles /SILENT $EXEPATH $appExe
    StrCpy $newDesktopLink "$INSTDIR\desktop.lnk"
    StrCpy $newStartMenuLink "$INSTDIR\start-menu.lnk"
    StrCpy $oldDesktopLink $newDesktopLink
    StrCpy $oldStartMenuLink $newStartMenuLink
    StrCpy $oldMenuDirectory ""
    ReadINIStr $keepShortcuts $TestInput input keepShortcuts
    ReadINIStr $TestValue $TestInput input retain
    ${If} $TestValue == "1"
      CopyFiles /SILENT $EXEPATH "$INSTDIR\retained-target.exe"
      CreateShortCut $newDesktopLink "$INSTDIR\retained-target.exe"
      CreateShortCut $newStartMenuLink "$INSTDIR\retained-target.exe"
    ${EndIf}
    !insertmacro addStartMenuLink $keepShortcuts
    !insertmacro addDesktopLink $keepShortcuts
    StrCpy $0 0
    IfFileExists $newDesktopLink 0 +2
      StrCpy $0 1
    WriteINIStr $TestResult result beforeDesktop $0
    StrCpy $0 0
    IfFileExists $newStartMenuLink 0 +2
      StrCpy $0 1
    WriteINIStr $TestResult result beforeStartMenu $0
    ReadINIStr $TestValue $TestInput input erase
    ${If} $TestValue == "1"
      DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    ${EndIf}
    Push "stack-sentinel"
    !insertmacro customInstall
    Pop $0
    WriteINIStr $TestResult result preservedStack $0
    WriteINIStr $TestResult result keepShortcuts $keepShortcuts
    WriteINIStr $TestResult result launchLink $launchLink
    ReadRegDWORD $0 HKCU "${INSTALL_REGISTRY_KEY}" ArcDesktopShortcut
    WriteINIStr $TestResult result savedDesktop $0
    ReadRegDWORD $0 HKCU "${INSTALL_REGISTRY_KEY}" ArcStartMenuShortcut
    WriteINIStr $TestResult result savedStartMenu $0
    !insertmacro ReadShortcutTarget desktop $newDesktopLink
    !insertmacro ReadShortcutTarget startMenu $newStartMenuLink
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    SetErrorLevel 0
  SectionEnd
!endif
