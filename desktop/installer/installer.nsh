!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "UAC.nsh"

!define EVE_WIDTH 620
!define EVE_HEIGHT 450
!define EVE_MAX_INSTALL_PATH 220
!define EVE_INSTALL_STATE_KEY "Software\Eve\Installer"

; SetCtlColors consumes RGB hex. Raw Win32 messages still need COLORREF.
!define EVE_ACCENT 0x3157D5
!define EVE_ACCENT_COLORREF 0xD55731
!define EVE_BG 0xFAFBFC
!define EVE_BG_BOTTOM 0xF2F4F7
!define EVE_SURFACE 0xFFFFFF
!define EVE_INPUT 0xF7F8FA
!define EVE_TEXT 0x171B21
!define EVE_TEXT_SECONDARY 0x495570
!define EVE_TEXT_TERTIARY 0x6A768F
!define EVE_SOFT 0xF0F2F5
!define EVE_SOFT_COLORREF 0xF5F2F0
!define EVE_DANGER 0xDC2626

!define EVE_STATIC_LEFT 0x50000180
!define EVE_STATIC_CENTER 0x50000381
!define EVE_BITMAP_STYLE 0x5000000E
!define EVE_EDIT_STYLE 0x50010080

!ifdef BUILD_UNINSTALLER
  ; MUI2 consumes the SHOW callback through the shared macro even for
  ; uninstaller pages; the target function carries the `un.` prefix.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.EveUninstFilesShow
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.EveGuiInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT EveGuiInit
!endif

Var EveDialog
Var EvePageInner
Var EveBackground
Var EveBackgroundImage
Var EveBrandTitle
Var EveBrandMeta
Var EveDragSurface
Var EveMinimize
Var EveClose
Var EvePrimary
Var EveSecondary
Var EveNativeProgress
Var EveButtonCaption

!ifndef BUILD_UNINSTALLER
  Var EvePathField
  Var EvePathError
  Var EvePathValid
  Var EveErrorText
  Var EveLaunchOnFinish
  Var EveInstallAllUsers
  Var EveSelectedInstallPath
  Var EveElevatedResume
  Var EveScopeCurrentCheck
  Var EveScopeAllCheck
  Var EveScopeCurrentTitle
  Var EveScopeAllTitle
  Var EveScopeCurrentDetail
  Var EveScopeAllDetail
!endif

!macro EveRawStatic OUT TEXT X Y WIDTH HEIGHT PARENT FG BG FACE SIZE WEIGHT STYLE
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${STYLE}, i ${X}, i ${Y}, i ${WIDTH}, i ${HEIGHT}, p ${PARENT}, p 0, p 0, p 0) p.r0'
  StrCpy ${OUT} $0
  SetCtlColors ${OUT} ${FG} ${BG}
  CreateFont $R9 "${FACE}" "${SIZE}" "${WEIGHT}"
  SendMessage ${OUT} ${WM_SETFONT} $R9 1
!macroend

!macro EveRawCommandStatic OUT TEXT X Y WIDTH HEIGHT PARENT FG BG FACE SIZE WEIGHT STYLE ID
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${STYLE}, i ${X}, i ${Y}, i ${WIDTH}, i ${HEIGHT}, p ${PARENT}, p ${ID}, p 0, p 0) p.r0'
  StrCpy ${OUT} $0
  SetCtlColors ${OUT} ${FG} ${BG}
  CreateFont $R9 "${FACE}" "${SIZE}" "${WEIGHT}"
  SendMessage ${OUT} ${WM_SETFONT} $R9 1
!macroend

!macro EveInteractiveStatic OUT TEXT X Y WIDTH HEIGHT PARENT FG BG FACE SIZE WEIGHT STYLE
  ; nsDialogs must own clickable statics so their callbacks are registered.
  ${NSD_CreateLabel} ${X} ${Y} ${WIDTH} ${HEIGHT} "${TEXT}"
  Pop ${OUT}
  System::Call 'user32::SetWindowLongW(p ${OUT}, i -16, i ${STYLE}) i .r0'
  SetCtlColors ${OUT} ${FG} ${BG}
  CreateFont $R9 "${FACE}" "${SIZE}" "${WEIGHT}"
  SendMessage ${OUT} ${WM_SETFONT} $R9 1
!macroend

