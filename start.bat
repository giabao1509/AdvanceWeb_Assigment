@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 exit /b 1

echo [1/6] Checking Node.js, npm and Docker...
where node.exe >nul 2>&1
if errorlevel 1 goto missing_node
node.exe -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22 || (major===22 && minor<17)) process.exit(1)"
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_node
rem Use the Windows certificate store without disabling TLS verification.
set "NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca"
where docker >nul 2>&1
if errorlevel 1 goto missing_docker
call docker compose version >nul 2>&1
if errorlevel 1 goto missing_docker
call docker info >nul 2>&1
if errorlevel 1 goto missing_docker

echo [2/6] Preparing .env...
if exist ".env" goto env_ready
copy /y ".env.example" ".env" >nul
if errorlevel 1 goto failed
echo Created .env from .env.example.
:env_ready

echo [3/6] Installing dependencies from package-lock.json...
call npm.cmd ci --no-audit --no-fund
if errorlevel 1 goto failed

echo [4/6] Starting OpenFGA and waiting for its health check...
call docker compose up -d --wait
if errorlevel 1 goto failed

echo [5/6] Initializing or synchronizing authorization data...
call npm.cmd run fga:init
if errorlevel 1 goto failed

echo [6/6] Starting the web app. Keep this window open.
echo Open the URL printed below. Press Ctrl+C to stop the web app.
call npm.cmd start
if errorlevel 1 goto failed
popd
exit /b 0

:missing_node
echo ERROR: Install Node.js 22.17 or newer, including npm, then run start.bat again.
goto failed

:missing_docker
echo ERROR: Install Docker Desktop with Compose and start its Linux engine.
echo Check that docker info and docker compose version work, then run start.bat again.
goto failed

:failed
echo.
echo Startup stopped. Read the error above, fix it, then run start.bat again.
echo Existing .env and application data are preserved. Docker may still be running.
pause
popd
exit /b 1
