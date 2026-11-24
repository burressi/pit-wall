@echo off
rem Zenith sessions on Al Kamel live timing
cd /d "%~dp0"
title Zenith sessions on Al Kamel live timing
where py >nul 2>nul
if %errorlevel%==0 (py -3 pitwall_hub.py --series zenith --list) else (python pitwall_hub.py --series zenith --list)
echo.
echo Session list above.
pause
