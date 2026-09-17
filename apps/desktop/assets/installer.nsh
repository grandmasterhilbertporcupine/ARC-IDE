!include LogicLib.nsh
!include WinMessages.nsh
!include nsDialogs.nsh

!define MUI_BGCOLOR "161E2A"
!define MUI_TEXTCOLOR "EDF3FF"
!define MUI_DIRECTORYPAGE_BGCOLOR "1B2738"
!define MUI_INSTFILESPAGE_COLORS "EDF3FF 161E2A"

SetFont "Segoe UI" 9

Var ArcRail
Var ArcRailWidth
Var ArcDpi
Var ArcImageSize
Var ArcMotion
Var ArcStill
Var ArcBitmap
Var ArcTitleFont
Var ArcBodyFont
Var ArcAnimations
Var ArcHighContrast

!ifndef BUILD_UNINSTALLER
  !define DO_NOT_CREATE_DESKTOP_SHORTCUT
  !define DO_NOT_CREATE_START_MENU_SHORTCUT
  Var ArcOptionsInstallMode
  Var ArcDesktopShortcut
  Var ArcStartMenuShortcut
  Var ArcOptionsDialog
  Var ArcDesktopCheckbox
  Var ArcStartMenuCheckbox
!endif

!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.ArcGuiInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT ArcGuiInit
!endif

!macro ArcSurfaceColors HANDLE FOREGROUND BACKGROUND
  ${If} $ArcHighContrast != 0
    SetCtlColors ${HANDLE} SYSCLR:18 SYSCLR:15
  ${Else}
    SetCtlColors ${HANDLE} ${FOREGROUND} ${BACKGROUND}
  ${EndIf}
!macroend

!macro ArcColorControl HANDLE
  System::Call 'user32::GetClassNameW(p ${HANDLE}, w.r9, i ${NSIS_MAX_STRLEN})'
  ${If} $9 == "Edit"
    ${If} $ArcHighContrast != 0
      SetCtlColors ${HANDLE} SYSCLR:8 SYSCLR:5
    ${Else}
      SetCtlColors ${HANDLE} EDF3FF 1B2738
    ${EndIf}
  ${ElseIf} $9 == "Button"
    System::Call 'user32::GetWindowLongW(p ${HANDLE}, i -16) i.r8'
    IntOp $8 $8 & 15
    ${If} $8 >= 2
    ${AndIf} $8 <= 7
    ${OrIf} $8 == 9
      System::Call 'uxtheme::SetWindowTheme(p ${HANDLE}, w " ", w " ")'
      !insertmacro ArcSurfaceColors ${HANDLE} EDF3FF 161E2A
    ${EndIf}
  ${ElseIf} $9 != "Button"
    !insertmacro ArcSurfaceColors ${HANDLE} EDF3FF 161E2A
  ${EndIf}
  ${If} $9 == "msctls_progress32"
  ${AndIf} $ArcHighContrast == 0
    System::Call 'uxtheme::SetWindowTheme(p ${HANDLE}, w "", w "")'
    SendMessage ${HANDLE} ${PBM_SETBARCOLOR} 0 0xFF9E6B
    SendMessage ${HANDLE} ${PBM_SETBKCOLOR} 0 0x2A1E16
  ${EndIf}
!macroend

