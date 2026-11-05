@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 22.17.1 or newer, then run this file again.
  goto failed
)
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&(b>17||(b===17&&c>=1)))?0:1)"
if errorlevel 1 (
  echo Node.js 22.17.1 or newer is required.
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm is missing. Reinstall Node.js with npm enabled.
  goto failed
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  if errorlevel 1 goto failed
  echo Created .env from .env.example.
)
if not exist "node_modules\.package-lock.json" (
  echo Installing dependencies...
  call npm.cmd ci
  if errorlevel 1 goto failed
)

echo Starting Checkout Lab. Open the URL printed below.
echo Press Ctrl+C to stop the launcher and services.
call npm.cmd run dev
set "lab_exit=%errorlevel%"
if not "%lab_exit%"=="0" goto failed
popd
exit /b 0

:failed
echo.
echo Startup failed. Check the error above. Existing data and .env are kept.
pause
popd
exit /b 1
