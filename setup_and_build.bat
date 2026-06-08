@echo off
setlocal EnableDelayedExpansion
title GeoAttendance - APK Builder Setup
color 0A

echo.
echo ============================================================
echo   GeoAttendance - Prerequisites Installer ^& APK Builder
echo ============================================================
echo.

:: ── Helper: check if a command exists ────────────────────────────────────────
:CHECK_CMD
goto :MAIN

:cmd_exists
where %1 >nul 2>&1
exit /b %errorlevel%

:MAIN

:: ── 1. Check for winget (Windows Package Manager) ────────────────────────────
echo [1/7] Checking Windows Package Manager (winget)...
where winget >nul 2>&1
if %errorlevel% neq 0 (
    echo  [WARN] winget not found. Please install it from the Microsoft Store:
    echo         https://aka.ms/getwinget
    echo  Then re-run this script.
    pause
    exit /b 1
)
echo  [OK] winget found.
echo.

:: ── 2. Install Node.js LTS ────────────────────────────────────────────────────
echo [2/7] Checking Node.js...
where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
    echo  [OK] Node.js !NODE_VER! already installed.
) else (
    echo  [INFO] Installing Node.js LTS via winget...
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo  [ERROR] Node.js installation failed. Install manually: https://nodejs.org
        pause
        exit /b 1
    )
    echo  [OK] Node.js installed. Refreshing PATH...
    call RefreshEnv.cmd >nul 2>&1
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
echo.

:: ── 3. Install JDK 17 ─────────────────────────────────────────────────────────
echo [3/7] Checking JDK 17...
where java >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr "version"') do set JAVA_VER=%%v
    echo  [OK] Java !JAVA_VER! already installed.
) else (
    echo  [INFO] Installing Microsoft OpenJDK 17 via winget...
    winget install --id Microsoft.OpenJDK.17 --silent --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo  [ERROR] JDK installation failed. Install manually:
        echo          https://learn.microsoft.com/en-us/java/openjdk/download
        pause
        exit /b 1
    )
    set "JAVA_HOME=%ProgramFiles%\Microsoft\jdk-17"
    set "PATH=%PATH%;%JAVA_HOME%\bin"
    echo  [OK] JDK 17 installed.
)
echo.

:: ── 4. Install Android Studio ─────────────────────────────────────────────────
echo [4/7] Checking Android Studio...
set "ANDROID_STUDIO_PATH=%ProgramFiles%\Android\Android Studio\bin\studio64.exe"
if exist "!ANDROID_STUDIO_PATH!" (
    echo  [OK] Android Studio already installed.
) else (
    echo  [INFO] Installing Android Studio via winget...
    winget install --id Google.AndroidStudio --silent --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo  [WARN] Automatic install failed. Download manually:
        echo         https://developer.android.com/studio
        echo  After installing, re-run this script.
        pause
        exit /b 1
    )
    echo  [OK] Android Studio installed.
)
echo.

:: ── 5. Set ANDROID_HOME & PATH if not already set ────────────────────────────
echo [5/7] Configuring Android SDK environment variables...
if not defined ANDROID_HOME (
    set "ANDROID_HOME=%USERPROFILE%\AppData\Local\Android\Sdk"
    setx ANDROID_HOME "%USERPROFILE%\AppData\Local\Android\Sdk" >nul
    echo  [SET] ANDROID_HOME = %USERPROFILE%\AppData\Local\Android\Sdk
) else (
    echo  [OK] ANDROID_HOME already set: %ANDROID_HOME%
)

set "PATH=%PATH%;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator;%ANDROID_HOME%\cmdline-tools\latest\bin"
setx PATH "%PATH%;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator" >nul
echo  [OK] Android SDK paths added.
echo.

:: ── 6. Install npm dependencies ───────────────────────────────────────────────
echo [6/7] Installing project npm dependencies...
if not exist "package.json" (
    echo  [ERROR] package.json not found!
    echo  Make sure you run this .bat from inside the project folder.
    echo  e.g.  cd C:\path\to\project  then  setup_and_build.bat
    pause
    exit /b 1
)

call npm install
if %errorlevel% neq 0 (
    echo  [ERROR] npm install failed.
    pause
    exit /b 1
)
echo  [OK] npm packages installed (includes @capacitor-community/background-geolocation).
echo.

:: ── 7. Capacitor init + Android platform setup ───────────────────────────────
echo [7/7] Setting up Capacitor and Android platform...

:: Check if capacitor is already initialised (capacitor.config.ts exists)
if exist "capacitor.config.ts" (
    echo  [OK] capacitor.config.ts already exists, skipping cap init.
) else (
    echo  [INFO] Running cap init...
    call npx cap init GeoAttendance com.geoattendance.app --web-dir dist
)

:: Add android platform if not present
if exist "android" (
    echo  [OK] android/ folder already exists, skipping cap add android.
) else (
    echo  [INFO] Adding Android platform...
    call npx cap add android
    if %errorlevel% neq 0 (
        echo  [ERROR] cap add android failed.
        pause
        exit /b 1
    )
)
echo.

:: ── Build web app ─────────────────────────────────────────────────────────────
echo Building web app (npm run build)...
call npm run build
if %errorlevel% neq 0 (
    echo  [ERROR] Web build failed. Fix TypeScript/lint errors above and retry.
    pause
    exit /b 1
)
echo  [OK] Web app built to dist/
echo.

:: ── Sync to Android ───────────────────────────────────────────────────────────
echo Syncing to Android (npx cap sync)...
call npx cap sync android
if %errorlevel% neq 0 (
    echo  [ERROR] cap sync failed.
    pause
    exit /b 1
)
echo  [OK] Synced.
echo.

:: ── Reminder: add AndroidManifest permissions ────────────────────────────────
echo ============================================================
echo   IMPORTANT: Add permissions to AndroidManifest.xml
echo ============================================================
echo.
echo   Open:  android\app\src\main\AndroidManifest.xml
echo   Add the permissions listed in:  ANDROID_PERMISSIONS.md
echo   (Location, Notifications, Background, ForegroundService)
echo.
echo ============================================================
echo   Now choose how to build your APK:
echo ============================================================
echo.
echo   A) Open Android Studio and use Build ^> Build APK(s)
echo   B) Build debug APK from command line right now
echo.
set /p CHOICE="Enter A or B: "

if /I "%CHOICE%"=="A" (
    echo.
    echo Opening Android Studio...
    call npx cap open android
    echo.
    echo In Android Studio:
    echo   1. Wait for Gradle sync to finish
    echo   2. Go to Build ^> Build Bundle(s) / APK(s) ^> Build APK(s)
    echo   3. APK will be at:
    echo      android\app\build\outputs\apk\debug\app-debug.apk
) else (
    echo.
    echo Building debug APK via Gradle...
    cd android
    call gradlew.bat assembleDebug
    if %errorlevel% neq 0 (
        echo  [ERROR] Gradle build failed.
        echo  Try opening Android Studio and syncing the project first.
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo.
    echo  ============================================================
    echo   SUCCESS! APK built:
    echo   android\app\build\outputs\apk\debug\app-debug.apk
    echo  ============================================================
    echo.
    echo  Install on connected device:
    echo    adb install android\app\build\outputs\apk\debug\app-debug.apk
    echo.
    :: Open the folder containing the APK
    explorer android\app\build\outputs\apk\debug
)

echo.
echo Done! Press any key to exit.
pause >nul
