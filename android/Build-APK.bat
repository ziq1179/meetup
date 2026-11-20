@echo off
setlocal
chcp 65001 >nul
title Build Meetup APK
cd /d "%~dp0"

if not defined JAVA_HOME set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot"
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo.
  echo   Java not found. Install JDK 17 or newer and set JAVA_HOME.
  echo.
  pause
  exit /b 1
)

echo.
echo   Building Meetup APK (release, signed)...
echo.

call "%~dp0gradlew.bat" :app:assembleRelease --no-daemon --console=plain
if errorlevel 1 goto fail

if not exist "%~dp0dist" mkdir "%~dp0dist"
copy /y "%~dp0app\build\outputs\apk\release\app-release.apk" "%~dp0dist\Meetup.apk" >nul

echo.
echo   Done.
echo   APK: %~dp0dist\Meetup.apk
echo.
echo   Copy it to your phone and tap to install.
echo.
pause
exit /b 0

:fail
echo.
echo   Build failed. Scroll up for the first red error.
echo.
pause
exit /b 1
