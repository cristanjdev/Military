@echo off
setlocal enabledelayedexpansion
title ArmoryDB - Setup Script
color 0A

echo ============================================================
echo    ArmoryDB - 10RCDG Firearm Tracking System
echo    Automated Setup & Diagnostic Script
echo ============================================================
echo.

:: -----------------------------------------------------------
:: STEP 1: Locate XAMPP and detect environment
:: -----------------------------------------------------------
echo [1/8] Detecting Environment & PHP...

set "XAMPP_PATH=C:\xampp"
if not exist "%XAMPP_PATH%\mysql\bin\mysql.exe" (
    if exist "D:\xampp\mysql\bin\mysql.exe" (
        set "XAMPP_PATH=D:\xampp"
    ) else if exist "E:\xampp\mysql\bin\mysql.exe" (
        set "XAMPP_PATH=E:\xampp"
    )
)

:: If XAMPP PHP exists, prepend to PATH so it's prioritized
if exist "%XAMPP_PATH%\php\php.exe" (
    echo       Found XAMPP at %XAMPP_PATH%
    set "PATH=%XAMPP_PATH%\php;%XAMPP_PATH%\mysql\bin;%PATH%"
)

where php >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] PHP is not found on your system!
    echo Please install XAMPP (https://www.apachefriends.org) or add PHP to your PATH.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('php -r "echo PHP_VERSION;" 2^>NUL') do set "PHP_VER=%%v"
echo       PHP Version: %PHP_VER%

:: -----------------------------------------------------------
:: STEP 2: Verify & Auto-Configure PHP Extensions (mbstring, pdo_mysql)
:: -----------------------------------------------------------
echo [2/8] Checking PHP Extensions (mbstring, pdo_mysql)...

php -r "exit(extension_loaded('pdo_mysql') && extension_loaded('mbstring') ? 0 : 1);" >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       [!] Required PHP extensions are NOT fully enabled. Attempting auto-configuration...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$raw = (php --ini | Select-String 'Loaded Configuration File:\s*(.*)').Matches.Groups[1].Value;" ^
        "$ini = if ($raw) { $raw.Trim().Trim('\"').Trim() } else { $null };" ^
        "if (-not $ini -or -not (Test-Path $ini)) {" ^
        "    $phpDir = Split-Path (Get-Command php.exe).Source;" ^
        "    if (Test-Path \"$phpDir\php.ini\") { $ini = \"$phpDir\php.ini\" }" ^
        "    elseif (Test-Path \"$phpDir\php.ini-development\") { Copy-Item \"$phpDir\php.ini-development\" \"$phpDir\php.ini\"; $ini = \"$phpDir\php.ini\" }" ^
        "    elseif (Test-Path \"$phpDir\php.ini-production\") { Copy-Item \"$phpDir\php.ini-production\" \"$phpDir\php.ini\"; $ini = \"$phpDir\php.ini\" }" ^
        "}" ^
        "if ($ini -and (Test-Path $ini)) {" ^
        "    Write-Host \"      Configuring $ini...\";" ^
        "    $c = Get-Content $ini -Raw;" ^
        "    $c = $c -replace ';extension_dir\s*=\s*\"ext\"', 'extension_dir = \"ext\"';" ^
        "    $c = $c -replace ';extension_dir\s*=\s*\"[^\"]*ext\"', 'extension_dir = \"ext\"';" ^
        "    $c = $c -replace ';extension\s*=\s*mbstring', 'extension=mbstring';" ^
        "    $c = $c -replace ';extension\s*=\s*pdo_mysql', 'extension=pdo_mysql';" ^
        "    $c = $c -replace ';extension\s*=\s*mysqli', 'extension=mysqli';" ^
        "    $c = $c -replace ';extension\s*=\s*openssl', 'extension=openssl';" ^
        "    $c = $c -replace ';extension\s*=\s*fileinfo', 'extension=fileinfo';" ^
        "    $c = $c -replace ';extension\s*=\s*curl', 'extension=curl';" ^
        "    $c = $c -replace ';extension\s*=\s*gd', 'extension=gd';" ^
        "    $c = $c -replace ';extension\s*=\s*zip', 'extension=zip';" ^
        "    $c = $c -replace ';extension\s*=\s*bcmath', 'extension=bcmath';" ^
        "    $phpDir = Split-Path $ini;" ^
        "    if (-not (Test-Path \"$phpDir\ext\php_sockets.dll\")) { $c = $c -replace '(?<!;)extension\s*=\s*sockets', ';extension=sockets' };" ^
        "    Set-Content -Path $ini -Value $c;" ^
        "    Write-Host '      php.ini updated successfully!';" ^
        "} else { Write-Host '      Could not locate php.ini.' }"

    php -r "exit(extension_loaded('pdo_mysql') && extension_loaded('mbstring') ? 0 : 1);" >NUL 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo.
        echo [ERROR] Required extensions (mbstring, pdo_mysql) could not be loaded automatically.
        echo Please open your php.ini file and enable:
        echo   extension_dir = "ext"
        echo   extension=mbstring
        echo   extension=pdo_mysql
        echo.
        pause
        exit /b 1
    )
    echo       pdo_mysql enabled successfully!
) else (
    echo       pdo_mysql extension is loaded. OK!
)