!macro ArcFunctions PREFIX
Function ${PREFIX}ArcGuiInit
  IfSilent arc_gui_done
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $ArcAnimations 0
  StrCpy $ArcHighContrast 0
  StrCpy $ArcMotion 0
  StrCpy $ArcStill 0
  StrCpy $ArcBitmap 0
  System::Call '*(i 12, i 0, p 0) p.r0'
  System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r0, i 0) i.r1'
  ${If} $1 != 0
    System::Call '*$0(i, i.r1)'
    IntOp $ArcHighContrast $1 & 1
  ${EndIf}
  System::Free $0
  ${If} $ArcHighContrast == 0
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i.r0, i 0) i.r1'
    ${If} $1 != 0
      StrCpy $ArcAnimations $0
    ${EndIf}
  ${EndIf}
  System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i.r1'
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
  StrCpy $ArcDpi $1
  ${If} $ArcDpi < 96
    StrCpy $ArcDpi 96
  ${EndIf}
  ${If} $ArcDpi <= 108
    StrCpy $ArcRailWidth 220
  ${ElseIf} $ArcDpi <= 132
    StrCpy $ArcRailWidth 275
  ${ElseIf} $ArcDpi <= 168
    StrCpy $ArcRailWidth 330
  ${Else}
    StrCpy $ArcRailWidth 440
  ${EndIf}
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  IntOp $3 $3 - $1
  IntOp $3 $3 + $ArcRailWidth
  IntOp $4 $4 - $2
  IntOp $5 $ArcRailWidth / 2
  IntOp $1 $1 - $5
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i r3, i r4, i 0x14)'
  System::Call 'user32::GetWindow(p $HWNDPARENT, i 5) p.r5'
  ${DoWhile} $5 != 0
    System::Call 'user32::GetWindowRect(p r5, p r0)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r0, i 2)'
    System::Call '*$0(i.r1, i.r2)'
    IntOp $1 $1 + $ArcRailWidth
    System::Call 'user32::SetWindowPos(p r5, p 0, i r1, i r2, i 0, i 0, i 0x15)'
    !insertmacro ArcColorControl $5
    System::Call 'user32::GetWindow(p r5, i 2) p.r5'
  ${Loop}
  !insertmacro ArcSurfaceColors $HWNDPARENT EDF3FF 161E2A
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i, i, i.r3, i.r4)'
  System::Free $0
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x54000000, i 0, i 0, i $ArcRailWidth, i r4, p $HWNDPARENT, p 0, p 0, p 0) p.s'
  Pop $ArcRail
  !insertmacro ArcSurfaceColors $ArcRail EDF3FF 101722
  CreateFont $ArcTitleFont "Segoe UI" 25 700
  CreateFont $ArcBodyFont "Segoe UI" 10 400
  IntOp $5 24 * $ArcDpi
  IntOp $5 $5 / 96
  IntOp $6 $ArcRailWidth - $5
  IntOp $6 $6 - $5
  IntOp $7 40 * $ArcDpi
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "ARC", i 0x50000000, i r5, i r5, i r6, i r7, p $HWNDPARENT, p 0, p 0, p 0) p.r0'
  !insertmacro ArcSurfaceColors $0 EDF3FF 101722
  SendMessage $0 ${WM_SETFONT} $ArcTitleFont 1
  InitPluginsDir
  ${If} $ArcDpi <= 108
    StrCpy $ArcImageSize 220
    File /oname=$PLUGINSDIR\arc-still.bmp "${BUILD_RESOURCES_DIR}\installer\generated\arc-still.bmp"
  ${ElseIf} $ArcDpi <= 132
    StrCpy $ArcImageSize 275
    File /oname=$PLUGINSDIR\arc-still.bmp "${BUILD_RESOURCES_DIR}\installer\generated\arc-still-125.bmp"
  ${ElseIf} $ArcDpi <= 168
    StrCpy $ArcImageSize 330
    File /oname=$PLUGINSDIR\arc-still.bmp "${BUILD_RESOURCES_DIR}\installer\generated\arc-still-150.bmp"
  ${Else}
    StrCpy $ArcImageSize 440
    File /oname=$PLUGINSDIR\arc-still.bmp "${BUILD_RESOURCES_DIR}\installer\generated\arc-still-200.bmp"
  ${EndIf}
  IntOp $5 $ArcRailWidth - $ArcImageSize
  IntOp $5 $5 / 2
  IntOp $6 78 * $ArcDpi
  IntOp $6 $6 / 96
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\arc-still.bmp", i 0, i 0, i 0, i 0x2010) p.s'
  Pop $ArcBitmap
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000000E, i r5, i r6, i $ArcImageSize, i $ArcImageSize, p $HWNDPARENT, p 0, p 0, p 0) p.s'
  Pop $ArcStill
  SendMessage $ArcStill ${STM_SETIMAGE} 0 $ArcBitmap
  ${If} $ArcAnimations != 0
    ${If} $ArcDpi <= 108
      File /oname=$PLUGINSDIR\arc-motion.avi "${BUILD_RESOURCES_DIR}\installer\generated\arc-motion.avi"
    ${ElseIf} $ArcDpi <= 132
      File /oname=$PLUGINSDIR\arc-motion.avi "${BUILD_RESOURCES_DIR}\installer\generated\arc-motion-125.avi"
    ${ElseIf} $ArcDpi <= 168
      File /oname=$PLUGINSDIR\arc-motion.avi "${BUILD_RESOURCES_DIR}\installer\generated\arc-motion-150.avi"
    ${Else}
      File /oname=$PLUGINSDIR\arc-motion.avi "${BUILD_RESOURCES_DIR}\installer\generated\arc-motion-200.avi"
    ${EndIf}
    System::Call '*(i 8, i 0x80) p.r0'
    System::Call 'comctl32::InitCommonControlsEx(p r0)'
    System::Free $0
    System::Call 'user32::CreateWindowExW(i 0, w "SysAnimate32", w "", i 0x50000005, i r5, i r6, i $ArcImageSize, i $ArcImageSize, p $HWNDPARENT, p 0, p 0, p 0) p.s'
    Pop $ArcMotion
    ${If} $ArcMotion != 0
      SendMessage $ArcMotion ${ACM_OPEN} 0 "STR:$PLUGINSDIR\arc-motion.avi" $0
      ${If} $0 != 0
        ShowWindow $ArcStill ${SW_HIDE}
      ${Else}
        System::Call 'user32::DestroyWindow(p $ArcMotion)'
        StrCpy $ArcMotion 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  IntOp $5 24 * $ArcDpi
  IntOp $5 $5 / 96
  IntOp $6 310 * $ArcDpi
  IntOp $6 $6 / 96
  IntOp $8 90 * $ArcDpi
  IntOp $8 $8 / 96
  IntOp $8 $8 + $ArcImageSize
  ${If} $6 < $8
    StrCpy $6 $8
  ${EndIf}
  IntOp $7 $ArcRailWidth - $5
  IntOp $7 $7 - $5
  IntOp $8 56 * $ArcDpi
  IntOp $8 $8 / 96
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Build together.$\r$\nRun with confidence.", i 0x50000000, i r5, i r6, i r7, i r8, p $HWNDPARENT, p 0, p 0, p 0) p.r0'
  !insertmacro ArcSurfaceColors $0 EDF3FF 101722
  SendMessage $0 ${WM_SETFONT} $ArcBodyFont 1
  IntOp $5 $ArcRailWidth - 1
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x50000000, i r5, i 0, i 1, i r4, p $HWNDPARENT, p 0, p 0, p 0) p.r0'
  ${If} $ArcHighContrast == 0
    SetCtlColors $0 "" "26354A"
  ${Else}
    SetCtlColors $0 "" SYSCLR:18
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $ArcRail, p 1, i 0, i 0, i 0, i 0, i 0x13)'
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
arc_gui_done:
FunctionEnd