!macro EveTransparentClickTarget OUT X Y WIDTH HEIGHT PARENT CALLBACK
  ${NSD_CreateLabel} ${X} ${Y} ${WIDTH} ${HEIGHT} ""
  Pop ${OUT}
  System::Call 'user32::SetWindowLongW(p ${OUT}, i -16, i ${EVE_STATIC_CENTER}) i .r0'
  SetCtlColors ${OUT} 0xFFFFFF transparent
  ${NSD_OnClick} ${OUT} ${CALLBACK}
!macroend

!macro EveTextButton OUT TEXT X Y WIDTH HEIGHT FG BG CALLBACK
  IntOp $0 ${X} + 12
  IntOp $1 ${Y} + 6
  IntOp $2 ${WIDTH} - 24
  IntOp $3 ${HEIGHT} - 12
  !insertmacro EveRawStatic $EveButtonCaption "${TEXT}" $0 $1 $2 $3 $EveDialog ${FG} ${BG} "Microsoft YaHei UI" "11" "600" ${EVE_STATIC_CENTER}
  !insertmacro EveTransparentClickTarget ${OUT} ${X} ${Y} ${WIDTH} ${HEIGHT} $EveDialog ${CALLBACK}
!macroend

!macro EveLoadBackground PARENT FILE OUT HANDLE
  InitPluginsDir
  ; File extracts relative to $OUTDIR. Keep the active install directory
  ; untouched while staging the page bitmap in the plugin cache.
  Push $OUTDIR
  SetOutPath $PLUGINSDIR
  File /oname=eve-${FILE} "${BUILD_RESOURCES_DIR}\${FILE}"
  Pop $OUTDIR
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${EVE_BITMAP_STYLE}, i 0, i 0, i ${EVE_WIDTH}, i ${EVE_HEIGHT}, p ${PARENT}, p 0, p 0, p 0) p.r0'
  StrCpy ${OUT} $0
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\eve-${FILE}", i 0, i ${EVE_WIDTH}, i ${EVE_HEIGHT}, i 0x10) p.r2'
  StrCpy ${HANDLE} $2
  SendMessage ${OUT} ${STM_SETIMAGE} 0 $2
!macroend

!macro EveHideControl ID
  GetDlgItem $R0 $HWNDPARENT ${ID}
  ${If} $R0 P<> 0
    ShowWindow $R0 ${SW_HIDE}
  ${EndIf}
!macroend

!macro EveHideChromeBody
  Push $R0
  !insertmacro EveHideControl 1028
  !insertmacro EveHideControl 1034
  !insertmacro EveHideControl 1035
  !insertmacro EveHideControl 1037
  !insertmacro EveHideControl 1038
  !insertmacro EveHideControl 1039
  !insertmacro EveHideControl 1045
  !insertmacro EveHideControl 1046
  !insertmacro EveHideControl 1256
  !insertmacro EveHideControl 1
  !insertmacro EveHideControl 2
  !insertmacro EveHideControl 3
  Pop $R0
!macroend

!macro EveFitPageBody
  ; The page callback runs before the outer wizard receives its final client
  ; size. Use the known page dimensions so the child dialog cannot stay 0x0.
  System::Call 'USER32::SetWindowPos(p $EveDialog, p 0, i 0, i 0, i ${EVE_WIDTH}, i ${EVE_HEIGHT}, i 0x54)'
  ShowWindow $EveDialog ${SW_SHOW}
!macroend

!macro EveShowPageBody PREFIX
  Call ${PREFIX}EveFitPage
  nsDialogs::Show
!macroend

!macro EveTopbarBody PREFIX
  !insertmacro EveRawStatic $EveBrandTitle "Eve" 58 10 36 22 $EveDialog ${EVE_TEXT} ${EVE_BG} "Segoe UI Variable Display" "14" "650" ${EVE_STATIC_LEFT}
  !insertmacro EveRawStatic $EveBrandMeta "科研工作台" 96 13 92 18 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Microsoft YaHei UI" "10" "400" ${EVE_STATIC_LEFT}
  !insertmacro EveInteractiveStatic $EveDragSurface "" 194 0 332 54 $EveDialog ${EVE_BG} ${EVE_BG} "Segoe UI" "10" "400" ${EVE_STATIC_LEFT}
  !insertmacro EveInteractiveStatic $EveMinimize "−" 548 12 24 28 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Segoe UI Symbol" "14" "400" ${EVE_STATIC_CENTER}
  !insertmacro EveInteractiveStatic $EveClose "×" 580 12 24 28 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Segoe UI Symbol" "14" "400" ${EVE_STATIC_CENTER}

  ${NSD_OnClick} $EveDragSurface ${PREFIX}EveDragWindow
  ${NSD_OnClick} $EveMinimize ${PREFIX}EveMinimizeWindow
  ${NSD_OnClick} $EveClose ${PREFIX}EveCloseWindow
