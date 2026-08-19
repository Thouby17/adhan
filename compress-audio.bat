@echo off
REM ====================================================================
REM Optionnel : re-encoder l'adhan.mp3 en mono 96 kbps pour gagner ~3 MB
REM Nécessite ffmpeg dans le PATH (https://ffmpeg.org/download.html)
REM ====================================================================

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo ffmpeg n'est pas installe. Installer via : winget install ffmpeg
  exit /b 1
)

echo Sauvegarde de l'original...
if not exist "src\app\audio\adhan-original.mp3" (
  copy "src\app\audio\adhan.mp3" "src\app\audio\adhan-original.mp3" >nul
)

echo Re-encodage en mono 96 kbps...
ffmpeg -y -i "src\app\audio\adhan-original.mp3" -ac 1 -b:a 96k -ar 44100 "src\app\audio\adhan.mp3"

echo.
echo Tailles :
for %%F in ("src\app\audio\adhan-original.mp3" "src\app\audio\adhan.mp3") do echo   %%~nxF : %%~zF octets
echo.
echo OK. Re-package : ares-package src\app src\service
