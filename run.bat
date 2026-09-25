@echo off
rem Run DCS SA from source (no build step).  Needs Python 3.10+ from python.org.
cd /d "%~dp0"
python -m dcs_sa %*
if errorlevel 1 pause