:: -----------------------------------------------------------
:: STEP 3: Check Composer and Node.js
:: -----------------------------------------------------------
echo [3/8] Checking Composer & Node.js...

where composer >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    if exist "%XAMPP_PATH%\php\composer.bat" (
        set "PATH=%XAMPP_PATH%\php;%PATH%"
    ) else if exist "%APPDATA%\Composer\vendor\bin\composer.bat" (
        set "PATH=%APPDATA%\Composer\vendor\bin;%PATH%"
    ) else if exist "C:\ProgramData\ComposerSetup\bin\composer.bat" (
        set "PATH=C:\ProgramData\ComposerSetup\bin;%PATH%"
    ) else (
        echo.
        echo [ERROR] Composer is not found in PATH!
        echo Please install Composer from https://getcomposer.org/Composer-Setup.exe
        pause
        exit /b 1
    )
)
echo       Composer found. OK!

where node >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js (LTS version) from https://nodejs.org
    pause
    exit /b 1
)
where npm >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] npm is not found in PATH!
    pause
    exit /b 1
)
echo       Node.js & npm found. OK!

:: -----------------------------------------------------------
:: STEP 4: Start MySQL Service
:: -----------------------------------------------------------
echo [4/8] Checking MySQL Server...

set "MYSQL_RUNNING=0"
tasklist /FI "IMAGENAME eq mysqld.exe" 2>NUL | find /I "mysqld.exe" >NUL
if %ERRORLEVEL% EQU 0 (
    set "MYSQL_RUNNING=1"
)

if "!MYSQL_RUNNING!"=="0" (
    echo       MySQL is not running. Attempting to start MySQL...
    if exist "%XAMPP_PATH%\mysql\bin\mysqld.exe" (
        start "" /B "%XAMPP_PATH%\mysql\bin\mysqld.exe" --defaults-file="%XAMPP_PATH%\mysql\bin\my.ini"
    ) else (
        net start mysql >NUL 2>&1
        if !ERRORLEVEL! NEQ 0 (
            net start MariaDB >NUL 2>&1
        )
    )
    
    echo       Waiting for MySQL to accept connections...
    set /a attempts=0
    :wait_mysql_loop
    timeout /t 2 /nobreak >NUL
    php -r "$c=@mysqli_connect('127.0.0.1','root',''); exit($c ? 0 : 1);" >NUL 2>&1
    if !ERRORLEVEL! NEQ 0 (
        set /a attempts+=1
        if !attempts! GEQ 10 (
            echo.
            echo [WARNING] Could not verify MySQL connection automatically.
            echo Please make sure MySQL is started via XAMPP Control Panel.
            echo.
        ) else (
            goto wait_mysql_loop
        )
    ) else (
        echo       MySQL started successfully!
    )
) else (
    echo       MySQL is already running. OK!
)

