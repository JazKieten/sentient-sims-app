@echo off
setlocal EnableDelayedExpansion
REM ---------------------------------------------------------------------------
REM One-command memory cleanup for a Sentient Sims save database (Windows).
REM
REM   1. Close the Sentient Sims app AND The Sims 4.
REM   2. Double-click this file (keep repair-memories.cjs next to it).
REM
REM It finds the installed app, finds the newest save DB in your Mods folder, backs the
REM DB up next to itself (<name>.db.pre-repair.<timestamp>.bak, plus -wal/-shm), and then removes
REM refusal rows ("I can't help with that."), leaked prompt scaffolding, 'article'
REM prefixes, exact duplicates and orphan links. Pass --dry-run to only print the plan.
REM Pass --db "<path>" to pick a specific database.
REM ---------------------------------------------------------------------------

set "SCRIPT=%~dp0repair-memories.cjs"
if not exist "%SCRIPT%" (
  echo Could not find repair-memories.cjs next to this file.
  goto :fail
)

REM --- refuse to run while the app or the game is open (the DB is locked / in WAL) ---
tasklist /FI "IMAGENAME eq SentientSims.exe" 2>NUL | find /I "SentientSims.exe" >NUL
if not errorlevel 1 (
  echo The Sentient Sims app is running. Close it first, then run this again.
  goto :fail
)
tasklist /FI "IMAGENAME eq TS4_x64.exe" 2>NUL | find /I "TS4_x64.exe" >NUL
if not errorlevel 1 (
  echo The Sims 4 is running. Close it first, then run this again.
  goto :fail
)

REM --- locate the installed app (electron-builder per-user install, then per-machine) ---
set "EXE=%LOCALAPPDATA%\Programs\SentientSims\SentientSims.exe"
if not exist "%EXE%" set "EXE=%ProgramFiles%\SentientSims\SentientSims.exe"
if not exist "%EXE%" (
  echo Could not find SentientSims.exe. Is the Sentient Sims app installed?
  goto :fail
)
set "NODE_PATH=%EXE%\..\resources\app.asar\node_modules"

REM --- parse args: --db <path> and --dry-run; everything else is passed through ---
set "DB="
set "MODE=--apply"
set "EXTRA="
:parse
if "%~1"=="" goto :parsed
if /I "%~1"=="--db" (
  set "DB=%~2"
  shift
  shift
  goto :parse
)
if /I "%~1"=="--dry-run" (
  set "MODE="
  shift
  goto :parse
)
set "EXTRA=!EXTRA! %1"
shift
goto :parse
:parsed

REM --- newest *-sentient-sims.db in the Mods folder (Documents may live on OneDrive) ---
if "%DB%"=="" (
  for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('MyDocuments')"`) do set "DOCS=%%D"
  set "MODS=!DOCS!\Electronic Arts\The Sims 4\Mods\sentient-sims"
  for /f "usebackq delims=" %%F in (`dir /b /o-d "!MODS!\*-sentient-sims.db" 2^>NUL`) do (
    if "!DB!"=="" set "DB=!MODS!\%%F"
  )
)
if "%DB%"=="" (
  echo Could not find a *-sentient-sims.db under your Mods\sentient-sims folder.
  echo Run again with:  repair-memories.cmd --db "C:\path\to\your-sentient-sims.db"
  goto :fail
)

echo.
echo Database: %DB%
if "%MODE%"=="" (echo Mode: DRY RUN ^(nothing will be written^)) else (echo Mode: APPLY ^(a backup is written first^))
echo.

set ELECTRON_RUN_AS_NODE=1
"%EXE%" "%SCRIPT%" --db "%DB%" %MODE% %EXTRA%
if errorlevel 1 goto :fail

echo.
echo Done. Your backup is next to the database ^(*.pre-repair.*.bak^) if you ever want to undo this.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
