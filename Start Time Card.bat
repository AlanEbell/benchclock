@echo off
rem Windows launcher. pyw/pythonw start the window without a black console behind it.
cd /d "%~dp0"
where pyw >nul 2>nul && (start "" pyw -3 run.py %* & exit /b)
where pythonw >nul 2>nul && (start "" pythonw run.py %* & exit /b)
python run.py %*
if errorlevel 1 pause
