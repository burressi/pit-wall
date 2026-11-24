@echo off
rem Pit wall hub - leave this window open
cd /d "%~dp0"
title Pit wall hub - leave this window open
where py >nul 2>nul
if %errorlevel%==0 (py -3 pitwall_hub.py --series zenith %*) else (python pitwall_hub.py --series zenith %*)
echo.
echo The hub has stopped. Close this window, or double-click Start Pit Wall to run it again.
pause