Function ${PREFIX}ArcPageShow
  Push $0
  FindWindow $0 "#32770" "" $HWNDPARENT
  Call ${PREFIX}ArcColorPage
  Pop $0
FunctionEnd

Function ${PREFIX}ArcColorPage
  IfSilent arc_page_done
  ${If} $ArcRail == 0
  ${OrIf} $ArcRail == ""
    Return
  ${EndIf}
  Push $1
  Push $8
  Push $9
  ${If} $0 != 0
    !insertmacro ArcSurfaceColors $0 EDF3FF 161E2A
    System::Call 'user32::GetWindow(p r0, i 5) p.r1'
    ${DoWhile} $1 != 0
      !insertmacro ArcColorControl $1
      System::Call 'user32::GetWindow(p r1, i 2) p.r1'
    ${Loop}
  ${EndIf}
  Pop $9
  Pop $8
  Pop $1
arc_page_done:
FunctionEnd

Function ${PREFIX}ArcFullPageShow
  Call ${PREFIX}ArcColorPage
  IfSilent arc_full_done
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  ${If} $0 != 0
    ${If} $2 != 0
      System::Alloc 16
      Pop $7
      System::Call 'user32::GetClientRect(p r2, p r7)'
      System::Call '*$7(i, i, i.r8)'
      ShowWindow $2 ${SW_HIDE}
      System::Call 'user32::GetWindow(p r0, i 5) p.r1'
      ${DoWhile} $1 != 0
        ${If} $1 != $2
          System::Call 'user32::GetWindowRect(p r1, p r7)'
          System::Call 'user32::MapWindowPoints(p 0, p r0, p r7, i 2)'
          System::Call '*$7(i.r3, i.r4, i.r5, i.r6)'
          IntOp $5 $5 - $3
          IntOp $5 $5 + $8
          IntOp $6 $6 - $4
          ${If} $(^RTL) == 0
            IntOp $3 $3 - $8
          ${EndIf}
          System::Call 'user32::SetWindowPos(p r1, p 0, i r3, i r4, i r5, i r6, i 0x14)'
        ${EndIf}
        System::Call 'user32::GetWindow(p r1, i 2) p.r1'
      ${Loop}
      System::Free $7
    ${EndIf}
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
arc_full_done:
FunctionEnd