!macroend

!macro EveRawTopbarBody
  !insertmacro EveRawStatic $EveBrandTitle "Eve" 58 10 36 22 $EveDialog ${EVE_TEXT} ${EVE_BG} "Segoe UI Variable Display" "14" "650" ${EVE_STATIC_LEFT}
  !insertmacro EveRawStatic $EveBrandMeta "科研工作台" 96 13 92 18 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Microsoft YaHei UI" "10" "400" ${EVE_STATIC_LEFT}
!macroend

!macro EveBeginPageBody PREFIX FILE
  Call ${PREFIX}EveHideChrome
  nsDialogs::Create 1018
  Pop $EveDialog
  ${If} $EveDialog == error
    Abort
  ${EndIf}
  Call ${PREFIX}EveFitPage
  !insertmacro EveLoadBackground $EveDialog "${FILE}" $EveBackground $EveBackgroundImage
  Call ${PREFIX}EveCreateTopbar
!macroend

!macro EveButton OUT TEXT X Y WIDTH HEIGHT FG BG CALLBACK
  !insertmacro EveInteractiveStatic ${OUT} "${TEXT}" ${X} ${Y} ${WIDTH} ${HEIGHT} $EveDialog ${FG} ${BG} "Microsoft YaHei UI" "11" "600" ${EVE_STATIC_CENTER}
  ${NSD_OnClick} ${OUT} ${CALLBACK}
!macroend

!macro EveWindowControlBody ACTION
  Pop $0
  System::Call 'user32::ReleaseCapture()'
  ${If} "${ACTION}" == "drag"
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x00A1, p 2, p 0) i .r1'
  ${ElseIf} "${ACTION}" == "minimize"
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_SYSCOMMAND}, p 0xF020, p 0) i .r1'
  ${Else}
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0) i .r1'
  ${EndIf}
!macroend

!macro EvePostNextBody
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $0 P<> 0
    EnableWindow $0 1
    System::Call 'user32::PostMessageW(p $0, i ${BM_CLICK}, p 0, p 0) i .r1'
  ${EndIf}
!macroend

!macro EveGuiInitBody
  StrCpy $0 "0"
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i r0, i 4) i .r1'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r0'
  IntOp $0 $0 & 0xFF30FFFF
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0) i .r1'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i ${EVE_WIDTH}, i ${EVE_HEIGHT}, i 0x16) i .r1'
!macroend

!macro EveProgressBody PREFIX MODE
  Call ${PREFIX}EveHideChrome

  FindWindow $EvePageInner "#32770" "" $HWNDPARENT
  GetDlgItem $EveNativeProgress $EvePageInner 1004
  GetDlgItem $R0 $EvePageInner 1006
  ${If} $R0 P<> 0
    ShowWindow $R0 ${SW_HIDE}
  ${EndIf}
  GetDlgItem $R0 $EvePageInner 1016
  ${If} $R0 P<> 0
    ShowWindow $R0 ${SW_HIDE}
  ${EndIf}
  GetDlgItem $R0 $EvePageInner 1027
  ${If} $R0 P<> 0
    ShowWindow $R0 ${SW_HIDE}
  ${EndIf}
  System::Call 'USER32::SetWindowPos(p $EvePageInner, p 0, i 0, i 0, i ${EVE_WIDTH}, i ${EVE_HEIGHT}, i 0x54)'
  ShowWindow $EvePageInner ${SW_SHOW}

  StrCpy $EveDialog $EvePageInner
  !if "${MODE}" == "install"
    !insertmacro EveLoadBackground $EvePageInner "installerProgress.bmp" $EveBackground $EveBackgroundImage
  !else
    !insertmacro EveLoadBackground $EvePageInner "installerUninstallProgress.bmp" $EveBackground $EveBackgroundImage
  !endif
  System::Call 'USER32::SetWindowPos(p $EveBackground, p 1, i 0, i 0, i 0, i 0, i 0x13)'
  !insertmacro EveRawTopbarBody

  !if "${MODE}" == "install"
    !insertmacro EveRawStatic $R3 "正在安装 Eve" 64 90 470 38 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Segoe UI Variable Display" "22" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R4 "正在写入应用文件。" 64 134 470 24 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R5 "现有项目与设置会保留。" 64 251 470 24 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_SURFACE} "Microsoft YaHei UI" "10" "400" ${EVE_STATIC_LEFT}
  !else
    !insertmacro EveRawStatic $R3 "正在卸载 Eve" 64 90 470 38 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Segoe UI Variable Display" "22" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R4 "正在移除应用文件。" 64 134 470 24 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R5 "项目、技能、记忆和设置会保留。" 64 251 470 24 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_SURFACE} "Microsoft YaHei UI" "10" "400" ${EVE_STATIC_LEFT}
  !endif

  ; ID 2 is the install page's cancel command. SS_NOTIFY makes a fully
  ; custom-painted static emit the same WM_COMMAND notification.
  !insertmacro EveRawStatic $EveButtonCaption "取消" 462 352 82 28 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "600" ${EVE_STATIC_CENTER}
  !insertmacro EveRawCommandStatic $EveSecondary "" 450 346 106 40 $EveDialog 0xFFFFFF transparent "Microsoft YaHei UI" "11" "600" ${EVE_STATIC_CENTER} 2

  ${If} $EveNativeProgress P<> 0
    System::Call 'uxtheme::SetWindowTheme(p $EveNativeProgress, w " ", w " ")'
    SendMessage $EveNativeProgress 0x2001 0 ${EVE_SOFT_COLORREF}
    SendMessage $EveNativeProgress 0x0409 0 ${EVE_ACCENT_COLORREF}
    System::Call 'USER32::SetWindowPos(p $EveNativeProgress, p 0, i 64, i 210, i 492, i 8, i 0x14)'
    ShowWindow $EveNativeProgress ${SW_SHOW}
  ${EndIf}

