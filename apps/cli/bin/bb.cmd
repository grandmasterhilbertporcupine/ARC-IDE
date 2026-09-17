@echo off
setlocal
set "BB_CLI_ENTRY=%~dp0..\dist\index.js"
if not exist "%BB_CLI_ENTRY%" (
  echo Missing built bb CLI entry. Run pnpm cli:prepare in the source checkout. 1>&2
  exit /b 1
)
node "%BB_CLI_ENTRY%" %*
exit /b %errorlevel%
