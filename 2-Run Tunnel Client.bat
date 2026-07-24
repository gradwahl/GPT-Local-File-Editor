@echo off
setlocal
title OpenAI Tunnel Client

REM Run from the folder where this BAT file lives.
pushd "%~dp0"

echo.
echo === OpenAI Tunnel Client ===
echo.
set "KEYS_FILE=%~dp0keys.bat"
set "CONTROL_PLANE_API_KEY="
set "CONTROL_PLANE_TUNNEL_ID="
set "MCP_LOCAL_TOKEN="

if exist "%KEYS_FILE%" (
  call "%KEYS_FILE%"
  echo Loaded saved local credentials from keys.bat.
  echo.
)

if "%CONTROL_PLANE_API_KEY%"=="" set /P "CONTROL_PLANE_API_KEY=Enter OpenAI API key: "
if "%CONTROL_PLANE_TUNNEL_ID%"=="" set /P "CONTROL_PLANE_TUNNEL_ID=Enter tunnel id: "
if "%MCP_LOCAL_TOKEN%"=="" set /P "MCP_LOCAL_TOKEN=Enter MCP local token (same as file server): "

set "MCP_SERVER_URL=http://127.0.0.1:3333/mcp"
set "MCP_EXTRA_HEADERS=Authorization: Bearer %MCP_LOCAL_TOKEN%"

if "%MCP_LOCAL_TOKEN%"=="" (
  echo MCP local token is required.
  pause
  exit /b 1
)

set "MCP_EXTRA_HEADERS=Authorization: Bearer %MCP_LOCAL_TOKEN%"
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

echo @echo off>"%KEYS_FILE%"
echo REM Saved local credentials. Do not commit this file.>>"%KEYS_FILE%"
echo set "MCP_LOCAL_TOKEN=%MCP_LOCAL_TOKEN%">>"%KEYS_FILE%"
echo set "CONTROL_PLANE_API_KEY=%CONTROL_PLANE_API_KEY%">>"%KEYS_FILE%"
echo set "CONTROL_PLANE_TUNNEL_ID=%CONTROL_PLANE_TUNNEL_ID%">>"%KEYS_FILE%"

echo MCP_SERVER_URL=%MCP_SERVER_URL%
echo Starting tunnel client...
echo.
.\tunnel-client.exe run --mcp.extra-headers "Authorization: Bearer %MCP_LOCAL_TOKEN%"

echo.
echo Tunnel client exited with code %ERRORLEVEL%.
pause
popd
endlocal