:: -----------------------------------------------------------
:: STEP 5: Create Database (armorydb)
:: -----------------------------------------------------------
echo [5/8] Creating database 'armorydb' (if not exists)...

php -r "$c = @mysqli_connect('127.0.0.1', 'root', ''); if(!$c){ exit(1); } mysqli_query($c, 'CREATE DATABASE IF NOT EXISTS armorydb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); mysqli_close($c); exit(0);" >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       [!] Attempting fallback using mysql CLI...
    if exist "%XAMPP_PATH%\mysql\bin\mysql.exe" (
        "%XAMPP_PATH%\mysql\bin\mysql.exe" -u root -e "CREATE DATABASE IF NOT EXISTS armorydb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" >NUL 2>&1
    )
)
echo       Database 'armorydb' is ready!

:: -----------------------------------------------------------
:: STEP 6: Backend Setup (Laravel)
:: -----------------------------------------------------------
echo [6/8] Setting up Backend (Laravel)...
cd /d "%~dp0backend"

if not exist ".env" (
    echo       Creating .env from .env.example...
    copy ".env.example" ".env" >NUL
)

if not exist "vendor" (
    echo       Installing backend composer dependencies...
    composer install --no-interaction --prefer-dist --optimize-autoloader
) else (
    echo       Composer dependencies already installed.
)

:: Ensure APP_KEY exists
findstr /C:"APP_KEY=base64:" .env >NUL 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       Generating application encryption key...
    php artisan key:generate --ansi --force
)

echo       Running database migrations...
php artisan migrate --force
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Migrations failed!
    echo Please verify that MySQL is running and database 'armorydb' exists.
    pause
    exit /b 1
)

echo       Seeding database with default records and accounts...
php artisan db:seed --force
if %ERRORLEVEL% NEQ 0 (
    echo       [WARNING] Database seeding returned a non-zero exit code.
)

echo       Backend setup completed successfully!

:: -----------------------------------------------------------
:: STEP 7: Frontend Setup (Next.js)
:: -----------------------------------------------------------
echo [7/8] Setting up Frontend (Next.js)...
cd /d "%~dp0frontend"

if not exist ".env.local" (
    echo       Creating frontend/.env.local...
    (
        echo NEXT_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1
        echo NEXT_PUBLIC_APP_NAME=ArmoryDB - 10RCDG Firearm Tracking
        echo NEXT_PUBLIC_INSTITUTION=10RCDG
        echo NEXT_PUBLIC_DEFAULT_MAP_CENTER_LAT=14.5995
        echo NEXT_PUBLIC_DEFAULT_MAP_CENTER_LON=120.9842
        echo NEXT_PUBLIC_GPS_POLL_SECONDS=30
        echo NEXT_PUBLIC_BIOMETRIC_BRIDGE_URL=http://127.0.0.1:8787
    ) > .env.local
)

if not exist "node_modules" (
    echo       Installing frontend npm dependencies (this may take a few minutes)...
    call npm install
) else (
    echo       Frontend dependencies already installed.
)

echo       Frontend setup completed successfully!

:: -----------------------------------------------------------
:: STEP 8: Setup Completed
:: -----------------------------------------------------------
cd /d "%~dp0"
echo.
echo ============================================================
echo    SETUP FINISHED SUCCESSFULLY!
echo ============================================================
echo.
echo Default Admin Account:
echo   Username: admin
echo   Password: Admin@10RCDG!2025
echo.
echo Other Accounts:
echo   cmd.officer      / Command@2025!      (Command Officer)
echo   s4.officer       / S4Logistics@2025!  (S4 Officer)
echo   armory.custodian / Custodian@2025!    (Armory Custodian)
echo.
echo Setup is done. To start the system, follow RUNNING_THE_SYSTEM.txt
echo (MySQL, then the backend and the frontend in their own terminals).
pause
