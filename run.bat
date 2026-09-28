@echo off
REM ===========================================================================
REM  PRINTKIOSK - one command to run everything on Windows
REM
REM    run.bat                              real printing, default printer
REM    run.bat --printer "Canon MF240"
REM    run.bat --upi you@okhdfcbank
REM    run.bat --sim                        no printer; simulate (opt-in)
REM
REM  Prints for real by default. Stops with instructions if no printer is
REM  found, rather than quietly simulating and looking like it worked.
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if "%PORT%"=="" set PORT=8080
set PRINTER=
set UPI=
set SIMFLAG=

:parse
if "%~1"=="" goto done
if /I "%~1"=="--printer" ( set "PRINTER=%~2" & shift & shift & goto parse )
if /I "%~1"=="--upi"     ( set "UPI=%~2"     & shift & shift & goto parse )
if /I "%~1"=="--port"    ( set "PORT=%~2"    & shift & shift & goto parse )
if /I "%~1"=="--sim"     ( set "SIMFLAG=1"   & shift & goto parse )
echo Unknown option: %~1
exit /b 1
:done

echo.
echo ==^> Checking dependencies

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Node.js is not installed.
  echo    Install it with:  winget install OpenJS.NodeJS.LTS
  echo    then close this window, open a new one, and run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODEVER=%%v
echo     node !NODEVER!
echo     npm packages: none required

REM ---------------------------------------------------------------- printer
if "%SIMFLAG%"=="1" (
  set PRINTER_DRIVER=mock
  echo     driver: mock ^(simulation - no paper will move^)
  goto printerdone
)

echo.
echo ==^> Checking the printer

if "%PRINTER%"=="" (
  for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Printer | Where-Object Default -eq $true).Name" 2^>nul`) do set "PRINTER=%%p"
)
if "!PRINTER!"=="" (
  for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "(Get-Printer | Select-Object -First 1).Name" 2^>nul`) do set "PRINTER=%%p"
  if not "!PRINTER!"=="" echo     no default printer set - using the first one found
)

if "!PRINTER!"=="" (
  echo.
  echo ERROR: no printer is set up, so nothing can print.
  echo.
  echo    Add one:  Settings -^> Bluetooth ^& devices -^> Printers ^& scanners
  echo              ^(plug the printer in and switch it on first^)
  echo    Check:    powershell Get-Printer
  echo.
  echo    To run without a printer anyway:   run.bat --sim
  echo.
  pause
  exit /b 1
)

set "PRINTER_NAME=!PRINTER!"
set PRINTER_DRIVER=windows
echo     printer: !PRINTER!

REM Windows cannot print a PDF silently without a helper.
set SUMATRA=
where SumatraPDF.exe >nul 2>&1
if not errorlevel 1 set SUMATRA=1
if exist "%LOCALAPPDATA%\SumatraPDF\SumatraPDF.exe" set SUMATRA=1
if exist "C:\Program Files\SumatraPDF\SumatraPDF.exe" set SUMATRA=1

if not defined SUMATRA (
  echo.
  echo     WARNING: SumatraPDF is not installed.
  echo     Windows has no built-in way to print a PDF from the command line,
  echo     so jobs will fall back to the shell print verb and may open a dialog.
  echo.
  echo        winget install SumatraPDF.SumatraPDF
  echo.
  echo     On the Raspberry Pi this does not apply - CUPS prints directly.
  echo.
) else (
  echo     sumatrapdf: found ^(silent printing enabled^)
)

:printerdone

if not "%UPI%"=="" (
  set "UPI_VPA=%UPI%"
  if "%PAYMENT_MODE%"=="" set PAYMENT_MODE=upi_manual
  echo     upi: %UPI%
)

REM ------------------------------------------------------------------ start
echo.
echo ==^> Starting PrintKiosk on port %PORT%
start "PrintKiosk agent" /min cmd /c "node server.js & pause"

echo     waiting for the agent...
set READY=
for /L %%i in (1,1,40) do (
  if not defined READY (
    powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set READY=1
    if not defined READY powershell -NoProfile -Command "Start-Sleep -Milliseconds 500" >nul
  )
)

if not defined READY (
  echo.
  echo ERROR: the agent did not start. Check the "PrintKiosk agent" window.
  echo.
  pause
  exit /b 1
)

echo     agent is up
echo.
echo ==^> Opening the dashboard
start "" "http://localhost:%PORT%/admin"

echo.
echo     Kiosk screen : http://localhost:%PORT%/
echo     Upload page  : http://localhost:%PORT%/upload
echo     Dashboard    : http://localhost:%PORT%/admin
echo.
if not "%SIMFLAG%"=="1" (
  echo     Printer not behaving? In another terminal:
  echo       node scripts/testprint.js --printer "!PRINTER!"
  echo.
)
echo     Close the "PrintKiosk agent" window to stop.
echo.
pause
