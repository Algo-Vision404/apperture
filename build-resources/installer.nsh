; Custom NSIS steps for apperture.
; Every install must ship Uninstall apperture.exe and register it with Windows.

!macro customInstall
  ; Abort if the uninstaller was not copied into the install folder.
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" apperture_uninstall_ok 0
    MessageBox MB_OK|MB_ICONSTOP "Installation did not complete: the uninstaller file is missing. Download a fresh copy of apperture-win-x64.exe and try again."
    Abort

  apperture_uninstall_ok:
  ; Start-menu entry so users can uninstall without opening Settings.
  !ifdef MENU_FILENAME
    CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
    StrCpy $R9 "$SMPROGRAMS\${MENU_FILENAME}\Uninstall ${PRODUCT_NAME}.lnk"
  !else
    StrCpy $R9 "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
  !endif

  ${if} $installMode == "all"
    StrCpy $R8 "/allusers"
  ${else}
    StrCpy $R8 "/currentuser"
  ${endif}

  CreateShortCut "$R9" "$INSTDIR\${UNINSTALL_FILENAME}" "$R8"
  ClearErrors
!macroend
