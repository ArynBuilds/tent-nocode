; The NSIS include: the uninstaller is data-blind - it never touches userData, and the
; closing message says exactly that. Skipped when silent (/S must never block).

!macro customUnInstall
  IfSilent +2 0
  MessageBox MB_ICONINFORMATION|MB_OK "Your data stays on this computer. Nodeloom only removed the app."
!macroend
