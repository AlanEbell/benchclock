@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 run.py %*) || (python run.py %*)
pause
