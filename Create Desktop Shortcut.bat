@echo off
rem Put a "DCS SA" icon on your desktop and in the Start menu (running from source).
cd /d "%~dp0"
python -m dcs_sa install-shortcut
pause
