@echo off
chcp 65001 >nul
rem ============================================================
rem  Launch the street-corner diorama (miniature war-torn scene)
rem  Double-click this file. It starts the local dev server if
rem  needed, then opens http://127.0.0.1:4175/
rem ============================================================
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\launch-diorama.ps1"
if errorlevel 1 (
  echo.
  echo Launch failed. See tools\launch-diorama.log for details.
  pause
)
endlocal
