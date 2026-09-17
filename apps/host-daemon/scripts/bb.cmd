@echo off
setlocal
set "BB_CLI_ENTRY=%~dp0bb"
if /I "%BB_CLI%"=="%~f0" set "BB_CLI_REEXEC=1"
if not exist "%BB_CLI_ENTRY%" (
  echo Missing bundled bb CLI entry. Reinstall ARC. 1>&2
  exit /b 1
)
if defined BB_CLI_RUNTIME (
  set "ELECTRON_RUN_AS_NODE=1"
  "%BB_CLI_RUNTIME%" "%BB_CLI_ENTRY%" %*
) else (
  node "%BB_CLI_ENTRY%" %*
)
exit /b %errorlevel%