!macroend

!ifndef BUILD_UNINSTALLER
  Function EveGuiInit
    !insertmacro EveGuiInitBody
  FunctionEnd
!else
  Function un.EveGuiInit
    !insertmacro EveGuiInitBody
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveHideChrome
    !insertmacro EveHideChromeBody
  FunctionEnd
!else
  Function un.EveHideChrome
    !insertmacro EveHideChromeBody
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveFitPage
    !insertmacro EveFitPageBody
  FunctionEnd
!else
  Function un.EveFitPage
    !insertmacro EveFitPageBody
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveCreateTopbar
    !insertmacro EveTopbarBody ""
  FunctionEnd
!else
  Function un.EveCreateTopbar
    !insertmacro EveTopbarBody "un."
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveDragWindow
    !insertmacro EveWindowControlBody "drag"
  FunctionEnd
!else
  Function un.EveDragWindow
    !insertmacro EveWindowControlBody "drag"
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveMinimizeWindow
    !insertmacro EveWindowControlBody "minimize"
  FunctionEnd
!else
  Function un.EveMinimizeWindow
    !insertmacro EveWindowControlBody "minimize"
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveCloseWindow
    !insertmacro EveWindowControlBody "close"
  FunctionEnd
!else
  Function un.EveCloseWindow
    !insertmacro EveWindowControlBody "close"
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveClearPathError
    ${If} $EvePathError P<> 0
      ShowWindow $EvePathError ${SW_HIDE}
    ${EndIf}
  FunctionEnd

  Function EveShowPathError
    ${NSD_SetText} $EvePathError "$EveErrorText"
    ShowWindow $EvePathError ${SW_SHOW}
    System::Call 'user32::SetFocus(p $EvePathField)'
  FunctionEnd

  Function EveNormalizePath
    StrCpy $EvePathValid "0"
    StrCpy $0 "$INSTDIR"

    ${If} $0 == ""
      StrCpy $EveErrorText "请输入安装位置。"
      Return
    ${EndIf}

    System::Call 'shlwapi::PathIsRelativeW(w "$0") i .r5'
    ${If} $5 != 0
      StrCpy $EveErrorText "请输入完整的安装路径，而不是相对路径。"
      Return
    ${EndIf}

    System::Call 'shlwapi::PathIsUNCW(w "$0") i .r5'
    ${If} $5 != 0
      StrCpy $EveErrorText "安装位置不能使用网络共享路径。"
      Return
    ${EndIf}

    ; Do not let a path traversal segment silently resolve to another folder.
    System::Call 'shlwapi::StrStrW(w "$0", w "..") p .r5'
    ${If} $5 P<> 0
      StrCpy $EveErrorText "安装位置不能包含上级目录标记。"
      Return
    ${EndIf}

    ClearErrors
    ExpandEnvStrings $1 "$0"
    ${If} ${Errors}
      StrCpy $EveErrorText "安装位置包含无法展开的环境变量。"
      Return
    ${EndIf}

    System::Call 'kernel32::GetFullPathNameW(w "$1", i ${NSIS_MAX_STRLEN}, w .r2, p 0) i .r4'
    ${If} $4 == 0
      StrCpy $EveErrorText "安装位置无效，请选择具体文件夹。"
      Return
    ${EndIf}

    ${GetRoot} "$2" $3
    ${If} "$2" == "$3"
      StrCpy $EveErrorText "不能把 Eve 直接安装到磁盘根目录。"
      Return
    ${EndIf}

    StrLen $3 "$2"
    ${If} $3 > ${EVE_MAX_INSTALL_PATH}
      StrCpy $EveErrorText "安装路径过长，请选择更短的文件夹。"
      Return
    ${EndIf}

    ; The elevated instance consumes a path supplied through HKCU. Re-check
    ; the scope here so a tampered registry value cannot redirect a machine
    ; install outside Program Files.
    ${If} $EveInstallAllUsers == "1"
      StrCpy $4 "$PROGRAMFILES64\"
      System::Call 'shlwapi::PathIsPrefixW(w "$4", w "$2") i .r5'
      ${If} $5 == 0
        StrCpy $EveErrorText "所有用户安装位置必须位于 Program Files 文件夹内。"
        Return
      ${EndIf}
    ${EndIf}

    StrCpy $INSTDIR "$2"
    StrCpy $EvePathValid "1"
  FunctionEnd

  Function EveReadInstallPath
    ${NSD_GetText} $EvePathField $INSTDIR
    Call EveNormalizePath
    ${If} $EvePathValid == "1"
      Call EveClearPathError
    ${EndIf}
  FunctionEnd

  Function EveRefreshScope
    Call EveClearPathError
    ${If} $EveInstallAllUsers == "1"
      ShowWindow $EveScopeCurrentCheck ${SW_HIDE}
      ShowWindow $EveScopeAllCheck ${SW_SHOW}
      SetCtlColors $EveScopeCurrentTitle ${EVE_TEXT_SECONDARY} ${EVE_SURFACE}
      SetCtlColors $EveScopeCurrentDetail ${EVE_TEXT_TERTIARY} ${EVE_SURFACE}
      SetCtlColors $EveScopeAllTitle ${EVE_ACCENT} ${EVE_SURFACE}
      SetCtlColors $EveScopeAllDetail ${EVE_TEXT_SECONDARY} ${EVE_SURFACE}
    ${Else}
      ShowWindow $EveScopeCurrentCheck ${SW_SHOW}
      ShowWindow $EveScopeAllCheck ${SW_HIDE}
      SetCtlColors $EveScopeCurrentTitle ${EVE_ACCENT} ${EVE_SURFACE}
      SetCtlColors $EveScopeCurrentDetail ${EVE_TEXT_SECONDARY} ${EVE_SURFACE}
      SetCtlColors $EveScopeAllTitle ${EVE_TEXT_SECONDARY} ${EVE_SURFACE}
      SetCtlColors $EveScopeAllDetail ${EVE_TEXT_TERTIARY} ${EVE_SURFACE}
    ${EndIf}
    ${NSD_SetText} $EvePathField "$INSTDIR"
  FunctionEnd

  Function EveSelectCurrent
    Pop $0
    StrCpy $EveInstallAllUsers "0"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Eve"
    Call EveRefreshScope
  FunctionEnd

  Function EveSelectAllUsers
    Pop $0
    StrCpy $EveInstallAllUsers "1"
    StrCpy $INSTDIR "$PROGRAMFILES64\Eve"
    Call EveRefreshScope
  FunctionEnd

  Function EveWelcomeShow
    ; An elevated replacement instance resumes at the install page; the user
    ; already made the scope choice in the visible instance.
    ${If} $EveElevatedResume == "1"
      Abort
    ${EndIf}
    !insertmacro EveBeginPageBody "" "installerWelcome.bmp"

    !insertmacro EveRawStatic $R3 "安装 Eve" 64 82 450 38 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Segoe UI Variable Display" "24" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R4 "选择安装范围，然后确认安装位置。" 64 119 450 22 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "400" ${EVE_STATIC_LEFT}

    !insertmacro EveRawStatic $EveScopeCurrentTitle "仅为我" 82 162 170 21 $EveDialog ${EVE_ACCENT} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $EveScopeCurrentDetail "只在此账户可用" 82 187 174 18 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "9" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $EveScopeAllTitle "所有用户" 342 162 166 21 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $EveScopeAllDetail "安装到本机，所有账户可用" 342 187 166 18 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_SURFACE} "Microsoft YaHei UI" "9" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $EveScopeCurrentCheck "✓" 266 162 18 20 $EveDialog ${EVE_ACCENT} ${EVE_SURFACE} "Segoe UI Symbol" "11" "650" ${EVE_STATIC_CENTER}
    !insertmacro EveRawStatic $EveScopeAllCheck "✓" 526 162 18 20 $EveDialog ${EVE_ACCENT} ${EVE_SURFACE} "Segoe UI Symbol" "11" "650" ${EVE_STATIC_CENTER}
    ShowWindow $EveScopeAllCheck ${SW_HIDE}
    !insertmacro EveTransparentClickTarget $R0 64 151 232 70 $EveDialog EveSelectCurrent
    !insertmacro EveTransparentClickTarget $R1 324 151 232 70 $EveDialog EveSelectAllUsers

    !insertmacro EveRawStatic $R5 "安装位置" 64 238 180 18 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "10" "600" ${EVE_STATIC_LEFT}

    System::Call 'user32::CreateWindowExW(i 0, w "EDIT", w "$INSTDIR", i ${EVE_EDIT_STYLE}, i 68, i 260, i 424, i 36, p $EveDialog, p 0, p 0, p 0) p.r0'
    StrCpy $EvePathField $0
    SetCtlColors $EvePathField ${EVE_TEXT} ${EVE_INPUT}
    CreateFont $R8 "Microsoft YaHei UI" "10" "400"
    SendMessage $EvePathField ${WM_SETFONT} $R8 1
    SendMessage $EvePathField 0x00D3 0x0003 0x00080008

    !insertmacro EveTextButton $R6 "更改" 506 261 58 34 ${EVE_TEXT} ${EVE_SOFT} EveChangeFolder

    !insertmacro EveRawStatic $EvePathError "" 64 304 492 18 $EveDialog ${EVE_DANGER} ${EVE_SURFACE} "Microsoft YaHei UI" "10" "500" ${EVE_STATIC_LEFT}
    ShowWindow $EvePathError ${SW_HIDE}
    !insertmacro EveRawStatic $R8 "Eve ${VERSION}" 32 417 120 18 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_BG_BOTTOM} "Segoe UI Variable Text" "9" "400" ${EVE_STATIC_LEFT}

    !insertmacro EveTextButton $EveSecondary "取消" 332 346 106 40 ${EVE_TEXT} ${EVE_SURFACE} EveWelcomeCancel
    !insertmacro EveButton $EvePrimary "安装" 451 347 104 38 0xFFFFFF ${EVE_ACCENT} EveWelcomeInstall

    !insertmacro EveShowPageBody ""
  FunctionEnd

  !macro EveDeferredWelcomeLeave
    Function EveWelcomeLeave
      Call EveReadInstallPath
      ${If} $EvePathValid != "1"
        Call EveShowPathError
        Abort
      ${EndIf}
      StrCpy $EveSelectedInstallPath "$INSTDIR"
      ${If} $EveInstallAllUsers == "1"
        WriteRegStr HKCU "${EVE_INSTALL_STATE_KEY}" "Scope" "all"
        WriteRegStr HKCU "${EVE_INSTALL_STATE_KEY}" "Path" "$EveSelectedInstallPath"
        ShowWindow $HWNDPARENT ${SW_HIDE}
        !insertmacro UAC_RunElevated
        ${If} $0 == 0
          ${If} $1 == 1
            Quit
          ${ElseIf} $1 == 2
            DeleteRegKey HKCU "${EVE_INSTALL_STATE_KEY}"
            ShowWindow $HWNDPARENT ${SW_SHOW}
            BringToFront
            Return
          ${ElseIf} $1 == 3
            !insertmacro UAC_RunElevated
            ${If} $0 == 0
            ${AndIf} $1 == 1
              Quit
            ${EndIf}
          ${EndIf}
        ${EndIf}
        DeleteRegKey HKCU "${EVE_INSTALL_STATE_KEY}"
        ShowWindow $HWNDPARENT ${SW_SHOW}
        BringToFront
        StrCpy $EveErrorText "系统确认未完成，安装尚未开始。"
        Call EveShowPathError
        Abort
      ${EndIf}
      DeleteRegKey HKCU "${EVE_INSTALL_STATE_KEY}"
    FunctionEnd
  !macroend

  Function EveChangeFolder
    Pop $0
    ${NSD_GetText} $EvePathField $0
    ${If} $0 == ""
      ${If} $EveInstallAllUsers == "1"
        StrCpy $0 "$PROGRAMFILES64\Eve"
      ${Else}
        StrCpy $0 "$LOCALAPPDATA\Programs\Eve"
      ${EndIf}
    ${EndIf}
    nsDialogs::SelectFolderDialog "选择 Eve 安装位置" "$0"
    Pop $1
    ${If} $1 != "error"
    ${AndIf} $1 != ""
      ${NSD_SetText} $EvePathField "$1"
      Call EveClearPathError
    ${EndIf}
  FunctionEnd

  Function EveWelcomeInstall
    Pop $0
    Call EveReadInstallPath
    ${If} $EvePathValid == "1"
      !insertmacro EvePostNextBody
    ${Else}
      Call EveShowPathError
    ${EndIf}
  FunctionEnd

  Function EveWelcomeCancel
    Pop $0
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0) i .r1'
  FunctionEnd

  Function EveInstFilesShow
    !insertmacro EveProgressBody "" "install"
  FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
  Function un.EveUninstFilesShow
    !insertmacro EveProgressBody "un." "uninstall"
  FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
  Function EveFinishShow
    !insertmacro EveBeginPageBody "" "installerFinish.bmp"
    StrCpy $EveLaunchOnFinish "1"

    !insertmacro EveRawStatic $R3 "安装完成" 128 92 400 38 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Segoe UI Variable Display" "24" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R4 "Eve 已安装到本机。" 128 136 400 24 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R5 "安装位置" 80 222 180 18 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_BG} "Microsoft YaHei UI" "9" "500" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R6 "$INSTDIR" 80 246 456 22 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Segoe UI Variable Text" "10" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R7 "Eve ${VERSION}" 32 417 120 18 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_BG_BOTTOM} "Segoe UI Variable Text" "9" "400" ${EVE_STATIC_LEFT}

    !insertmacro EveTextButton $EveSecondary "完成" 332 346 106 40 ${EVE_TEXT} ${EVE_SURFACE} EveFinishClose
    !insertmacro EveButton $EvePrimary "打开 Eve" 451 347 104 38 0xFFFFFF ${EVE_ACCENT} EveFinishOpen

    !insertmacro EveShowPageBody ""
  FunctionEnd

  Function EveFinishOpen
    Pop $0
    StrCpy $EveLaunchOnFinish "1"
    !insertmacro EvePostNextBody
  FunctionEnd

  Function EveFinishClose
    Pop $0
    StrCpy $EveLaunchOnFinish "0"
    !insertmacro EvePostNextBody
  FunctionEnd

  Function EveFinishLeave
    ${If} $EveLaunchOnFinish == "1"
      SetOutPath "$INSTDIR"
      ExecShell "open" "$INSTDIR\Eve.exe"
    ${EndIf}
  FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
  Function un.EveUninstallShow
    !insertmacro EveBeginPageBody "un." "installerUninstall.bmp"

    !insertmacro EveRawStatic $R3 "卸载 Eve" 64 90 450 38 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Segoe UI Variable Display" "24" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R4 "移除应用，保留科研资料。" 64 132 450 24 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R5 "会保留" 80 193 180 18 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Microsoft YaHei UI" "10" "600" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R6 "科研项目与数据 · 技能与记忆 · 设置与偏好" 80 223 448 20 $EveDialog ${EVE_TEXT} ${EVE_BG} "Microsoft YaHei UI" "10" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R7 "当前安装位置" 80 253 180 16 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_BG} "Microsoft YaHei UI" "9" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R9 "$INSTDIR" 80 274 448 16 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_BG} "Segoe UI Variable Text" "9" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R8 "Eve ${VERSION}" 32 417 120 18 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_BG_BOTTOM} "Segoe UI Variable Text" "9" "400" ${EVE_STATIC_LEFT}

    !insertmacro EveTextButton $EveSecondary "取消" 332 346 106 40 ${EVE_TEXT} ${EVE_SURFACE} un.EveUninstallCancel
    !insertmacro EveButton $EvePrimary "卸载" 451 347 104 38 0xFFFFFF ${EVE_ACCENT} un.EveUninstallStart

    !insertmacro EveShowPageBody "un."
  FunctionEnd

  Function un.EveUninstallLeave
  FunctionEnd

  Function un.EveUninstallStart
    Pop $0
    !insertmacro EvePostNextBody
  FunctionEnd

  Function un.EveUninstallCancel
    Pop $0
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0) i .r1'
  FunctionEnd

  Function un.EveUninstallFinishShow
    !insertmacro EveBeginPageBody "un." "installerUninstallFinish.bmp"

    !insertmacro EveRawStatic $R3 "卸载完成" 128 92 400 38 $EveDialog ${EVE_TEXT} ${EVE_SURFACE} "Segoe UI Variable Display" "24" "650" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R4 "Eve 已从本机移除。" 128 136 400 24 $EveDialog ${EVE_TEXT_SECONDARY} ${EVE_SURFACE} "Microsoft YaHei UI" "11" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R5 "科研项目、技能、记忆和设置均已保留。" 128 188 400 24 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_SURFACE} "Microsoft YaHei UI" "10" "400" ${EVE_STATIC_LEFT}
    !insertmacro EveRawStatic $R6 "Eve ${VERSION}" 32 417 120 18 $EveDialog ${EVE_TEXT_TERTIARY} ${EVE_BG_BOTTOM} "Segoe UI Variable Text" "9" "400" ${EVE_STATIC_LEFT}

    !insertmacro EveButton $EvePrimary "完成" 451 347 104 38 0xFFFFFF ${EVE_ACCENT} un.EveUninstallFinish

    !insertmacro EveShowPageBody "un."
  FunctionEnd

  Function un.EveUninstallFinish
    Pop $0
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0) i .r1'
    SetErrorLevel 0
    Quit
  FunctionEnd

  Function un.EveUninstallFinishLeave
    ; The electron-builder template always appends its native finish page after
    ; the custom uninstall page. Quit here so users never see that second wizard.
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0) i .r1'
    SetErrorLevel 0
    Quit
  FunctionEnd
