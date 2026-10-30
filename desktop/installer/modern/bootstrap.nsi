Unicode true
!include "FileFunc.nsh"
!include "LogicLib.nsh"
Name "Eve"
Caption "安装 Eve"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SilentInstall normal
AutoCloseWindow true
SetCompress off
InstallDir "$LOCALAPPDATA\Programs\Eve"
Icon "${ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "Eve"
VIAddVersionKey /LANG=2052 "FileDescription" "Eve 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Eve contributors"

Function .onInit
  ; The public executable only hosts the custom UI. The existing NSIS
  ; package performs installation in silent mode and preserves its exit code.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=EveInstaller.exe "${FRONTEND}"
  File /oname=EveEngine.exe "${ENGINE}"
  ${GetParameters} $R0
  StrCpy $R3 "$INSTDIR"
  ${GetOptions} $R0 "/allusers" $R2
  ${IfNot} ${Errors}
    ${If} $R3 == "$LOCALAPPDATA\Programs\Eve"
      StrCpy $R3 "$PROGRAMFILES64\Eve"
    ${EndIf}
  ${Else}
    ${GetOptions} $R0 "/currentuser" $R2
    ${If} ${Errors}
      StrCpy $R0 "$R0 /currentuser"
    ${EndIf}
  ${EndIf}
  IfSilent silent interactive
  silent:
    ; NSIS consumes /D before .onInit, so forward the resolved directory to
    ; the embedded installer explicitly.
    ExecWait '"$PLUGINSDIR\EveEngine.exe" $R0 /D=$R3' $R1
    Goto done
  interactive:
    ExecWait '"$PLUGINSDIR\EveInstaller.exe" --payload "$PLUGINSDIR\EveEngine.exe" --version "${VERSION}" --build "${BUILD_ID}"' $R1
  done:
    ${If} ${Errors}
      StrCpy $R1 1
    ${EndIf}
    SetErrorLevel $R1
    Quit
FunctionEnd

Section
SectionEnd