Function ${PREFIX}ArcGuiEnd
  IfSilent arc_end_done
  ${If} $ArcMotion != 0
    SendMessage $ArcMotion ${ACM_STOP} 0 0
    SendMessage $ArcMotion ${ACM_OPEN} 0 0
    System::Call 'user32::DestroyWindow(p $ArcMotion)'
    StrCpy $ArcMotion 0
  ${EndIf}
  ${If} $ArcStill != 0
    SendMessage $ArcStill ${STM_SETIMAGE} 0 0
    System::Call 'user32::DestroyWindow(p $ArcStill)'
    StrCpy $ArcStill 0
  ${EndIf}
  ${If} $ArcBitmap != 0
    System::Call 'gdi32::DeleteObject(p $ArcBitmap)'
    StrCpy $ArcBitmap 0
  ${EndIf}
  ${If} $ArcTitleFont != 0
    System::Call 'gdi32::DeleteObject(p $ArcTitleFont)'
  ${EndIf}
  ${If} $ArcBodyFont != 0
    System::Call 'gdi32::DeleteObject(p $ArcBodyFont)'
  ${EndIf}
arc_end_done:
FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro ArcFunctions "un."
  Function un.onGUIEnd
    Call un.ArcGuiEnd
  FunctionEnd
!else
  !insertmacro ArcFunctions ""
  Function .onGUIEnd
    Call ArcGuiEnd
  FunctionEnd
  Function .onVerifyInstDir
    Call ArcPageShow
  FunctionEnd
!endif

!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ArcPageShow
!macroend

!macro customPageAfterChangeDir
  Page custom ArcOptionsPageCreate ArcOptionsPageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ArcPageShow
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
  Function ArcLoadOptions
    ${If} $ArcOptionsInstallMode == $installMode
      Return
    ${EndIf}
    StrCpy $ArcOptionsInstallMode $installMode
    StrCpy $ArcDesktopShortcut ${BST_CHECKED}
    StrCpy $ArcStartMenuShortcut ${BST_CHECKED}
    Push $0
    ClearErrors
    ReadRegDWORD $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ArcDesktopShortcut
    ${IfNot} ${Errors}
    ${AndIf} $0 == "0"
      StrCpy $ArcDesktopShortcut ${BST_UNCHECKED}
    ${EndIf}
    ClearErrors
    ReadRegDWORD $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ArcStartMenuShortcut
    ${IfNot} ${Errors}
    ${AndIf} $0 == "0"
      StrCpy $ArcStartMenuShortcut ${BST_UNCHECKED}
    ${EndIf}
    ${If} ${isNoDesktopShortcut}
      StrCpy $ArcDesktopShortcut ${BST_UNCHECKED}
    ${EndIf}
    ClearErrors
    Pop $0
  FunctionEnd

  Function ArcOptionsPageCreate
    Call ArcLoadOptions
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Additional options" "Choose how you want to open ARC."
    nsDialogs::Create 1018
    Pop $ArcOptionsDialog
    ${If} $ArcOptionsDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Choose the shortcuts you want. Setup will remember these choices."
    Pop $0
    ${NSD_CreateCheckbox} 0 38u 100% 18u "Create a &desktop shortcut"
    Pop $ArcDesktopCheckbox
    ${NSD_SetState} $ArcDesktopCheckbox $ArcDesktopShortcut
    ${If} ${isNoDesktopShortcut}
      EnableWindow $ArcDesktopCheckbox 0
    ${EndIf}
    ${NSD_CreateCheckbox} 0 68u 100% 18u "Add ARC to the &Start menu"
    Pop $ArcStartMenuCheckbox
    ${NSD_SetState} $ArcStartMenuCheckbox $ArcStartMenuShortcut
    ${NSD_OnBack} ArcOptionsPageLeave
    ${NSD_CreateLabel} 0 98u 100% 32u "You can choose whether to launch ARC on the final screen. Your projects and settings are kept when reinstalling."
    Pop $0
    StrCpy $0 $ArcOptionsDialog
    Call ArcColorPage
    nsDialogs::Show
  FunctionEnd

  Function ArcOptionsPageLeave
    ${NSD_GetState} $ArcDesktopCheckbox $ArcDesktopShortcut
    ${NSD_GetState} $ArcStartMenuCheckbox $ArcStartMenuShortcut
  FunctionEnd
