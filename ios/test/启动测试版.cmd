@echo off
rem Orange Music iOS test server (same build as production)
cd /d "%~dp0..\www"
set PORT=3000
node server.js
