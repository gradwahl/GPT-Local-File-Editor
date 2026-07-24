@echo off
setlocal
title OpenAI Tunnel Client

REM Run from the folder where this BAT file lives.
pushd "%~dp0"

echo.
echo === OpenAI Tunnel Client ===
echo.
set "CONTROL_PLANE_API_KEY="
set "CONTROL_PLANE_TUNNEL_ID="
set /P "CONTROL_PLANE_API_KEY=Enter OpenAI API key: "
set /P "CONTROL_PLANE_TUNNEL_ID=Enter tunnel id: "
set "MCP_SERVER_URL=http://127.0.0.1:3333/mcp"

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

echo MCP_SERVER_URL=%MCP_SERVER_URL%
echo Starting tunnel client...
echo.
.\tunnel-client.exe run

echo.
echo Tunnel client exited with code %ERRORLEVEL%.
pause
popd
endlocal