!endif
!macroend

!macro customInit
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !ifndef ONE_CLICK
      ${If} ${Silent}
      ${AndIf} $hasPerMachineInstallation == "1"
        Push $installMode
        StrCpy $installMode all
        SetShellVarContext all
        Call ArcLoadOptions
        Pop $installMode
        ${If} $installMode == "CurrentUser"
          SetShellVarContext current
        ${EndIf}
      ${Else}
        Call ArcLoadOptions
      ${EndIf}
    !else
      Call ArcLoadOptions
    !endif
  !else
    Call ArcLoadOptions
  !endif
!macroend

!macro customInstall
  !undef DO_NOT_CREATE_DESKTOP_SHORTCUT
  !undef DO_NOT_CREATE_START_MENU_SHORTCUT
  Push $keepShortcuts
  ${IfNot} ${isUpdated}
    StrCpy $keepShortcuts "false"
  ${EndIf}
  ${If} $ArcStartMenuShortcut == ${BST_CHECKED}
    !insertmacro addStartMenuLink $keepShortcuts
  ${EndIf}
  ${If} $ArcDesktopShortcut == ${BST_CHECKED}
    !insertmacro addDesktopLink $keepShortcuts
  ${EndIf}
  Pop $keepShortcuts
  StrCpy $launchLink $appExe
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ArcDesktopShortcut $ArcDesktopShortcut
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ArcStartMenuShortcut $ArcStartMenuShortcut
!macroend

!macro ArcFullPageCallback PREFIX NAME PAGE IMAGE
  Function ${PREFIX}${NAME}
    Push $0
    Push $2
    StrCpy $0 ${PAGE}
    StrCpy $2 ${IMAGE}
    Call ${PREFIX}ArcFullPageShow
    Pop $2
    Pop $0
  FunctionEnd
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "Launch ARC"
    !define MUI_FINISHPAGE_RUN_FUNCTION StartApp
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ArcFinishPageShow
  !insertmacro MUI_PAGE_FINISH
  !insertmacro ArcFullPageCallback "" ArcFinishPageShow $mui.FinishPage $mui.FinishPage.Image
!macroend

!macro customUnWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ArcWelcomePageShow
  !insertmacro MUI_UNPAGE_WELCOME
  !insertmacro ArcFullPageCallback "un." ArcWelcomePageShow $mui.WelcomePage $mui.WelcomePage.Image
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ArcPageShow
!macroend

!macro customUninstallPage
  !insertmacro MUI_FINISHPAGE_INTERFACE
  !insertmacro ArcFullPageCallback "un." ArcFinishPageShow $mui.FinishPage $mui.FinishPage.Image
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ArcFinishPageShow
!macroend

!macro customUnInstall
  Call un.ArcPageShow
!macroend
