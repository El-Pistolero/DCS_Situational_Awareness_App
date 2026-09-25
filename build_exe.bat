@echo off
rem Build dist\DCS-SA.exe on Windows.  Needs Python 3.10+ from python.org.
cd /d "%~dp0"
python -m pip install --upgrade -r requirements-desktop.txt || goto :error
python -m pyinstaller --noconfirm --clean dcs-sa.spec || python -m PyInstaller --noconfirm --clean dcs-sa.spec || goto :error
echo.
echo Built dist\DCS-SA.exe
pause
exit /b 0
:error
echo Build failed.
pause
exit /b 1
