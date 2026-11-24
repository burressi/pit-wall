@echo off
rem Pit wall rehearsal on the HSR feed - leave this window open
cd /d "%~dp0"
title Pit wall rehearsal on the HSR feed - leave this window open
where py >nul 2>nul
if %errorlevel%==0 (py -3 pitwall_hub.py --series hsr %*) else (python pitwall_hub.py --series hsr %*)
echo.
echo The hub has stopped.
pause