!endif

!macro customInit
  ${If} ${UAC_IsInnerInstance}
    ReadRegStr $EveInstallAllUsers HKCU "${EVE_INSTALL_STATE_KEY}" "Scope"
    ReadRegStr $EveSelectedInstallPath HKCU "${EVE_INSTALL_STATE_KEY}" "Path"
    StrCpy $EveElevatedResume "1"
    DeleteRegKey HKCU "${EVE_INSTALL_STATE_KEY}"
    ${If} $EveInstallAllUsers == "all"
      StrCpy $EveInstallAllUsers "1"
      !insertmacro setInstallModePerAllUsers
      ${If} "$EveSelectedInstallPath" != ""
        StrCpy $INSTDIR "$EveSelectedInstallPath"
        Call EveNormalizePath
        ${If} $EvePathValid != "1"
          ; Fail closed rather than honoring an untrusted elevated path.
          StrCpy $INSTDIR "$PROGRAMFILES64\Eve"
          StrCpy $EveSelectedInstallPath "$INSTDIR"
          StrCpy $EvePathValid "1"
        ${EndIf}
      ${EndIf}
    ${Else}
      StrCpy $EveInstallAllUsers "0"
      !insertmacro setInstallModePerUser
    ${EndIf}
  ${Else}
    DeleteRegKey HKCU "${EVE_INSTALL_STATE_KEY}"
    StrCpy $EveElevatedResume "0"
    StrCpy $EveInstallAllUsers "0"
    !insertmacro setInstallModePerUser
  ${EndIf}
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${If} $EveInstallAllUsers == "1"
      StrCpy $isForceCurrentInstall "0"
      StrCpy $isForceMachineInstall "1"
      !insertmacro setInstallModePerAllUsers
    ${Else}
      StrCpy $isForceMachineInstall "0"
      StrCpy $isForceCurrentInstall "1"
      !insertmacro setInstallModePerUser
    ${EndIf}
    ${If} "$EveSelectedInstallPath" != ""
      StrCpy $INSTDIR "$EveSelectedInstallPath"
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInstall
    !insertmacro EveHideChromeBody
    !insertmacro EvePostNextBody
    DeleteRegKey HKCU "${EVE_INSTALL_STATE_KEY}"
  !macroend
!else
  !macro customUnInstall
    !insertmacro EveHideChromeBody
    !insertmacro EvePostNextBody
  !macroend
!endif

!macro customWelcomePage
  Page custom EveWelcomeShow EveWelcomeLeave
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro EveDeferredWelcomeLeave
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  ; This hook runs immediately before MUI_PAGE_INSTFILES. Defining the callback
  ; here prevents the install-mode page from consuming it first.
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW EveInstFilesShow
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
  !macro customFinishPage
    Page custom EveFinishShow EveFinishLeave
  !macroend
!endif

!macro customUnWelcomePage
  UninstPage custom un.EveUninstallShow un.EveUninstallLeave
!macroend

!macro customUninstallPage
  UninstPage custom un.EveUninstallFinishShow un.EveUninstallFinishLeave
!macroend
