@echo off
setlocal
title MCP File Server

REM Run from the folder where this BAT file lives.
pushd "%~dp0" || (
  echo Failed to enter BAT folder.
  pause
  exit /b 1
)

echo.
echo === MCP File Server ===
echo.

set "KEYS_FILE=%~dp0keys.bat"
set "MCP_LOCAL_TOKEN="
set "CONTROL_PLANE_API_KEY="
set "CONTROL_PLANE_TUNNEL_ID="

if exist "%KEYS_FILE%" (
  call "%KEYS_FILE%"
  echo Loaded saved local credentials from keys.bat.
  echo.
)

set "DEFAULT_WORKSPACE=%USERPROFILE%\ChatGPT-editable"
set "WORKSPACE_ROOT="
set /P "WORKSPACE_ROOT=Enter WORKSPACE_ROOT folder [%DEFAULT_WORKSPACE%]: "

if "%WORKSPACE_ROOT%"=="" set "WORKSPACE_ROOT=%DEFAULT_WORKSPACE%"

if "%MCP_LOCAL_TOKEN%"=="" set /P "MCP_LOCAL_TOKEN=Enter MCP local token: "
set "ALLOW_RAW_WRITE_ANY_FILE=I_UNDERSTAND_THIS_CAN_DESTROY_FILES"

if "%MCP_LOCAL_TOKEN%"=="" (
  echo MCP local token is required before exposing this server.
  pause
  exit /b 1
)

echo @echo off>"%KEYS_FILE%"
echo REM Saved local credentials. Do not commit this file.>>"%KEYS_FILE%"
echo set "MCP_LOCAL_TOKEN=%MCP_LOCAL_TOKEN%">>"%KEYS_FILE%"
echo set "CONTROL_PLANE_API_KEY=%CONTROL_PLANE_API_KEY%">>"%KEYS_FILE%"
echo set "CONTROL_PLANE_TUNNEL_ID=%CONTROL_PLANE_TUNNEL_ID%">>"%KEYS_FILE%"

echo.
echo WORKSPACE_ROOT=%WORKSPACE_ROOT%
echo ALLOW_RAW_WRITE_ANY_FILE is ENABLED
echo.

echo Creating workspace folder if needed...
if not exist "%WORKSPACE_ROOT%" mkdir "%WORKSPACE_ROOT%"

echo.
echo Starting MCP file server...
echo.

call npm run start:http

echo.
echo MCP file server exited with code %ERRORLEVEL%.
pause

popd
endlocal
