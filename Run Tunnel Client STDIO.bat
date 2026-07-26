@echo off
setlocal
title OpenAI Tunnel Client - STDIO MCP

REM Run from the folder where this BAT file lives.
pushd "%~dp0" || (
  echo Failed to enter BAT folder.
  pause
  exit /b 1
)

echo.
echo === OpenAI Tunnel Client - STDIO MCP ===
echo.
echo This launches the local MCP server through STDIO instead of HTTP.
echo You do not need to start a separate HTTP file server for this mode.
echo.

set "KEYS_FILE=%~dp0keys.bat"
set "CONTROL_PLANE_API_KEY="
set "CONTROL_PLANE_TUNNEL_ID="
set "MCP_LOCAL_TOKEN="
set "TUNNEL_CLIENT=%~dp0tunnel-client.exe"
set "START_TUNNEL=%~dp0start-tunnel.exe"

if exist "%KEYS_FILE%" (
  call "%KEYS_FILE%"
  echo Loaded saved local credentials from keys.bat.
  echo.
)

if "%CONTROL_PLANE_API_KEY%"=="" set /P "CONTROL_PLANE_API_KEY=Enter OpenAI API key: "
if "%CONTROL_PLANE_TUNNEL_ID%"=="" set /P "CONTROL_PLANE_TUNNEL_ID=Enter tunnel id: "

if "%CONTROL_PLANE_API_KEY%"=="" (
  echo OpenAI API key is required.
  pause
  exit /b 1
)

if "%CONTROL_PLANE_TUNNEL_ID%"=="" (
  echo Tunnel id is required.
  pause
  exit /b 1
)

if not exist "dist\src\stdio.js" (
  echo Build output is missing. Installing dependencies and building...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
  call npm run build
  if errorlevel 1 (
    echo npm run build failed.
    pause
    exit /b 1
  )
)

if not exist "%TUNNEL_CLIENT%" (
  if exist "%START_TUNNEL%" (
    echo Found start-tunnel.exe. Copying it to tunnel-client.exe for this script...
    copy /Y "%START_TUNNEL%" "%TUNNEL_CLIENT%" >nul
    if errorlevel 1 (
      echo Failed to copy start-tunnel.exe to tunnel-client.exe.
      pause
      exit /b 1
    )
  ) else (
    echo tunnel-client.exe was not found.
    echo Download start-tunnel.exe from:
    echo https://github.com/openai/tunnel-client/releases
    echo Then put it in this folder and run this file again.
    pause
    exit /b 1
  )
)

echo @echo off>"%KEYS_FILE%"
echo REM Saved local credentials. Do not commit this file.>>"%KEYS_FILE%"
if not "%MCP_LOCAL_TOKEN%"=="" echo set "MCP_LOCAL_TOKEN=%MCP_LOCAL_TOKEN%">>"%KEYS_FILE%"
echo set "CONTROL_PLANE_API_KEY=%CONTROL_PLANE_API_KEY%">>"%KEYS_FILE%"
echo set "CONTROL_PLANE_TUNNEL_ID=%CONTROL_PLANE_TUNNEL_ID%">>"%KEYS_FILE%"

echo Starting tunnel client with STDIO MCP command:
echo node dist/src/stdio.js
echo.
"%TUNNEL_CLIENT%" run --control-plane.api-key "env:CONTROL_PLANE_API_KEY" --control-plane.tunnel-id "%CONTROL_PLANE_TUNNEL_ID%" --mcp.command "command=node dist/src/stdio.js,channel=main"

echo.
echo Tunnel client exited with code %ERRORLEVEL%.
pause
popd
endlocal
