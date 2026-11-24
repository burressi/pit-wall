@echo off
rem Pit wall hub with internet link - leave this window open
cd /d "%~dp0"
title Pit wall hub with internet link - leave this window open
where py >nul 2>nul
if %errorlevel%==0 (py -3 pitwall_hub.py --series zenith --tunnel %*) else (python pitwall_hub.py --series zenith --tunnel %*)
echo.
echo The hub has stopped.
pause
