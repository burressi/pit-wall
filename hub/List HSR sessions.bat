@echo off
rem HSR sessions on Al Kamel live timing
cd /d "%~dp0"
title HSR sessions on Al Kamel live timing
where py >nul 2>nul
if %errorlevel%==0 (py -3 pitwall_hub.py --series hsr --list) else (python pitwall_hub.py --series hsr --list)
echo.
echo Session list above.
pause
