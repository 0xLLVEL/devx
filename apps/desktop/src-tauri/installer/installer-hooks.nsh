; DevX NSIS installer hooks.
;
; Bundled via `bundle.windows.nsis.installerHooks`. The Tauri NSIS template
; defines these macro names and calls them at the marked points; everything
; here runs inside that script.
;
; Design notes:
;
; * The helper (`devx-helper.exe`) must run as LocalSystem, so the installer
;   creates the Windows service. Service mutations need admin, which the
;   perMachine install mode asserts.
; * `sc.exe` is used on purpose: it ships with every Windows install, so the
;   installer needs no extra plugin.
; * The CLI directory is prepended to the *user* PATH (HKCU\Environment) and
;   only when absent, so reinstalling does not grow the value. A WM_SETTINGCHANGE
;   broadcast lets new shells see the change without a reboot.
; * Every mutation degrades to a DetailPrint on failure instead of aborting an
;   otherwise successful install.

!include "StrFunc.nsh"

; String helpers used below; the `Un` variants are the uninstaller copies.
${StrStr}
${StrTok}
${UnStrStr}
${UnStrTok}

!macro _DevXLog message
  DetailPrint "DevX: ${message}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Stop and delete any previous helper service so the service control manager
  ; does not pin the old binary while files are being replaced.
  nsExec::ExecToLog 'sc.exe stop "DevXHelper"'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete "DevXHelper"'
  Pop $0
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; --- Privileged helper service -------------------------------------------
  ; LocalSystem, own process, on-demand start: the desktop app starts it when
  ; it needs elevation and stops it when done.
  nsExec::ExecToLog 'sc.exe create "DevXHelper" binPath= "\"$INSTDIR\devx-helper.exe\"" start= demand DisplayName= "DevX Privileged Helper"'
  Pop $0
  ${If} $0 == 0
    nsExec::ExecToLog 'sc.exe description "DevXHelper" "Performs elevated operations (hosts file, certificate store, NRPT) for DevX."'
    Pop $0
    !insertmacro _DevXLog "DevXHelper service installed"
  ${Else}
    !insertmacro _DevXLog "WARNING: could not install the DevXHelper service (error $0)"
  ${EndIf}

  ; --- CLI on PATH ----------------------------------------------------------
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 "$0" "$INSTDIR"
  ${If} $1 == ""
    ${If} $0 == ""
      WriteRegStr HKCU "Environment" "Path" "$INSTDIR"
    ${Else}
      WriteRegStr HKCU "Environment" "Path" "$INSTDIR;$0"
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
    !insertmacro _DevXLog "CLI added to PATH"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The helper must be stopped and deregistered before its files disappear.
  nsExec::ExecToLog 'sc.exe stop "DevXHelper"'
  Pop $0
  Sleep 1500
  nsExec::ExecToLog 'sc.exe delete "DevXHelper"'
  Pop $0
  ${If} $0 == 0
    !insertmacro _DevXLog "DevXHelper service removed"
  ${Else}
    !insertmacro _DevXLog "WARNING: could not remove the DevXHelper service (error $0)"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove the CLI entry from the user PATH, leaving everything else intact.
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrStr} $1 "$0" "$INSTDIR"
  ${If} $1 != ""
    StrCpy $2 "" ; rebuilt PATH
    StrCpy $3 "0" ; token index
    StrCpy $4 "$0"
  devx_path_loop:
    IntOp $3 $3 + 1
    ${UnStrTok} $5 "$4" ";" "$3" "0"
    ${If} $5 == ""
      Goto devx_path_done
    ${EndIf}
    ${If} $5 != "$INSTDIR"
      ${If} $2 == ""
        StrCpy $2 "$5"
      ${Else}
        StrCpy $2 "$2;$5"
      ${EndIf}
    ${EndIf}
    Goto devx_path_loop
  devx_path_done:
    WriteRegStr HKCU "Environment" "Path" "$2"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
    !insertmacro _DevXLog "CLI removed from PATH"
  ${EndIf}
!macroend
