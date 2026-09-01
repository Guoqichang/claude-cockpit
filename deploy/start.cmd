@echo off
setlocal
set "HOME=%USERPROFILE%"
set "PATH=%USERPROFILE%\.opencode\bin;%USERPROFILE%\.local\bin;%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%PATH%"
cd /d "%~dp0\.."
node server.js
