# ArmoryDB tracker setup.
#
# Window: pick the hotspot's Wi-Fi; its password is filled in when this laptop has it saved. This laptop's
# IP address and the ESP32's COM port are detected automatically and follow plug / network changes.
# "Save to tracker" writes them into config.h and flashes the ESP32 with "Erase All Flash" (which also
# clears any Wi-Fi / address saved earlier from the phone setup page, so the board uses config.h), then
# checks that the tracker joins the Wi-Fi, that its GPS module talks and that it reaches this laptop.
# When the window closes, the same terminal shows the tracker's live status until Ctrl+C. Live status
# comes over USB while the tracker is plugged in, and over Wi-Fi otherwise (the tracker reports to the
# backend, which notes it in backend\storage\logs\trackers.log). It steps aside by itself while a setup
# window uses the tracker's USB port (upload or Watch live).
#
# Usage (from the project folder):
#   iot\setup-tracker.bat            window, then live status
#   iot\setup-tracker.bat monitor    live status only
#   iot\setup-tracker.bat detect     print what would be detected, no window
param([string]$Action = 'window')

$ErrorActionPreference = 'Stop'

$IotDir     = Split-Path -Parent $PSScriptRoot
$RepoRoot   = Split-Path -Parent $IotDir
$SketchDir  = Join-Path $IotDir 'firmware\armory_tracker'
$ConfigH    = Join-Path $SketchDir 'config.h'
$ExampleH   = Join-Path $SketchDir 'config.example.h'
$BackendEnv = Join-Path $RepoRoot 'backend\.env'
# What trackers report over Wi-Fi, one line each, written by the backend (App\Services\TrackerLog).
$TrackerLog = Join-Path $RepoRoot 'backend\storage\logs\trackers.log'
$Fqbn       = 'esp32:esp32:esp32'
$ApiPort    = 8000
# Without a USB cable, Save builds into $BuildDir and leaves the firmware in $FirmwareDir; the backend offers
# it to the tracker in answer to its next report (App\Services\TrackerFirmware).
$BuildDir    = Join-Path $env:TEMP 'armory-tracker-build'
$FirmwareDir = Join-Path $RepoRoot 'backend\storage\app\firmware'
$OutLog     = Join-Path $env:TEMP 'armory-tracker-flash.out.log'
$ErrLog     = Join-Path $env:TEMP 'armory-tracker-flash.err.log'
# Held by a setup window while it uses the tracker's port (upload and check, or Watch live);
# live-status terminals let go of the port meanwhile.
$PortLockName = 'Local\ArmoryTrackerPort'

# Non-ASCII glyphs as code points: Windows PowerShell reads a BOM-less script as ANSI.
$G = @{
    Check = [string][char]0x2713; Cross = [string][char]0x2715; Dot = [string][char]0x25CF
    Down  = [string][char]0x25BE; Up    = [string][char]0x25B4; Ellipsis = [string][char]0x2026
}

# ================================================================ detection

function Find-ArduinoCli {
    $cmd = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $env:LOCALAPPDATA 'arduino-cli\arduino-cli.exe'
    if (Test-Path $local) { return $local }
    return $null
}

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path $BackendEnv)) { return '' }
    $m = Select-String -Path $BackendEnv -Pattern "^$Key=(.*)$" | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim().Trim('"') }
    return ''
}

# The Wi-Fi this laptop is on right now, and its band.
function Get-LaptopWifi {
    $out = netsh wlan show interfaces 2>$null | Out-String
    $ssid = ''; $band = ''
    if ($out -match '(?m)^\s+SSID\s+:\s(.+)$') { $ssid = $Matches[1].Trim() }
    if ($out -match '(?m)^\s+Band\s+:\s(.+)$') { $band = $Matches[1].Trim() }
    [pscustomobject]@{ Ssid = $ssid; Band = $band }
}

# Networks in range: name -> $true when it is visible on 2.4 GHz (the only band the ESP32 can use).
function Get-VisibleNetworks {
    $result = [ordered]@{}
    $current = $null
    foreach ($line in (netsh wlan show networks mode=bssid 2>$null)) {
        if ($line -match '^SSID \d+ : (.*)$') {
            $current = $Matches[1].Trim()
            if ($current -and -not $result.Contains($current)) { $result[$current] = $false }
        } elseif ($current -and $line -match '^\s+Band\s+:\s+2\.4 GHz') {
            $result[$current] = $true
        }
    }
    # Windows' list can lag behind a hotspot that was just switched on; the one this laptop is on is in range.
    $laptop = Get-LaptopWifi
    if ($laptop.Ssid -and -not $result.Contains($laptop.Ssid)) { $result[$laptop.Ssid] = [bool]($laptop.Band -match '2\.4') }
    return $result
}

# The password Windows saved for this Wi-Fi when the laptop joined it ('' when none or not readable).
function Get-SavedWifiPassword([string]$Ssid) {
    if (-not $Ssid) { return '' }
    $out = netsh wlan show profile name="$Ssid" key=clear 2>$null | Out-String
    if ($out -match '(?m)^\s+Key Content\s+:\s(.*)$') { return $Matches[1].TrimEnd("`r") }
    return ''
}

# Changes whenever this laptop joins or leaves a network (its IPv4 addresses change).
function Get-NetworkSignature {
    @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
        ForEach-Object { $_.Address.IPAddressToString }) -join ','
}

# This laptop's IPv4 address on the network that has a gateway (the hotspot), Wi-Fi preferred.
function Get-LaptopIp {
    $configs = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' })
    $wifi = $configs | Where-Object {
        $_.NetAdapter.PhysicalMediaType -match '802\.11' -or $_.InterfaceAlias -match 'Wi-?Fi|WLAN|Wireless'
    } | Select-Object -First 1
    $pick = if ($wifi) { $wifi } else { $configs | Select-Object -First 1 }
    if ($pick) { return ($pick.IPv4Address | Select-Object -First 1).IPAddress }
    return ''
}

# USB-serial ports, the ESP32's usual chips (CH340, CP210x) first.
function Get-TrackerPorts {
    @(Get-PnpDevice -PresentOnly -Class Ports -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.FriendlyName -match '\((COM\d+)\)') {
            [pscustomobject]@{
                Port   = $Matches[1]
                Label  = $_.FriendlyName
                Likely = [bool]($_.FriendlyName -match 'CH34|CP210|USB')
            }
        }
    } | Sort-Object @{ Expression = { -not $_.Likely } }, Port)
}

# Changes whenever a USB-serial device is plugged in or out (cheap enough to poll).
function Get-PortNames { ([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object) -join ',' }

# Opens a tracker port for reading. Pulling the USB cable while a port is open makes .NET's cleanup of
# it throw on the finalizer thread, which ends the whole program; skipping that cleanup avoids it.
function Open-TrackerPort([string]$Port) {
    $sp = New-Object System.IO.Ports.SerialPort $Port, 115200, 'None', 8, 'One'
    $sp.Encoding = [Text.Encoding]::UTF8
    $sp.ReadTimeout = 500
    $sp.DtrEnable = $false  # no reset of the board
    $sp.RtsEnable = $false
    $sp.Open()
    [GC]::SuppressFinalize($sp.BaseStream)
    return $sp
}

# True when nothing else has the COM port open.
function Test-PortFree([string]$Port) {
    $sp = New-Object System.IO.Ports.SerialPort $Port
    try { $sp.Open(); return $true } catch { return $false } finally { if ($sp.IsOpen) { $sp.Close() }; $sp.Dispose() }
}

# True while a setup window uses the tracker's port (it holds the port lock).
function Test-PortClaimed {
    $lock = New-Object System.Threading.Mutex($false, $PortLockName)
    try {
        $free = $false
        try { $free = $lock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $free = $true }
        if ($free) { $lock.ReleaseMutex() }
        return -not $free
    } finally { $lock.Dispose() }
}

# Firearms whose Active/Overdue transaction has GPS tracking on: the ones that accept positions.
function Get-TrackableFirearms {
    $mysql = 'C:\xampp\mysql\bin\mysql.exe'
    if (-not (Test-Path $mysql)) { return @() }
    $db = Get-EnvValue 'DB_DATABASE'; if (-not $db) { $db = 'armorydb' }
    $user = Get-EnvValue 'DB_USERNAME'; if (-not $user) { $user = 'root' }
    $env:MYSQL_PWD = Get-EnvValue 'DB_PASSWORD'
    $query = "SELECT f.equipment_id, f.serial_number, f.model, t.status FROM firearm_equipment f " +
             "JOIN transactions t ON t.equipment_id = f.equipment_id " +
             "WHERE f.deleted_at IS NULL AND t.status IN ('Active','Overdue') AND t.gps_tracking_enabled = 1 " +
             "ORDER BY f.equipment_id"
    try {
        $rows = & $mysql --host=127.0.0.1 "--user=$user" --connect-timeout=2 -N -B -e $query $db 2>$null
    } catch {
        $rows = @()
    } finally {
        Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
    }
    @($rows | Where-Object { $_ } | ForEach-Object {
        $c = $_ -split "`t"
        "{0} - {1} {2} ({3})" -f $c[0], $c[1], $c[2], $c[3]
    })
}

function Get-ConfigDefine([string]$Key) {
    $file = if (Test-Path $ConfigH) { $ConfigH } else { $ExampleH }
    $m = Select-String -Path $file -Pattern "^#define\s+$Key\s+(.*)$" | Select-Object -First 1
    if (-not $m) { return '' }
    $value = $m.Matches[0].Groups[1].Value.Trim()
    if ($value -match '^"(.*)"') { return $Matches[1] }
    return ($value -split '\s+')[0]
}

function Test-Backend([string]$Ip) {
    if (-not $Ip) { return $false }
    try {
        $r = Invoke-WebRequest "http://${Ip}:$ApiPort/api/health" -UseBasicParsing -TimeoutSec 3
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# XAMPP's MySQL is a manual-start service on this laptop, so it is stopped after every restart, and the
# backend can store no position without it. $true when it was stopped and has been started.
function Start-MysqlIfStopped {
    $svc = Get-Service mysql -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -eq 'Running') { return $false }
    try {
        Start-Service mysql -ErrorAction Stop
        $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
        return $true
    } catch { return $false }
}

# Lines in the Wi-Fi log carry the tracker's device id.
function Get-DeviceId {
    $id = Get-ConfigDefine 'DEVICE_ID'
    if ($id) { return $id }
    return 'ESP32-001'
}

# The tracker's last report over Wi-Fi as @{ At; Text }, from the end of the backend's log, or $null.
function Get-LastWifiReport([string]$DeviceId) {
    if (-not (Test-Path $TrackerLog)) { return $null }
    $fs = [IO.File]::Open($TrackerLog, 'Open', 'Read', 'ReadWrite')
    try {
        [void]$fs.Seek(-[Math]::Min($fs.Length, [long]8192), 'End')
        $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
    } finally { $fs.Close() }
    $last = $null
    foreach ($line in ($text -split "`n")) {
        if ($line -match '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)  (\S+)  (.*)$' -and $Matches[2] -eq $DeviceId) {
            $last = [pscustomobject]@{ At = [datetime]$Matches[1]; Text = $Matches[3].TrimEnd() }
        }
    }
    return $last
}

# A tracker that cannot join its Wi-Fi when it starts opens its own setup Wi-Fi (firmware SETUP_AP_NAME).
function Get-SetupWifiName {
    $name = Get-ConfigDefine 'SETUP_AP_NAME'
    if ($name -and $name -notmatch 'DEVICE_ID') { return $name }
    return "ArmoryTracker-$(Get-DeviceId)"
}

# New lines the backend noted for one tracker since the last call, as @{ Time; Text }. $State remembers
# the read position; a fresh @{} starts at the end, so only what arrives from now on is shown.
function Read-WifiLines([hashtable]$State, [string]$DeviceId) {
    if (-not (Test-Path $TrackerLog)) { $State.Pos = [long]0; return }
    $fs = [IO.File]::Open($TrackerLog, 'Open', 'Read', 'ReadWrite')
    try {
        if ($null -eq $State.Pos) { $State.Pos = $fs.Length }
        if ($fs.Length -lt $State.Pos) { $State.Pos = [long]0 }  # the backend started a new file
        if ($fs.Length -eq $State.Pos) { return }
        [void]$fs.Seek($State.Pos, 'Begin')
        $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
        $end = $text.LastIndexOf("`n")
        if ($end -lt 0) { return }  # a line still being written: next time
        $State.Pos += [Text.Encoding]::UTF8.GetByteCount($text.Substring(0, $end + 1))
        foreach ($line in ($text.Substring(0, $end) -split "`n")) {
            if ($line -match '^\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)  (\S+)  (.*)$' -and $Matches[2] -eq $DeviceId) {
                [pscustomobject]@{ Time = $Matches[1]; Text = $Matches[3].TrimEnd() }
            }
        }
    } finally { $fs.Close() }
}

# ================================================================ config.h

function ConvertTo-CString([string]$Value) {
    return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

function Set-Define([string]$Text, [string]$Key, [string]$Value) {
    $pattern = "(?m)^#define\s+$Key\b.*$"
    if ($Text -notmatch $pattern) { throw "#define $Key was not found in config.h" }
    $line = "#define $Key $Value"
    return [regex]::Replace($Text, $pattern, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $line })
}

function Set-OrAddDefine([string]$Text, [string]$Key, [string]$Value) {
    if ($Text -match "(?m)^#define\s+$Key\b") { return Set-Define $Text $Key $Value }
    return $Text.TrimEnd() + "`r`n`r`n#define $Key $Value`r`n"
}

function Write-TrackerConfig([string]$Ssid, [string]$Password, [string]$Ip, [int]$EquipmentId, [string]$Build) {
    if (-not (Test-Path $ConfigH)) { Copy-Item $ExampleH $ConfigH }
    $text = [IO.File]::ReadAllText($ConfigH)
    $text = Set-Define $text 'WIFI_SSID' (ConvertTo-CString $Ssid)
    $text = Set-Define $text 'WIFI_PASS' (ConvertTo-CString $Password)
    $text = Set-Define $text 'API_URL' (ConvertTo-CString "http://${Ip}:$ApiPort/api/v1/gps/ingest")
    $text = Set-Define $text 'USE_HTTPS' '0'
    $text = Set-Define $text 'EQUIPMENT_ID' "$EquipmentId"
    # The GPS is wired to D18/D19 (this board has no GPIO16/17 headers); a config.h made from an
    # older template still says 16/17, which reads nothing even under open sky.
    $text = Set-Define $text 'GPS_RX_PIN' '18'
    $text = Set-Define $text 'GPS_TX_PIN' '19'
    # Keep the signing secret identical to the backend's, or every position is rejected (401).
    $secret = Get-EnvValue 'IOT_HMAC_SECRET'
    if ($secret) { $text = Set-Define $text 'HMAC_SECRET' (ConvertTo-CString $secret) }
    # The tracker reports its build; an update over Wi-Fi is done once it reports this one.
    $text = Set-OrAddDefine $text 'FIRMWARE_BUILD' (ConvertTo-CString $Build)
    [IO.File]::WriteAllText($ConfigH, $text, (New-Object Text.UTF8Encoding $false))
}

# Leaves the firmware just built for the backend to offer to the tracker over Wi-Fi.
function Publish-Firmware([string]$Build) {
    $bin = Join-Path $BuildDir 'armory_tracker.ino.bin'
    if (-not (Test-Path $bin)) { throw "the build left no $bin" }
    New-Item -ItemType Directory -Force -Path $FirmwareDir | Out-Null
    $device = Get-DeviceId
    Copy-Item $bin (Join-Path $FirmwareDir "$device.bin") -Force
    $meta = @{
        build = $Build
        md5   = (Get-FileHash $bin -Algorithm MD5).Hash.ToLower()
        size  = (Get-Item $bin).Length
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $FirmwareDir "$device.json"), $meta, (New-Object Text.UTF8Encoding $false))
}

# Takes back a waiting update (it holds the Wi-Fi password and the secret).
function Remove-PublishedFirmware {
    $device = Get-DeviceId
    Remove-Item (Join-Path $FirmwareDir "$device.bin"), (Join-Path $FirmwareDir "$device.json") -ErrorAction SilentlyContinue
}

# ================================================================ live status in the terminal

function Get-LineColor([string]$Line) {
    if ($Line -match 'failed|HTTP [45]\d\d|transport error|rejected|Guru|panic|abort|Backtrace|not found|NO DATA|GARBLED|NOT reachable|CRASH|WATCHDOG|BROWNOUT|cannot update|cannot install|install failed|download failed') { return 'Red' }
    if ($Line -match 'HTTP 2\d\d|\[wifi\] connected|\[gps\] -?\d+\.\d+|\[link\] laptop (reachable|found)') { return 'Green' }
    if ($Line -match 'no fix yet|fix lost|fix too weak|waiting for a GPS fix|reconnecting|link down|laptop silent|setup mode') { return 'Yellow' }
    if ($Line -match '\[setup\]|\*wm:|\[boot\]|\[ota\]') { return 'Cyan' }
    return 'Gray'
}

# Likely ESP32 ports only: a Bluetooth or modem COM port must not stand in for the tracker.
function Get-UsbTracker([string]$Prefer) {
    $ports = @(Get-TrackerPorts | Where-Object Likely)
    if ($Prefer -and ($ports | Where-Object Port -eq $Prefer)) { return $Prefer }
    return ($ports | Select-Object -First 1).Port
}

# Live status over USB until the tracker is unplugged ('unplugged') or its port is held by another
# program ('busy').
function Watch-Usb([string]$Port) {
    if (Test-PortClaimed) {
        Write-Host '  A setup window is using the tracker. Live status here resumes by itself.' -ForegroundColor DarkGray
        while (Test-PortClaimed) { Start-Sleep -Milliseconds 500 }
    }
    try {
        $sp = Open-TrackerPort $Port
    } catch {
        Write-Host "  Could not open ${Port}: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '  Another program uses it (arduino-cli monitor, Arduino IDE). Following the tracker over Wi-Fi meanwhile.' -ForegroundColor Yellow
        return 'busy'
    }
    Write-Host "  By USB on $Port" -ForegroundColor Cyan
    try {
        while ($true) {
            if (Test-PortClaimed) {
                # A setup window needs the port (upload or Watch live): step aside, then come back.
                $sp.Close()
                Write-Host '  Paused while the setup window uses the tracker. Resumes by itself.' -ForegroundColor DarkGray
                while (Test-PortClaimed) { Start-Sleep -Milliseconds 500 }
                $back = $false
                for ($i = 0; $i -lt 40 -and -not $back; $i++) {
                    try { $sp = Open-TrackerPort $Port; $back = $true } catch { Start-Sleep -Milliseconds 500 }
                }
                if (-not $back) {
                    if (-not (Get-UsbTracker $Port)) { Write-Host '  The tracker was unplugged.' -ForegroundColor Yellow; return 'unplugged' }
                    Write-Host "  Could not reopen ${Port}: another program is using it." -ForegroundColor Yellow
                    return 'busy'
                }
                Write-Host '  Resumed.' -ForegroundColor DarkGray
                continue
            }
            try {
                $line = $sp.ReadLine().TrimEnd()
            } catch [System.TimeoutException] {
                continue
            } catch {
                Write-Host "  The tracker was unplugged from $Port." -ForegroundColor Yellow
                return 'unplugged'
            }
            if (-not $line.Trim()) { continue }
            Write-Host ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $line) -ForegroundColor (Get-LineColor $line)
        }
    } finally {
        try { if ($sp.IsOpen) { $sp.Close() } } catch { }  # an unplugged port can refuse to close
    }
}

# Live status over Wi-Fi (what the backend notes) until a tracker can be watched by USB: one is plugged
# in, or $BusyPort (held by another program) is free again.
function Watch-Wifi([string]$BusyPort) {
    $device = Get-DeviceId
    $ssid = Get-ConfigDefine 'WIFI_SSID'
    Write-Host "  Over Wi-Fi: $device reports every 10 s while it waits for a GPS fix, and each position it sends." -ForegroundColor Cyan
    $state = @{}
    $quietSince = Get-Date
    $hinted = $false
    $nextPortCheck = Get-Date
    while ($true) {
        foreach ($entry in @(Read-WifiLines $state $device)) {
            Write-Host ("{0}  {1}" -f $entry.Time, $entry.Text) -ForegroundColor (Get-LineColor $entry.Text)
            $quietSince = Get-Date
            $hinted = $false
        }
        if (-not $hinted -and ((Get-Date) - $quietSince).TotalSeconds -gt 30) {
            $hinted = $true
            Write-Host "  Nothing over Wi-Fi for 30 s. Is the tracker powered and on '$ssid', and is the backend running?" -ForegroundColor Yellow
        }
        if ((Get-Date) -ge $nextPortCheck) {
            $nextPortCheck = (Get-Date).AddSeconds(2)
            $usb = Get-UsbTracker ''
            if ($usb -and ($usb -ne $BusyPort -or (-not (Test-PortClaimed) -and (Test-PortFree $BusyPort)))) { return }
        }
        Start-Sleep -Milliseconds 700
    }
}

function Start-ConsoleMonitor([string]$Port) {
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
    Write-Host ''
    Write-Host '  Live tracker status' -ForegroundColor Cyan
    Write-Host '  green = connected / position sent    yellow = waiting for GPS    red = problem' -ForegroundColor DarkGray
    Write-Host '  Comes by USB while the tracker is plugged in, over Wi-Fi otherwise. Ctrl+C stops watching; the tracker keeps running.' -ForegroundColor DarkGray
    if (Start-MysqlIfStopped) { Write-Host '  MySQL was stopped; started it (positions are stored there).' -ForegroundColor DarkGray }
    Write-Host ''
    $busyPort = ''
    while ($true) {
        $usb = $(if ($busyPort) { '' } else { Get-UsbTracker $Port })
        if ($usb) {
            if ((Watch-Usb $usb) -eq 'busy') { $busyPort = $usb }
        } else {
            Watch-Wifi $busyPort
            $busyPort = ''
        }
        $Port = ''
    }
}

# ================================================================ non-window actions

switch ($Action.ToLower()) {
    'detect' {
        $wifi = Get-LaptopWifi
        $ip = Get-LaptopIp
        "arduino-cli : " + $(if (Find-ArduinoCli) { Find-ArduinoCli } else { 'NOT FOUND' })
        "laptop Wi-Fi: '$($wifi.Ssid)' ($($wifi.Band))"
        "laptop IP   : $ip"
        "backend     : " + $(if (Test-Backend $ip) { "reachable at http://${ip}:$ApiPort" } else { 'not reachable' })
        "ESP32 ports : " + ((Get-TrackerPorts | ForEach-Object Label) -join ', ')
        "firearms    : " + ((Get-TrackableFirearms) -join ' | ')
        "networks    : " + (((Get-VisibleNetworks).GetEnumerator() | ForEach-Object {
            $_.Key + $(if ($_.Value) { '' } else { ' (5 GHz only)' }) }) -join ', ')
        "config.h    : " + $(if (Test-Path $ConfigH) { "present, EQUIPMENT_ID=$(Get-ConfigDefine 'EQUIPMENT_ID')" } else { 'missing (created from config.example.h on save)' })
        "mysql       : " + $(if ($svc = Get-Service mysql -ErrorAction SilentlyContinue) { $svc.Status } else { 'no "mysql" service' })
        $last = $(if (Test-Path $TrackerLog) { Select-String -Path $TrackerLog -Pattern "^\S+ \S+  $([regex]::Escape((Get-DeviceId)))  " | Select-Object -Last 1 })
        "over Wi-Fi  : " + $(if ($last) { $last.Line } else { "nothing from $(Get-DeviceId) yet" })
        return
    }
    'monitor' {
        Start-ConsoleMonitor ''
        return
    }
}

# ================================================================ window: look and feel

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
    Add-Type -Namespace ArmoryNative -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
    [void][ArmoryNative.Dpi]::SetProcessDPIAware()
} catch { }
# Windows 10/11 dark title bar (ignored on older Windows).
try {
    Add-Type -Namespace ArmoryNative -Name Theme -MemberDefinition @'
[DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] public static extern int SetWindowTheme(IntPtr hWnd, string subAppName, string subIdList);
[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
'@
} catch { }
[System.Windows.Forms.Application]::EnableVisualStyles()
# Errors inside button/timer handlers go to Report-UiError (below) instead of the Windows crash dialog.
# Must be set before the first window is created.
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)

$gfx = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$script:Scale = $gfx.DpiX / 96.0
$gfx.Dispose()
function Px([double]$Value) { return [int][Math]::Round($Value * $script:Scale) }
function Pad([double]$l, [double]$t, [double]$r, [double]$b) { New-Object System.Windows.Forms.Padding((Px $l), (Px $t), (Px $r), (Px $b)) }
function Col([string]$Hex) { [System.Drawing.ColorTranslator]::FromHtml($Hex) }

# ArmoryDB palette (same as the tracker's phone setup page).
$C = @{
    Bg = '#14171c'; Card = '#1c252c'; Input = '#11161b'; Line = '#2e3a44'; Button = '#26323b'; ButtonHover = '#30404b'
    Accent = '#75803a'; AccentHover = '#8a9646'; Label = '#aeb771'; Text = '#e2e7e9'; Title = '#f5f6ee'
    Muted = '#94a4ab'; Dim = '#677a83'; Ok = '#7fd19b'; Warn = '#f5c27a'; Err = '#f08a7e'; Info = '#9cc3d5'
}
$FontUi    = New-Object System.Drawing.Font('Segoe UI', 9.5)
$FontField = New-Object System.Drawing.Font('Segoe UI', 9)
$FontSmall = New-Object System.Drawing.Font('Segoe UI', 8.25, [System.Drawing.FontStyle]::Bold)
$FontTitle = New-Object System.Drawing.Font('Segoe UI Semibold', 15)
$FontStep  = New-Object System.Drawing.Font('Segoe UI', 9.5)
$FontMono  = New-Object System.Drawing.Font('Consolas', 8.5)

$G = $G + @{ Circle = [string][char]0x25CB }

function New-Label([string]$Text, $Font = $FontUi, [string]$Color = $C.Text) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text
    $l.Font = $Font
    $l.ForeColor = Col $Color
    $l.AutoSize = $true
    $l.Margin = Pad 0 0 0 0
    return $l
}

function New-Button([string]$Text, [bool]$Primary = $false) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.FlatStyle = 'Flat'
    $b.AutoSize = $true
    $b.AutoSizeMode = 'GrowAndShrink'
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.ForeColor = Col $C.Title
    $b.UseVisualStyleBackColor = $false
    $b.Margin = Pad 8 0 0 0
    if ($Primary) {
        $b.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
        $b.Padding = Pad 20 7 20 7
    } else {
        $b.Font = $FontField
        $b.Padding = Pad 10 1 10 1
    }
    $b.MinimumSize = New-Object System.Drawing.Size((Px 100), 0)
    Set-ButtonLook $b $Primary $true
    return $b
}

# Buttons keep their colours when locked (a disabled flat button is unreadable on a dark background).
function Set-ButtonLook($Button, [bool]$Primary, [bool]$Active) {
    if ($Primary -and $Active) {
        $Button.BackColor = Col $C.Accent; $Button.ForeColor = Col $C.Title
        $Button.FlatAppearance.BorderColor = Col $C.AccentHover; $Button.FlatAppearance.MouseOverBackColor = Col $C.AccentHover
    } elseif ($Primary) {
        $Button.BackColor = Col $C.Button; $Button.ForeColor = Col $C.Muted
        $Button.FlatAppearance.BorderColor = Col $C.Line; $Button.FlatAppearance.MouseOverBackColor = Col $C.Button
    } else {
        $Button.BackColor = Col $C.Button; $Button.ForeColor = Col $(if ($Active) { $C.Title } else { $C.Dim })
        $Button.FlatAppearance.BorderColor = Col $C.Line
        $Button.FlatAppearance.MouseOverBackColor = Col $(if ($Active) { $C.ButtonHover } else { $C.Button })
    }
    $Button.Cursor = $(if ($Active) { [System.Windows.Forms.Cursors]::Hand } else { [System.Windows.Forms.Cursors]::Default })
}

function Set-InputStyle($Control) {
    $Control.BackColor = Col $C.Input
    $Control.ForeColor = Col $C.Text
    $Control.Font = $FontUi
    $Control.Dock = 'Fill'
    $Control.Margin = Pad 0 0 0 0
    if ($Control -is [System.Windows.Forms.TextBox]) { $Control.BorderStyle = 'FixedSingle' }
    if ($Control -is [System.Windows.Forms.ComboBox]) {
        $Control.FlatStyle = 'Flat'
        try { [void][ArmoryNative.Theme]::SetWindowTheme($Control.Handle, 'DarkMode_CFD', $null) } catch { }
    }
}

# Text set in code is shown highlighted in an editable combo box; clear that.
function Clear-ComboHighlight($Combo) { if (-not $Combo.Focused) { $Combo.SelectionStart = $Combo.Text.Length; $Combo.SelectionLength = 0 } }

# Labels that wrap with their column width.
$script:wrapLabels = New-Object System.Collections.ArrayList
function Register-Wrap($Label) { [void]$script:wrapLabels.Add($Label); return $Label }

function New-Stack([int]$Columns = 1) {
    $t = New-Object System.Windows.Forms.TableLayoutPanel
    $t.ColumnCount = $Columns
    $t.AutoSize = $true
    $t.AutoSizeMode = 'GrowAndShrink'
    $t.Dock = 'Fill'
    $t.Margin = Pad 0 0 0 0
    $t.Padding = Pad 0 0 0 0
    return $t
}
function Add-Row($Stack, $Control, $Side = $null, [string]$Height = 'AutoSize') {
    $row = $Stack.RowCount
    $Stack.RowCount = $row + 1
    if ($Height -eq 'Fill') { [void]$Stack.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100))) }
    else { [void]$Stack.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))) }
    $Stack.Controls.Add($Control, 0, $row)
    if ($Side) { $Stack.Controls.Add($Side, 1, $row) }
    elseif ($Stack.ColumnCount -gt 1) { $Stack.SetColumnSpan($Control, $Stack.ColumnCount) }
}

# A card: small uppercase title, then rows of [field (fills)] [side control (auto)].
function New-Card([string]$Title, [int]$BottomGap = 10) {
    $card = New-Stack 2
    $card.BackColor = Col $C.Card
    $card.Padding = Pad 16 12 16 14
    $card.Margin = Pad 0 0 0 $BottomGap
    [void]$card.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
    [void]$card.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('AutoSize')))
    $head = New-Label $Title.ToUpper() $FontSmall $C.Label
    $head.Margin = Pad 0 0 0 2
    Add-Row $card $head
    return $card
}

function New-FieldLabel([string]$Text) {
    $l = New-Label $Text $FontField $C.Muted
    $l.Margin = Pad 0 8 0 4
    return $l
}

function New-Hint {
    $l = Register-Wrap (New-Label '' $FontField $C.Muted)
    $l.Margin = Pad 0 6 0 0
    $l.Visible = $false
    return $l
}

$HintStyles = @{ ok = @($C.Ok, $G.Check); warn = @($C.Warn, '!'); err = @($C.Err, $G.Cross); info = @($C.Info, $G.Dot) }
function Set-Hint($Label, [string]$Kind, [string]$Text) {
    if (-not $Text) { $Label.Visible = $false; return }
    $style = $HintStyles[$Kind]
    $Label.ForeColor = Col $style[0]
    $Label.Text = "$($style[1])  $Text"
    $Label.Visible = $true
}

# ================================================================ window: layout

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ArmoryDB - Tracker setup'
$form.BackColor = Col $C.Bg
$form.ForeColor = Col $C.Text
$form.Font = $FontUi
$form.StartPosition = 'CenterScreen'
$form.SizeGripStyle = 'Hide'
$form.Padding = Pad 24 18 24 18
$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.ClientSize = New-Object System.Drawing.Size([Math]::Min((Px 1040), $workArea.Width - (Px 40)), (Px 640))
$form.Add_HandleCreated({ try { $on = 1; [void][ArmoryNative.Theme]::DwmSetWindowAttribute($form.Handle, 20, [ref]$on, 4) } catch { } })

# Two columns: setup on the left, activity on the right.
$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = 'Fill'
$root.ColumnCount = 2
$root.RowCount = 1
[void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 55)))
[void]$root.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 45)))
[void]$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100)))
$form.Controls.Add($root)

$left = New-Stack 1
$left.AutoSize = $false
$left.Margin = Pad 0 0 12 0
[void]$left.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$right = New-Stack 1
$right.AutoSize = $false
$right.Margin = Pad 12 0 0 0
[void]$right.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$root.Controls.Add($left, 0, 0)
$root.Controls.Add($right, 1, 0)

# ---- left: header
$brand = New-Label ("{0}  ARMORYDB  {1}  10RCDG" -f $G.Dot, $G.Dot) $FontSmall $C.AccentHover
$title = New-Label 'GPS tracker setup' $FontTitle $C.Title
$title.Margin = Pad 0 2 0 0
$subtitle = Register-Wrap (New-Label 'Connect the ESP32 tracker to the hotspot and this laptop. Plug it in by USB first.' $FontField $C.Muted)
$subtitle.Margin = Pad 0 2 0 14
Add-Row $left $brand
Add-Row $left $title
Add-Row $left $subtitle

# ---- left: 1 Hotspot
$card1 = New-Card '1   Hotspot'
Add-Row $card1 (New-FieldLabel 'Wi-Fi name (2.4 GHz)')
$cbSsid = New-Object System.Windows.Forms.ComboBox; Set-InputStyle $cbSsid; $cbSsid.DropDownStyle = 'DropDown'
$btnScan = New-Button 'Scan again'
Add-Row $card1 $cbSsid $btnScan
$hintSsid = New-Hint; Add-Row $card1 $hintSsid
Add-Row $card1 (New-FieldLabel 'Password')
$tbPass = New-Object System.Windows.Forms.TextBox; Set-InputStyle $tbPass; $tbPass.UseSystemPasswordChar = $true
$chkShow = New-Object System.Windows.Forms.CheckBox
$chkShow.Text = 'Show'; $chkShow.Font = $FontField; $chkShow.ForeColor = Col $C.Muted; $chkShow.AutoSize = $true; $chkShow.Margin = Pad 10 3 0 0
Add-Row $card1 $tbPass $chkShow
$hintPass = New-Hint; Add-Row $card1 $hintPass
Add-Row $left $card1

# ---- left: 2 This laptop
$card2 = New-Card '2   This laptop'
Add-Row $card2 (New-FieldLabel 'IP address on the hotspot (detected automatically)')
$tbIp = New-Object System.Windows.Forms.TextBox; Set-InputStyle $tbIp
$btnIp = New-Button 'Detect again'
Add-Row $card2 $tbIp $btnIp
$hintLaptop = New-Hint; Add-Row $card2 $hintLaptop
$hintBackend = New-Hint; Add-Row $card2 $hintBackend
Add-Row $left $card2

# ---- left: 3 Tracker
$card3 = New-Card '3   Tracker' 0
Add-Row $card3 (New-FieldLabel 'Firearm (only firearms with GPS tracking on are listed)')
$cbFirearm = New-Object System.Windows.Forms.ComboBox; Set-InputStyle $cbFirearm; $cbFirearm.DropDownStyle = 'DropDown'
Add-Row $card3 $cbFirearm
$hintFirearm = New-Hint; Add-Row $card3 $hintFirearm
Add-Row $card3 (New-FieldLabel 'USB port')
$cbPort = New-Object System.Windows.Forms.ComboBox; Set-InputStyle $cbPort; $cbPort.DropDownStyle = 'DropDown'
$cbPort.Add_KeyPress({ param($src, $e) $e.Handled = $true })  # pick-only (DropDownList cannot be drawn dark)
$btnPorts = New-Button 'Refresh'
Add-Row $card3 $cbPort $btnPorts
$hintPort = New-Hint; Add-Row $card3 $hintPort
Add-Row $left $card3

# ---- left: spacer, then the action bar at the bottom
Add-Row $left (New-Object System.Windows.Forms.Panel -Property @{ Margin = (Pad 0 0 0 0); Height = 1 }) $null 'Fill'
$actions = New-Stack 2
$actions.Margin = Pad 0 14 0 0
[void]$actions.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
[void]$actions.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('AutoSize')))
$note = Register-Wrap (New-Label 'When done, close this window: live tracker status continues in the terminal.' $FontField $C.Dim)
$note.Anchor = 'Left'
$btnSave = New-Button 'Save to tracker' $true
$btnSave.Margin = Pad 12 0 0 0
$actions.Controls.Add($note, 0, 0)
$actions.Controls.Add($btnSave, 1, 0)
Add-Row $left $actions
$form.AcceptButton = $btnSave

# ---- right: activity card (fills the column height)
$activity = New-Stack 1
$activity.AutoSize = $false
$activity.BackColor = Col $C.Card
$activity.Padding = Pad 18 14 18 16
[void]$activity.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$right.RowCount = 1
[void]$right.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100)))
$right.Controls.Add($activity, 0, 0)

$actHead = New-Label 'ACTIVITY' $FontSmall $C.Label
$actHead.Margin = Pad 0 0 0 10
Add-Row $activity $actHead

# Steps
$script:steps = @()
foreach ($stepText in @('Write the settings', 'Build and upload the firmware', 'Check the Wi-Fi connection', 'Check the GPS module', 'Check the link to this laptop')) {
    $row = New-Stack 2
    $row.Margin = Pad 0 3 0 3
    [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('AutoSize')))
    [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
    $icon = New-Label $G.Circle $FontStep $C.Dim
    $icon.MinimumSize = New-Object System.Drawing.Size((Px 22), 0)
    $text = New-Label $stepText $FontStep $C.Muted
    $row.Controls.Add($icon, 0, 0)
    $row.Controls.Add($text, 1, 0)
    Add-Row $activity $row
    $script:steps += , @($icon, $text)
}

function Set-Step([int]$Index, [string]$State) {
    $icon = $script:steps[$Index][0]; $text = $script:steps[$Index][1]
    switch ($State) {
        'pending' { $icon.Text = $G.Circle; $icon.ForeColor = Col $C.Dim;         $text.ForeColor = Col $C.Muted }
        'running' { $icon.Text = $G.Dot;    $icon.ForeColor = Col $C.AccentHover; $text.ForeColor = Col $C.Title }
        'done'    { $icon.Text = $G.Check;  $icon.ForeColor = Col $C.Ok;          $text.ForeColor = Col $C.Text }
        'failed'  { $icon.Text = $G.Cross;  $icon.ForeColor = Col $C.Err;         $text.ForeColor = Col $C.Err }
    }
}
function Reset-Steps { 0..($script:steps.Count - 1) | ForEach-Object { Set-Step $_ 'pending' } }

# Progress: stage text + thin bar
$stageText = New-Label 'Ready. Fill in the left side, then press Save to tracker.' $FontField $C.Muted
$stageText.Margin = Pad 0 12 0 6
Register-Wrap $stageText | Out-Null
Add-Row $activity $stageText
$barOuter = New-Object System.Windows.Forms.Panel
$barOuter.Height = Px 4; $barOuter.Dock = 'Top'; $barOuter.BackColor = Col $C.Line; $barOuter.Margin = Pad 0 0 0 0
$barInner = New-Object System.Windows.Forms.Panel
$barInner.BackColor = Col $C.AccentHover; $barInner.Height = Px 4; $barInner.Width = 0; $barInner.Location = New-Object System.Drawing.Point(0, 0)
$barOuter.Controls.Add($barInner)
Add-Row $activity $barOuter

# Result banner
$banner = New-Stack 1
$banner.Padding = Pad 12 9 12 9
$banner.Margin = Pad 0 14 0 0
$banner.Visible = $false
[void]$banner.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$bannerText = Register-Wrap (New-Label '' (New-Object System.Drawing.Font('Segoe UI Semibold', 9.5)) $C.Text)
$banner.Controls.Add($bannerText, 0, 0)
Add-Row $activity $banner

# Output: colour-coded, scrolls with the mouse wheel, no scrollbar drawn. "Watch live" (optional)
# streams the tracker's status here, like the terminal does after the window closes.
$outBar = New-Stack 2
$outBar.Margin = Pad 0 16 0 6
[void]$outBar.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
[void]$outBar.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('AutoSize')))
$outHead = New-Label 'TRACKER OUTPUT' $FontSmall $C.Dim
$outHead.Anchor = 'Left'
$btnLive = New-Button 'Watch live'
$outBar.Controls.Add($outHead, 0, 0)
$outBar.Controls.Add($btnLive, 1, 0)
Add-Row $activity $outBar

$tbLog = New-Object System.Windows.Forms.RichTextBox
$tbLog.ReadOnly = $true; $tbLog.ScrollBars = 'None'; $tbLog.WordWrap = $true; $tbLog.DetectUrls = $false
$tbLog.Font = $FontMono; $tbLog.BackColor = Col $C.Input; $tbLog.ForeColor = Col $C.Muted; $tbLog.BorderStyle = 'None'
$tbLog.Dock = 'Fill'; $tbLog.Margin = Pad 0 0 0 0; $tbLog.TabStop = $false
$logFrame = New-Object System.Windows.Forms.Panel
$logFrame.Dock = 'Fill'; $logFrame.BackColor = Col $C.Input; $logFrame.Padding = Pad 10 8 10 8; $logFrame.Margin = Pad 0 0 0 0
$logFrame.Controls.Add($tbLog)
Add-Row $activity $logFrame $null 'Fill'

# Scrolling without scrollbars: the wheel scrolls the text directly (EM_LINESCROLL). New lines keep
# the view at the bottom only while you are at the bottom, so reading older lines is not interrupted.
$script:followLog = $true
function Get-FirstVisibleLine { return [int][ArmoryNative.Theme]::SendMessage($tbLog.Handle, 0xCE, [IntPtr]::Zero, [IntPtr]::Zero) }
function Move-LogBy([int]$Lines) { [void][ArmoryNative.Theme]::SendMessage($tbLog.Handle, 0xB6, [IntPtr]::Zero, [IntPtr]$Lines) }
function Move-LogToEnd { $tbLog.SelectionStart = $tbLog.TextLength; $tbLog.SelectionLength = 0; $tbLog.ScrollToCaret() }
function Test-LogAtEnd {
    if ($tbLog.TextLength -eq 0) { return $true }
    # At the end when the last character is inside the visible area.
    $lastPos = $tbLog.GetPositionFromCharIndex($tbLog.TextLength - 1)
    return ($lastPos.Y -lt $tbLog.ClientSize.Height)
}
$tbLog.Add_MouseWheel({
    param($src, $e)
    Move-LogBy (-[int]($e.Delta / 120) * 3)
    $script:followLog = Test-LogAtEnd
    if ($e -is [System.Windows.Forms.HandledMouseEventArgs]) { $e.Handled = $true }
})
$tbLog.Add_KeyUp({ $script:followLog = Test-LogAtEnd })

function Get-LogColor([string]$Line) {
    switch (Get-LineColor $Line) { 'Red' { $C.Err } 'Green' { $C.Ok } 'Yellow' { $C.Warn } 'Cyan' { $C.Info } default { $C.Muted } }
}
function Write-Log([string]$Text, [string]$Color = '') {
    if (-not $Color) { $Color = Get-LogColor $Text }
    $first = Get-FirstVisibleLine
    $tbLog.SelectionStart = $tbLog.TextLength
    $tbLog.SelectionLength = 0
    $tbLog.SelectionColor = Col $Color
    $tbLog.SelectedText = $(if ($tbLog.TextLength -gt 0) { "`n$Text" } else { $Text })
    if ($script:followLog) { Move-LogToEnd } else { Move-LogBy ($first - (Get-FirstVisibleLine)) }
}
function Clear-Log { $tbLog.Clear(); $script:followLog = $true }
Write-Log 'Messages from the build, the upload and the tracker appear here.' $C.Dim

function Show-Banner([string]$Kind, [string]$Text) {
    $map = @{
        ok   = @('#16301f', $C.Ok,   $G.Check)
        warn = @('#352b1a', $C.Warn, '!')
        err  = @('#3a1d1b', $C.Err,  $G.Cross)
        info = @('#18262f', $C.Info, $G.Dot)
    }
    $style = $map[$Kind]
    $banner.BackColor = Col $style[0]
    $bannerText.ForeColor = Col $style[1]
    $bannerText.Text = "$($style[2])  $Text"
    $banner.Visible = $true
    Update-Wrap
}

function Update-Wrap {
    foreach ($l in $script:wrapLabels) {
        $container = $l.Parent
        if (-not $container) { continue }
        $width = $container.ClientSize.Width - $container.Padding.Horizontal - (Px 2)
        if ($l -eq $note) { $width = $actions.ClientSize.Width - $btnSave.Width - (Px 24) }
        $l.MaximumSize = New-Object System.Drawing.Size([Math]::Max((Px 140), $width), 0)
    }
    $barInner.Height = $barOuter.Height
}

# The window is as tall as the setup column needs, so nothing ever scrolls.
function Fit-Height {
    $needed = $left.GetPreferredSize((New-Object System.Drawing.Size($left.Width, 0))).Height + $form.Padding.Vertical + (Px 6)
    $max = $workArea.Height - (Px 40)
    $height = [Math]::Min([Math]::Max($needed, $form.ClientSize.Height), $max)
    $form.ClientSize = New-Object System.Drawing.Size($form.ClientSize.Width, $height)
    $chrome = $form.Height - $form.ClientSize.Height
    $form.MinimumSize = New-Object System.Drawing.Size((Px 860), [Math]::Min($needed + $chrome, $max + $chrome))
}

# Form.CenterToScreen() is protected (not callable from PowerShell), so centre on the work area here.
function Move-ToCenter {
    $x = $workArea.X + [Math]::Max(0, [int](($workArea.Width - $form.Width) / 2))
    $y = $workArea.Y + [Math]::Max(0, [int](($workArea.Height - $form.Height) / 2))
    $form.Location = New-Object System.Drawing.Point($x, $y)
}

$form.Add_Resize({
    Update-Wrap
    foreach ($combo in @($cbSsid, $cbFirearm, $cbPort)) { Clear-ComboHighlight $combo }
})

# ================================================================ window: progress bar

$script:marquee = $false
$script:marqueePos = 0
$animTimer = New-Object System.Windows.Forms.Timer
$animTimer.Interval = 30
$animTimer.Add_Tick({
    if (-not $script:marquee) { return }
    $w = $barOuter.ClientSize.Width
    $barInner.Width = [int]($w * 0.25)
    $script:marqueePos = ($script:marqueePos + (Px 6)) % ($w + $barInner.Width)
    $barInner.Left = $script:marqueePos - $barInner.Width
})

function Set-Stage([string]$Text, [double]$Percent = -1) {
    $stageText.Text = $Text
    $stageText.ForeColor = Col $C.Text
    if ($Percent -lt 0) {
        $script:marquee = $true
        $animTimer.Start()
    } else {
        $script:marquee = $false
        $barInner.Left = 0
        $barInner.Width = [int]($barOuter.ClientSize.Width * [Math]::Min(100, $Percent) / 100)
    }
}
function Stop-Stage([string]$Text, [bool]$Full) {
    $script:marquee = $false
    $animTimer.Stop()
    $barInner.Left = 0
    $barInner.Width = $(if ($Full) { $barOuter.ClientSize.Width } else { 0 })
    $stageText.Text = $Text
    $stageText.ForeColor = Col $C.Muted
}

# ================================================================ window: detection into the fields

$script:networks = @{}

function Update-SsidHint {
    $ssid = $cbSsid.Text.Trim()
    if (-not $ssid) { Set-Hint $hintSsid 'info' 'Pick or type the hotspot name.'; return }
    if ($script:networks.Count -gt 0 -and -not $script:networks.Contains($ssid)) {
        Set-Hint $hintSsid 'warn' "'$ssid' is not in range right now. Is the phone hotspot on?"
    } elseif ($script:networks.Contains($ssid) -and -not $script:networks[$ssid]) {
        Set-Hint $hintSsid 'warn' "'$ssid' is only on 5 GHz. Turn on 2.4 GHz on the phone (iPhone: Maximize Compatibility)."
    } elseif ($script:networks.Contains($ssid)) {
        Set-Hint $hintSsid 'ok' "'$ssid' is in range on 2.4 GHz."
    } else {
        Set-Hint $hintSsid '' ''
    }
    Update-Wrap
}

function Update-LaptopHints {
    $ssid = $cbSsid.Text.Trim()
    $laptop = Get-LaptopWifi
    if (-not $laptop.Ssid) {
        Set-Hint $hintLaptop 'err' 'This laptop is not on any Wi-Fi. Connect it to the hotspot, then press Detect again.'
    } elseif ($ssid -and $laptop.Ssid -ne $ssid) {
        Set-Hint $hintLaptop 'err' "This laptop is on '$($laptop.Ssid)', not '$ssid'. Connect it to the hotspot, then press Detect again."
    } else {
        Set-Hint $hintLaptop 'ok' "On '$($laptop.Ssid)' ($($laptop.Band))."
    }
    $ip = $tbIp.Text.Trim()
    if (-not $ip) {
        Set-Hint $hintBackend '' ''  # nothing to check until the address is known
    } elseif (Test-Backend $ip) {
        Set-Hint $hintBackend 'ok' 'Backend is running and reachable at this address.'
    } else {
        Set-Hint $hintBackend 'warn' 'Backend not reachable. Start it with: php artisan serve --host 0.0.0.0 --port 8000'
    }
    Update-Wrap
}

function Update-Networks {
    $keep = $cbSsid.Text.Trim()
    $script:networks = Get-VisibleNetworks
    $cbSsid.Items.Clear()
    foreach ($name in $script:networks.Keys) { [void]$cbSsid.Items.Add($name) }
    if ($keep) { $cbSsid.Text = $keep }
    else {
        $laptopWifi = (Get-LaptopWifi).Ssid
        $cbSsid.Text = $(if ($laptopWifi) { $laptopWifi } else { Get-ConfigDefine 'WIFI_SSID' })
        $script:autoSsid = $cbSsid.Text
    }
    Clear-ComboHighlight $cbSsid
    Update-SsidHint
}

# The password this laptop saved for the chosen Wi-Fi is filled in, unless one was typed by hand.
$script:passTyped = $false
$script:fillingPass = $false
function Update-Password {
    $ssid = $cbSsid.Text.Trim()
    if ($script:passTyped -and $tbPass.Text) { return }
    $saved = Get-SavedWifiPassword $ssid
    $script:fillingPass = $true
    $tbPass.Text = $saved
    $script:fillingPass = $false
    $script:passTyped = $false
    if ($saved) { Set-Hint $hintPass 'ok' "Filled in from this laptop's saved Wi-Fi '$ssid'." }
    elseif ($ssid) { Set-Hint $hintPass 'info' "Type the password of '$ssid' (this laptop has none saved for it)." }
    else { Set-Hint $hintPass '' '' }
    Update-Wrap
}
$tbPass.Add_TextChanged({
    if ($script:fillingPass) { return }
    $script:passTyped = $true
    if ($hintPass.Visible) { Set-Hint $hintPass '' ''; Update-Wrap }
})

function Update-Ip {
    $script:autoIp = Get-LaptopIp
    $tbIp.Text = $script:autoIp
    Update-LaptopHints
}

function Update-Ports {
    $keep = ($cbPort.Text -split '\s')[0]
    $cbPort.Items.Clear()
    $ports = @(Get-TrackerPorts)  # @() so one port still has .Count (Windows PowerShell 5.1)
    foreach ($p in $ports) { [void]$cbPort.Items.Add("$($p.Port)   $($p.Label)") }
    $script:portNames = Get-PortNames
    if ($ports.Count -gt 0) {
        # Keep the chosen port while it is still plugged in.
        $cbPort.SelectedIndex = [Math]::Max(0, [array]::IndexOf(@($ports | ForEach-Object { $_.Port }), $keep))
        Set-Hint $hintPort 'ok' "Tracker found on $(($cbPort.Text -split '\s')[0])."
    } else {
        $cbPort.Text = ''
        $script:nextSetupWifiCheck = [datetime]::MinValue
        Update-TrackerHint
    }
    Clear-ComboHighlight $cbPort
    Update-Wrap
}

# Without a USB cable the tracker can still be found: on the hotspot it reports to the backend over Wi-Fi,
# and when it could not join the hotspot its own setup Wi-Fi is on. Shown under the USB port.
$script:nextSetupWifiCheck = [datetime]::MinValue
$script:setupWifiOn = $false
function Update-TrackerHint {
    if (($cbPort.Text -split '\s')[0] -match '^COM\d+$') { return }  # on USB: "Tracker found on COMx" stays
    $ssid = Get-ConfigDefine 'WIFI_SSID'
    $report = Get-LastWifiReport (Get-DeviceId)
    $age = $(if ($report) { [int]((Get-Date) - $report.At).TotalSeconds } else { [int]::MaxValue })
    if ($age -gt 30 -and (Get-Date) -ge $script:nextSetupWifiCheck) {
        # netsh takes a moment, so look for the setup Wi-Fi only every 10 s while the tracker is silent.
        $script:nextSetupWifiCheck = (Get-Date).AddSeconds(10)
        $script:setupWifiOn = (Get-VisibleNetworks).Contains((Get-SetupWifiName))
    }
    if ($age -le 30) {
        $what = $(switch -Regex ($report.Text) {
            'satellites in view=(\d+), used=(\d+)' { "waiting for a GPS fix, $($Matches[1]) satellites in view"; break }
            '\[post\] HTTP 2\d\d' { 'sending positions'; break }
            '\[post\] HTTP (\d{3})' { "its last position got HTTP $($Matches[1])"; break }
            '\[gps\] fix' { 'GPS fix still weak'; break }
            '\[gps\] NO DATA' { 'no data from its GPS module'; break }
            default { 'just started' }
        })
        Set-Hint $hintPort 'ok' "Tracker on the hotspot: reported $age s ago over Wi-Fi ($what). Save sends new settings to it over Wi-Fi."
    } elseif ($script:setupWifiOn) {
        Set-Hint $hintPort 'warn' "The tracker is in phone setup mode (its Wi-Fi '$(Get-SetupWifiName)' is on): it could not join '$ssid', or its BOOT button was held 3 s. It goes back to '$ssid' by itself within 3 minutes."
    } elseif ($report -and $age -le 86400) {
        Set-Hint $hintPort 'warn' ("Tracker not on USB, and silent over Wi-Fi since {0:HH:mm:ss}. Is it powered, and in range of '{1}'?" -f $report.At, $ssid)
    } else {
        Set-Hint $hintPort 'err' 'No tracker found. Plug the ESP32 in with a USB data cable; it is picked up by itself.'
    }
    Update-Wrap
}

function Update-Firearms {
    $startedMysql = Start-MysqlIfStopped
    $cbFirearm.Items.Clear()
    $list = @(Get-TrackableFirearms)
    foreach ($f in $list) { [void]$cbFirearm.Items.Add($f) }
    $current = Get-ConfigDefine 'EQUIPMENT_ID'
    $match = $list | Where-Object { $_ -match "^$current - " } | Select-Object -First 1
    if ($match) { $cbFirearm.Text = $match }
    elseif ($list.Count -gt 0) { $cbFirearm.SelectedIndex = 0 }
    else { $cbFirearm.Text = $current }
    if ($list.Count -eq 0) {
        Set-Hint $hintFirearm 'warn' 'No firearm with GPS tracking on was found (is MySQL running?). The number above is used as typed.'
    } elseif ($startedMysql) {
        Set-Hint $hintFirearm 'info' 'MySQL was stopped, so it was started (positions are stored there).'
    } else {
        Set-Hint $hintFirearm '' ''
    }
    Clear-ComboHighlight $cbFirearm
    Update-Wrap
}

$chkShow.Add_CheckedChanged({ $tbPass.UseSystemPasswordChar = -not $chkShow.Checked })
$btnScan.Add_Click({ if (-not $script:busy) { Update-Networks; Update-Password; Update-LaptopHints } })
$btnIp.Add_Click({ if (-not $script:busy) { Update-Ip } })
$btnPorts.Add_Click({ if (-not $script:busy) { Update-Ports } })
$cbSsid.Add_Leave({ Update-SsidHint; Update-Password; Update-LaptopHints })
$cbSsid.Add_SelectedIndexChanged({ Update-SsidHint; Update-Password; Update-LaptopHints })
foreach ($combo in @($cbFirearm, $cbPort)) { $combo.Add_SelectedIndexChanged({ param($src) Clear-ComboHighlight $src }) }

# Plugging the tracker in or out, or this laptop joining another Wi-Fi, updates the fields by itself.
# A Wi-Fi name or IP address typed by hand is kept.
$script:portNames = ''
$script:netSignature = ''
$script:autoIp = ''
$script:autoSsid = ''
$watchTimer = New-Object System.Windows.Forms.Timer
$watchTimer.Interval = 1500
$watchTimer.Add_Tick({
    if ($script:busy) { return }
    $hadUsb = ($cbPort.Text -split '\s')[0] -match '^COM\d+$'
    if ((Get-PortNames) -ne $script:portNames) {
        Update-Ports
        $hasUsb = ($cbPort.Text -split '\s')[0] -match '^COM\d+$'
        if ($script:liveSource -eq 'usb' -and $script:live -and
            -not ([System.IO.Ports.SerialPort]::GetPortNames() -contains $script:live.PortName)) {
            # Unplugged (to run on a power bank, say), and reading the port did not notice: carry on over Wi-Fi.
            Stop-Live
            Write-Log 'The tracker was unplugged from USB.' $C.Warn
            Start-WifiLive
        } elseif ($script:liveSource -eq 'wifi' -and $hasUsb) {
            # Watching over Wi-Fi and the tracker is plugged in: switch to USB, which shows everything.
            Stop-Live
            Write-Log 'The tracker is plugged in by USB.' $C.Info
            Start-Live -Quiet
        } elseif (-not $script:liveSource -and $hadUsb -and -not $hasUsb) {
            Write-Log 'The tracker was unplugged from USB.' $C.Warn
            Start-WifiLive
        }
    } elseif (-not $hadUsb) {
        Update-TrackerHint  # how it is doing over Wi-Fi changes all the time
    }
    $signature = Get-NetworkSignature
    if ($signature -eq $script:netSignature) { return }
    $script:netSignature = $signature
    $laptopSsid = (Get-LaptopWifi).Ssid
    if ($laptopSsid -and $laptopSsid -ne $script:autoSsid -and $cbSsid.Text.Trim() -eq $script:autoSsid) {
        $script:autoSsid = $laptopSsid
        $cbSsid.Text = $laptopSsid
        Clear-ComboHighlight $cbSsid
        Update-Password
    }
    # What is in range changed too (a hotspot switched on): read the list again before judging the name.
    Update-Networks
    if ($tbIp.Text.Trim() -eq $script:autoIp) { Update-Ip } else { Update-LaptopHints }
})

# ================================================================ window: flash and verify

$script:proc = $null
$script:readPos = @{}
$script:serial = $null
$script:verifyUntil = [datetime]::MinValue
$script:serialBuffer = ''
$script:busy = $false
$script:run = @{}
$script:noPassOk = ''
$script:wifiMoveOk = ''

function Read-NewText([string]$Path) {
    if (-not (Test-Path $Path)) { return '' }
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        $start = 0; if ($script:readPos.ContainsKey($Path)) { $start = $script:readPos[$Path] }
        if ($fs.Length -le $start) { return '' }
        [void]$fs.Seek($start, 'Begin')
        $text = (New-Object IO.StreamReader($fs)).ReadToEnd()
        $script:readPos[$Path] = $fs.Length
        return $text
    } finally { $fs.Close() }
}

# Inputs stay readable while locked: text boxes go read-only, buttons only change colour.
function Set-Busy([bool]$Busy) {
    $script:busy = $Busy
    foreach ($t in @($tbPass, $tbIp)) { $t.ReadOnly = $Busy; $t.BackColor = Col $C.Input }
    $chkShow.AutoCheck = -not $Busy
    foreach ($b in @($btnScan, $btnIp, $btnPorts, $btnLive)) { Set-ButtonLook $b $false (-not $Busy) }
    Set-ButtonLook $btnSave $true (-not $Busy)
    $btnSave.Text = $(if ($Busy) { "Uploading$($G.Ellipsis)" } elseif ($script:run.Saved) { 'Save again' } else { 'Save to tracker' })
}
foreach ($combo in @($cbSsid, $cbFirearm)) { $combo.Add_KeyPress({ param($src, $e) if ($script:busy) { $e.Handled = $true } }) }
foreach ($combo in @($cbSsid, $cbFirearm, $cbPort)) { $combo.Add_DropDown({ param($src) if ($script:busy) { $src.DroppedDown = $false } }) }

# The window holds this lock while it uses the tracker's port: from Save until the check ends, and while
# watching live. Live-status terminals of this tool close the port while it is held (Start-ConsoleMonitor),
# so a terminal left open never blocks a flash or Watch live.
$script:portLock = New-Object System.Threading.Mutex($false, $PortLockName)
$script:holdingLock = $false
function Enter-PortLock {
    if ($script:holdingLock) { return $true }
    # Terminals only peek at the lock for an instant; another window would hold it for minutes.
    try { $script:holdingLock = $script:portLock.WaitOne(1500) } catch [System.Threading.AbandonedMutexException] { $script:holdingLock = $true }
    return $script:holdingLock
}
function Exit-PortLock {
    if (-not $script:holdingLock) { return }
    try { $script:portLock.ReleaseMutex() } catch { }
    $script:holdingLock = $false
}

# Terminals watching the port let go of it within a second once the lock is held.
function Wait-PortFree([string]$Port) {
    $until = (Get-Date).AddSeconds(5)
    while (-not (Test-PortFree $Port)) {
        if ((Get-Date) -gt $until) { return $false }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 200
    }
    return $true
}

function Complete-Run([string]$Kind, [string]$Text, [int]$FailedStep = -1) {
    if ($FailedStep -ge 0) { Set-Step $FailedStep 'failed' }
    $done = $Kind -eq 'ok'
    Stop-Stage $(if ($done) { 'Finished.' } else { 'Stopped.' }) $done
    Show-Banner $Kind $Text
    $script:run.Saved = $true
    Set-Busy $false
    $script:afterRun = $true
    # Once the tracker is on the Wi-Fi, keep showing its status (the port lock carries over): by USB, and
    # over Wi-Fi after it is unplugged. Also when watching live before Save, unless the run failed.
    if ($Kind -ne 'err' -and ($script:resumeLive -or $script:run.Joined)) { Start-Live -Quiet }
    elseif ($script:run.Wifi -and $script:resumeLive) { Start-WifiLive }
    else { Exit-PortLock }
    $script:resumeLive = $false
    $script:afterRun = $false
}

# ================================================================ window: optional live status

$script:live = $null          # the open USB port while watching by USB
$script:liveSource = ''       # '' (not watching), 'usb' or 'wifi'
$script:liveBuffer = ''
$script:resumeLive = $false
$script:startingLive = $false
$script:wifiState = @{}
$script:wifiQuietSince = Get-Date
$script:wifiHinted = $false

$liveTimer = New-Object System.Windows.Forms.Timer
$liveTimer.Interval = 250
$liveTimer.Add_Tick({
    if ($script:liveSource -eq 'wifi') { Read-WifiLive; return }
    try {
        $script:liveBuffer += $script:live.ReadExisting()
    } catch {
        # Unplugged (to run on a power bank, say): carry on over Wi-Fi.
        Stop-Live
        Write-Log 'The tracker was unplugged from USB.' $C.Warn
        Start-WifiLive
        return
    }
    while ($script:liveBuffer -match "^(.*?)\r?\n") {
        $line = $Matches[1].TrimEnd()
        $script:liveBuffer = $script:liveBuffer.Substring($Matches[0].Length)
        if (-not $line.Trim() -or $line -match '^\s*\.+\s*$') { continue }
        Write-Log ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $line) (Get-LogColor $line)
    }
})

# Without a USB cable the tracker is followed over Wi-Fi: it reports to the backend, which notes each
# report in backend\storage\logs\trackers.log.
function Start-WifiLive {
    Exit-PortLock
    $script:liveSource = 'wifi'
    $script:wifiState = @{}
    [void](Read-WifiLines $script:wifiState (Get-DeviceId))  # from now on
    $script:wifiQuietSince = Get-Date
    $script:wifiHinted = $false
    $outHead.Text = "TRACKER OUTPUT   $($G.Dot) LIVE OVER WI-FI"
    $outHead.ForeColor = Col $C.Ok
    $btnLive.Text = 'Stop watching'
    Write-Log "Watching $(Get-DeviceId) over Wi-Fi (no USB cable). It reports every 10 s while it waits for a GPS fix, and each position it sends." $C.Info
    $last = Get-LastWifiReport (Get-DeviceId)
    # Just after a Save the check already showed it.
    if ($last -and -not $script:afterRun -and ((Get-Date) - $last.At).TotalSeconds -le 60) { Write-Log ("{0:HH:mm:ss}  {1}" -f $last.At, $last.Text) (Get-LogColor $last.Text) }
    $script:followLog = $true
    Move-LogToEnd
    $liveTimer.Start()
}

function Read-WifiLive {
    $got = $false
    foreach ($entry in @(Read-WifiLines $script:wifiState (Get-DeviceId))) {
        Write-Log ("{0}  {1}" -f $entry.Time, $entry.Text) (Get-LogColor $entry.Text)
        $got = $true
    }
    if ($got) {
        $script:wifiQuietSince = Get-Date
        $script:wifiHinted = $false
    } elseif (-not $script:wifiHinted -and ((Get-Date) - $script:wifiQuietSince).TotalSeconds -gt 30) {
        $script:wifiHinted = $true
        Write-Log ("Nothing over Wi-Fi for 30 s. Is the tracker powered and on '{0}', and is the backend running?" -f (Get-ConfigDefine 'WIFI_SSID')) $C.Warn
    }
}

function Start-Live([switch]$Quiet) {
    $port = ($cbPort.Text -split '\s')[0]
    if ($port -notmatch '^COM\d+$') { Start-WifiLive; return }
    # Live-status terminals of this tool let go of the port while this window watches it.
    $script:startingLive = $true
    $problem = $null
    if (-not (Enter-PortLock)) {
        $problem = 'Another setup window is using the tracker. Close it, then press Watch live again.'
    } elseif (-not (Wait-PortFree $port)) {
        $problem = "$port is in use by another program (Arduino IDE Serial Monitor, arduino-cli monitor, PuTTY$($G.Ellipsis)). Close it, then press Watch live again."
    } else {
        try {
            $sp = Open-TrackerPort $port
        } catch {
            $problem = "Could not open ${port} for live status: $($_.Exception.Message) Close any other monitor that uses it."
        }
    }
    $script:startingLive = $false
    if ($problem) { Exit-PortLock; Show-Banner 'err' "$problem Watching over Wi-Fi meanwhile."; Start-WifiLive; return }
    $script:live = $sp
    $script:liveSource = 'usb'
    $script:liveBuffer = ''
    $outHead.Text = "TRACKER OUTPUT   $($G.Dot) LIVE BY USB"
    $outHead.ForeColor = Col $C.Ok
    $btnLive.Text = 'Stop watching'
    Write-Log "Watching the tracker live on $port. Unplug it and this carries on over Wi-Fi." $C.Info
    $script:followLog = $true
    Move-LogToEnd
    $liveTimer.Start()
}

function Stop-Live([switch]$KeepLock) {
    $liveTimer.Stop()
    try { if ($script:live -and $script:live.IsOpen) { $script:live.Close() } } catch { }
    $script:live = $null
    $script:liveSource = ''
    if (-not $KeepLock) { Exit-PortLock }
    $outHead.Text = 'TRACKER OUTPUT'
    $outHead.ForeColor = Col $C.Dim
    $btnLive.Text = 'Watch live'
}

$btnLive.Add_Click({
    if ($script:busy -or $script:startingLive) { return }
    if ($script:liveSource) { Stop-Live; Write-Log 'Stopped watching.' $C.Dim }
    else { Start-Live }
})

# Lines worth showing from arduino-cli / esptool; the rest (hundreds of "Writing at") is the progress bar.
$KeepLine = 'Sketch uses|Global variables|Connecting|Chip is|Chip type|Erasing|Erase|Wrote|Hash of data|Hard resetting|error|Error|fail|Failed|fatal|No such|not found|denied|busy'

$flashTimer = New-Object System.Windows.Forms.Timer
$flashTimer.Interval = 300
$flashTimer.Add_Tick({
    foreach ($f in @($OutLog, $ErrLog)) {
        $t = Read-NewText $f
        if (-not $t) { continue }
        foreach ($chunk in ($t -split "`n")) {
            $line = ($chunk -split "`r" | Where-Object { $_.Trim() } | Select-Object -Last 1)
            if (-not $line) { continue }
            $line = $line.TrimEnd()
            if ($line -match 'Writing at .*?(\d+(?:\.\d+)?)%') {
                $pct = [double]$Matches[1]
                Set-Stage ("Uploading the firmware   {0:0}%" -f $pct) $pct
                continue
            }
            if ($f -eq $ErrLog -or $line -match $KeepLine) { Write-Log $line }
            if ($line -match '^Sketch uses') {
                Set-Stage $(if ($script:run.Wifi) { "Firmware built. Handing it to the backend$($G.Ellipsis)" } else { "Firmware built. Connecting to the tracker$($G.Ellipsis)" })
            }
            elseif ($line -match '^Connecting') { Set-Stage "Connecting to the tracker (if this stalls, hold its BOOT button)$($G.Ellipsis)" }
            elseif ($line -match 'Erasing|Chip erase') { Set-Stage "Erasing the old settings$($G.Ellipsis)" }
            elseif ($line -match 'Hash of data verified') { Set-Stage 'Upload verified.' 100 }
        }
    }
    if ($script:proc -and $script:proc.HasExited) {
        $flashTimer.Stop()
        if ($script:proc.ExitCode -eq 0 -and $script:run.Wifi) {
            try { Publish-Firmware $script:run.Build } catch {
                Complete-Run 'err' "The firmware was built, but could not be handed to the backend: $($_.Exception.Message)" 1
                return
            }
            Write-Log "The new firmware waits on this laptop. The tracker takes it with its next report (every 5-10 s while it is on the hotspot)." $C.Info
            Set-Stage "Waiting for the tracker to report and take the new firmware$($G.Ellipsis)"
            Start-WifiVerify
        } elseif ($script:proc.ExitCode -eq 0) {
            Set-Step 1 'done'
            Set-Step 2 'running'
            Set-Stage "Restarting the tracker and waiting for its Wi-Fi$($G.Ellipsis)"
            Start-Verify
        } elseif ($script:run.Wifi) {
            Complete-Run 'err' 'The firmware build failed (see the output).' 1
        } else {
            Complete-Run 'err' 'Upload failed. Check the USB cable and the port, then try again.' 1
        }
    }
})

# What one tracker line says once its Wi-Fi is in: @(topic, kind, text), or $null to keep reading.
# Topic 'gps' is the GPS module (step 4), 'link' is reaching this laptop (step 5); a [post] line (it has
# a fix and sent a position) answers both.
function Get-TrackerVerdict([string]$Line) {
    $serve = "is the backend running (php artisan serve --host 0.0.0.0 --port $ApiPort) and this laptop on the hotspot?"
    if ($Line -match '\[gps\] NO DATA') { return @('gps', 'warn', 'no data comes from its GPS module: check GPS TX to D18, GND and power (header pins soldered)') }
    if ($Line -match '\[gps\] GARBLED') { return @('gps', 'warn', 'its GPS data is unreadable (wrong speed): find the speed with iot\firmware\gps_baud_finder') }
    if ($Line -match '\[gps\] no fix yet \(satellites in view=(\d+)') {
        $sky = $(if ([int]$Matches[1] -eq 0) { 'sees no satellites yet (normal indoors)' } else { "sees $($Matches[1]) satellites" })
        return @('gps', 'ok', "its GPS module is working and $sky; positions start once it has a fix under open sky")
    }
    if ($Line -match '\[gps\] fix (lost|too weak|has no valid)') { return @('gps', 'ok', 'its GPS module is working; the fix is still weak, so keep it under open sky') }
    if ($Line -match '\[link\] laptop reachable') { return @('link', 'ok', 'it reaches this laptop over Wi-Fi, so its status keeps showing here after you unplug it') }
    if ($Line -match '\[link\] laptop NOT reachable') { return @('link', 'warn', "it cannot reach this laptop: $serve") }
    if ($Line -match '\[link\] laptop answered HTTP 401') { return @('link', 'err', 'this laptop rejects its signature (the secret differs from backend\.env): press Save again') }
    if ($Line -match '\[link\] laptop answered HTTP 404') { return @('link', 'warn', 'the backend on this laptop is older than the firmware: update it (git pull), then press Save again') }
    if ($Line -match '\[link\] laptop answered HTTP (\d{3})') { return @('link', 'warn', "this laptop answered HTTP $($Matches[1]) (is MySQL running?)") }
    if ($Line -match '\[post\] HTTP 2\d\d') { return @('post', 'ok', 'the server on this laptop accepted its position') }
    if ($Line -match '\[post\] HTTP 401') { return @('post', 'err', 'the server rejected its position: the signing secret differs from backend\.env; press Save again') }
    if ($Line -match '\[post\] HTTP 409') { return @('post', 'warn', 'the server rejected its position: this firearm has no Active/Overdue transaction with GPS tracking on') }
    if ($Line -match '\[post\] HTTP 422') { return @('post', 'warn', 'the server rejected its position as invalid or too old') }
    if ($Line -match '\[post\] HTTP (?!429)(\d{3})') { return @('post', 'warn', "the server answered HTTP $($Matches[1]) to its position") }
    if ($Line -match '\[post\] transport error') { return @('post', 'warn', "it cannot reach this laptop: $serve") }
    return $null
}

function Get-StepState([object[]]$Verdict) {
    if (-not $Verdict) { return 'pending' }
    if ($Verdict[0] -eq 'ok') { return 'done' }
    return 'failed'
}

# The result of the check after flashing, from what the tracker said (Wi-Fi, GPS module, link to this laptop).
function Complete-Verify {
    $run = $script:run
    if (-not $run.Joined) {
        if ($run.WifiFailed) { Complete-Run 'err' "Saved, but the tracker could not join the Wi-Fi: $($run.WifiFailed)" 2 }
        else { Complete-Run 'warn' 'Saved and flashed, but the tracker did not report its Wi-Fi within 45 seconds.' 2 }
        return
    }
    $gps = $(if ($run.Gps) { $run.Gps } else { @('warn', 'its GPS module has not reported yet') })
    $link = $(if ($run.Link) { $run.Link } else { @('warn', "it has not reported to this laptop yet: is the backend running (php artisan serve --host 0.0.0.0 --port $ApiPort)?") })
    Set-Step 3 (Get-StepState $run.Gps)
    Set-Step 4 (Get-StepState $run.Link)
    $kinds = @($gps[0], $link[0])
    $kind = $(if ($kinds -contains 'err') { 'err' } elseif ($kinds -contains 'warn') { 'warn' } else { 'ok' })
    $sentences = @($gps[1], $link[1]) | ForEach-Object { $_.Substring(0, 1).ToUpper() + $_.Substring(1) + '.' }
    Complete-Run $kind ("$($run.Joined). " + ($sentences -join ' '))
}

# Saved over Wi-Fi: follow the tracker through the backend's log as it takes the new firmware, restarts
# into it and reports again.
function Start-WifiVerify {
    $script:run.Staged = $true
    $script:run.WifiState = @{}
    [void](Read-WifiLines $script:run.WifiState (Get-DeviceId))  # from now on
    $script:verifyUntil = (Get-Date).AddMinutes(4)
    $verifyTimer.Start()
}

function Step-WifiVerify {
    $finished = $false
    foreach ($entry in @(Read-WifiLines $script:run.WifiState (Get-DeviceId))) {
        if ($finished) { break }
        $line = $entry.Text
        Write-Log ("{0}  {1}" -f $entry.Time, $line) (Get-LogColor $line)
        if ($line -match 'cannot update over Wi-Fi') {
            $script:run.OldFirmware = $true
            $finished = $true
        } elseif (-not $script:run.Joined) {
            if ($line -match '\[ota\] new firmware offered') { Set-Stage "The tracker got the new firmware. Waiting for it to download it$($G.Ellipsis)" }
            elseif ($line -match '\[ota\] the tracker is downloading') { Set-Stage "The tracker is downloading and installing the new firmware$($G.Ellipsis)" }
            elseif ($line -match '\[ota\] (download failed|cannot install|install failed)') { Set-Stage "The tracker could not install it yet; it tries again in a minute$($G.Ellipsis)" }
            elseif ($line -match "\[boot\] started \(build $([regex]::Escape($script:run.Build))\)|\[ota\] the tracker runs the new firmware") {
                $script:run.Joined = "Saved over Wi-Fi. The tracker installed the new firmware and is back on '$($script:run.Ssid)'"
                $script:run.Link = @('ok', 'it reaches this laptop over Wi-Fi')
                Set-Step 1 'done'
                Set-Step 2 'done'
                Set-Step 3 'running'
                Set-Step 4 'done'
                Set-Stage "New firmware running. Checking the GPS module$($G.Ellipsis)"
                $script:verifyUntil = (Get-Date).AddSeconds(30)
            }
        } else {
            $verdict = Get-TrackerVerdict $line
            if ($verdict -and $verdict[0] -eq 'post') {
                $script:run.Gps = @('ok', 'it has a GPS fix')
                $script:run.Link = @($verdict[1], $verdict[2])
                $finished = $true
            } elseif ($verdict -and $verdict[0] -eq 'gps') {
                $script:run.Gps = @($verdict[1], $verdict[2])
                $finished = $true
            }
        }
    }
    if (-not $finished -and (Get-Date) -le $script:verifyUntil) { return }
    $verifyTimer.Stop()
    if ($script:run.OldFirmware) {
        Remove-PublishedFirmware
        Complete-Run 'err' 'The tracker still has firmware from before updates over Wi-Fi, so it cannot take this one. Plug it in by USB once and press Save; from then on Save also works over the hotspot.' 1
    } elseif (-not $script:run.Joined) {
        Complete-Run 'warn' 'The new firmware waits on this laptop: the tracker takes it the next time it reports over Wi-Fi (it is silent now; check its power). Keep the backend running.' 2
    } else {
        Complete-Verify
    }
}

$verifyTimer = New-Object System.Windows.Forms.Timer
$verifyTimer.Interval = 250
$verifyTimer.Add_Tick({
    if ($script:run.Wifi) { Step-WifiVerify; return }
    $finished = $false
    try { $script:serialBuffer += $script:serial.ReadExisting() } catch { }
    while (-not $finished -and $script:serialBuffer -match "^(.*?)\r?\n") {
        $line = $Matches[1]
        $script:serialBuffer = $script:serialBuffer.Substring($Matches[0].Length)
        if (-not $line.Trim() -or $line -match '^\s*\.+\s*$') { continue }
        Write-Log "tracker> $line"
        if ($script:run.Joined) {
            $verdict = Get-TrackerVerdict $line
            if (-not $verdict) { continue }
            if ($verdict[0] -eq 'post') {
                if (-not $script:run.Gps) { $script:run.Gps = @('ok', 'it has a GPS fix') }
                $script:run.Link = @($verdict[1], $verdict[2])
            } elseif ($verdict[0] -eq 'gps') {
                if (-not $script:run.Gps) { $script:run.Gps = @($verdict[1], $verdict[2]) }
            } else {
                $script:run.Link = @($verdict[1], $verdict[2])
            }
            Set-Step 3 (Get-StepState $script:run.Gps)
            if (-not $script:run.Link) {
                Set-Step 4 'running'
                Set-Stage "GPS module checked. Checking the link to this laptop$($G.Ellipsis)"
            }
            $finished = $script:run.Gps -and $script:run.Link
        } elseif ($line -match '\[wifi\] connected\s+ip=(\S+)') {
            # Wi-Fi is in. The GPS and the first report to this laptop follow within one send interval (5 s).
            $script:run.Joined = "Saved. The tracker joined '{0}' (address {1})" -f $script:run.Ssid, $Matches[1]
            Set-Step 2 'done'
            Set-Step 3 'running'
            Set-Stage "Wi-Fi connected. Checking the GPS module$($G.Ellipsis)"
            $script:verifyUntil = (Get-Date).AddSeconds(25)
        } elseif ($line -match '\[wifi\] failed - (.*)') {
            $script:run.WifiFailed = $Matches[1]
            $finished = $true
        }
    }
    if ($finished -or (Get-Date) -gt $script:verifyUntil) {
        $verifyTimer.Stop()
        try { $script:serial.Close() } catch { }
        Complete-Verify
    }
})

function Start-Verify {
    try {
        $script:serial = Open-TrackerPort $script:run.Port
    } catch {
        Complete-Run 'warn' "Saved and flashed, but $($script:run.Port) could not be opened to check the Wi-Fi: $($_.Exception.Message)" 2
        return
    }
    $script:serialBuffer = ''
    $script:verifyUntil = (Get-Date).AddSeconds(45)
    $verifyTimer.Start()
}

$btnSave.Add_Click({
    if ($script:busy) { return }
    $banner.Visible = $false
    $ssid = $cbSsid.Text.Trim()
    $pass = $tbPass.Text
    $ip = $tbIp.Text.Trim()
    $port = ($cbPort.Text -split '\s')[0]
    $parsed = $null

    if (-not $ssid) { Show-Banner 'err' 'Enter the hotspot Wi-Fi name.'; $cbSsid.Focus(); return }
    if ($pass.Length -gt 0 -and $pass.Length -lt 8) { Show-Banner 'err' 'A Wi-Fi password has at least 8 characters.'; $tbPass.Focus(); return }
    # An empty password only goes through on purpose (open hotspot): the second press confirms it.
    if (-not $pass -and $script:noPassOk -ne $ssid) {
        $script:noPassOk = $ssid
        Show-Banner 'warn' "No password for '$ssid'. Type it, or press Save again if this hotspot has none."
        $tbPass.Focus(); return
    }
    if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or -not [System.Net.IPAddress]::TryParse($ip, [ref]$parsed)) {
        Show-Banner 'err' "'$ip' is not a valid IP address. Connect the laptop to the hotspot and press Detect again."; $tbIp.Focus(); return
    }
    if ($cbFirearm.Text -notmatch '^\s*(\d+)') { Show-Banner 'err' 'Choose the firearm (its number comes first).'; $cbFirearm.Focus(); return }
    $equipment = [int]$Matches[1]
    # No USB cable: the firmware goes over Wi-Fi, through the backend, to a tracker that reports there.
    $wifi = $port -notmatch '^COM\d+$'
    if ($wifi) {
        if (-not (Get-LastWifiReport (Get-DeviceId))) {
            Show-Banner 'err' 'No tracker on USB, and none has reported over Wi-Fi yet. Plug the ESP32 in by USB; it is picked up by itself.'
            return
        }
        $current = Get-ConfigDefine 'WIFI_SSID'
        if ($current -and $current -ne $ssid -and $script:wifiMoveOk -ne $ssid) {
            $script:wifiMoveOk = $ssid
            Show-Banner 'warn' "The tracker is on '$current'. Sent over Wi-Fi, these settings move it to '$ssid'; if '$ssid' is out of its reach, it then needs the USB cable or its phone setup page. Press Save again to go ahead."
            return
        }
    }
    $cli = Find-ArduinoCli
    if (-not $cli) { Show-Banner 'err' 'arduino-cli was not found. Install it first (RUNNING_THE_SYSTEM.txt, step 5.1).'; return }

    # Pause live status now (the upload needs the USB port; over Wi-Fi the check shows the lines), resume
    # after the run (Complete-Run).
    $script:resumeLive = [bool]$script:liveSource
    if ($script:liveSource) { Stop-Live -KeepLock }

    # Take the upload lock, then wait for the port: live-status terminals of this tool let go of it.
    Set-Busy $true
    $problem = $null
    if (-not $wifi) {
        Set-Stage "Getting the USB port ready$($G.Ellipsis)"
        if (-not (Enter-PortLock)) {
            $problem = 'Another setup window is uploading to the tracker. Wait for it to finish, then press Save again.'
        } elseif (-not (Wait-PortFree $port)) {
            $problem = "$port is in use by another program (Arduino IDE Serial Monitor, arduino-cli monitor, PuTTY$($G.Ellipsis)). Close it, then press Save again."
        }
    }
    if ($problem) {
        Exit-PortLock
        Stop-Stage 'Stopped.' $false
        Show-Banner 'err' $problem
        Set-Busy $false
        if ($script:resumeLive) { Start-Live -Quiet }
        $script:resumeLive = $false
        return
    }

    $build = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:run = @{ Ssid = $ssid; Port = $port; Saved = $false; Wifi = $wifi; Build = $build }
    $script:steps[1][1].Text = $(if ($wifi) { 'Build the firmware and send it over Wi-Fi' } else { 'Build and upload the firmware' })
    $script:steps[2][1].Text = $(if ($wifi) { 'Tracker installs it and reports back' } else { 'Check the Wi-Fi connection' })
    Reset-Steps
    Clear-Log
    Set-Step 0 'running'
    try {
        Write-TrackerConfig $ssid $pass $ip $equipment $build
    } catch {
        Complete-Run 'err' "Could not write config.h: $($_.Exception.Message)" 0
        return
    }
    Set-Step 0 'done'
    Write-Log "Settings: Wi-Fi '$ssid', server http://${ip}:$ApiPort, firearm $equipment (build $build)"
    Write-Log $(if ($wifi) { 'No USB cable: the firmware goes to the tracker over Wi-Fi, through the backend on this laptop.' } else { "Uploading to $port (erases the old settings first)" })

    Set-Step 1 'running'
    Set-Busy $true
    Set-Stage "Building the firmware (about a minute)$($G.Ellipsis)"

    foreach ($f in @($OutLog, $ErrLog)) { Set-Content -Path $f -Value '' -Encoding ascii }
    $script:readPos = @{}
    $arguments = $(if ($wifi) {
        @('compile', '--fqbn', $Fqbn, '--output-dir', "`"$BuildDir`"", "`"$SketchDir`"")
    } else {
        @('compile', '--upload', '-p', $port, '--fqbn', $Fqbn, '--board-options', 'EraseFlash=all', "`"$SketchDir`"")
    })
    try {
        $script:proc = Start-Process -FilePath $cli -ArgumentList $arguments -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
        $null = $script:proc.Handle  # keeps ExitCode readable after the process ends
        $flashTimer.Start()
    } catch {
        Complete-Run 'err' "Could not start arduino-cli: $($_.Exception.Message)" 1
    }
})

$form.Add_FormClosing({
    param($src, $e)
    # Waiting for the tracker to take an update over Wi-Fi may close: the update keeps waiting on the backend.
    if ($script:busy -and -not $script:run.Staged) {
        $e.Cancel = $true
        Show-Banner 'warn' 'Please wait until the upload finishes. Closing now can leave the tracker half-flashed.'
        return
    }
    $script:monitorPort = ($cbPort.Text -split '\s')[0]
    Stop-Live
    $flashTimer.Stop(); $verifyTimer.Stop(); $animTimer.Stop(); $watchTimer.Stop()
    Exit-PortLock
    try { if ($script:serial -and $script:serial.IsOpen) { $script:serial.Close() } } catch { }
})

$form.Add_Shown({
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    Update-Wrap
    $form.Refresh()
    Update-Ports
    Update-Networks
    Update-Password
    Update-Ip
    $script:netSignature = Get-NetworkSignature
    Update-Firearms
    Update-Wrap
    Fit-Height
    Update-Wrap
    Move-ToCenter
    $form.Cursor = [System.Windows.Forms.Cursors]::Default
    [void]$tbPass.Focus()
    # No USB cable: show how the tracker is doing over Wi-Fi right away (there is no port to hold).
    if (($cbPort.Text -split '\s')[0] -notmatch '^COM\d+$') { Start-WifiLive }
    $watchTimer.Start()
})

# ================================================================ safety net

# Any unexpected error in the window is shown in the window itself; the window stays usable.
function Report-UiError([System.Exception]$Exception) {
    $message = $Exception.Message
    try {
        Write-Log "Internal error: $message"
        if ($script:busy -and -not ($script:proc -and -not $script:proc.HasExited)) {
            $flashTimer.Stop(); $verifyTimer.Stop()
            try { if ($script:serial -and $script:serial.IsOpen) { $script:serial.Close() } } catch { }
            Exit-PortLock
            Stop-Stage 'Stopped.' $false
            Set-Busy $false
        }
        Show-Banner 'err' "Something went wrong in this window: $message  You can try again."
    } catch {
        Write-Host "Tracker setup error: $message" -ForegroundColor Red
    }
}
[System.Windows.Forms.Application]::add_ThreadException({ param($src, $e) Report-UiError $e.Exception })

# ================================================================ run

$script:monitorPort = ''
Write-Host 'Tracker setup window is open. Close it when done to see live tracker status here.' -ForegroundColor DarkGray
try {
    [void]$form.ShowDialog()
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'ArmoryDB - Tracker setup') | Out-Null
} finally {
    $form.Dispose()
}

Start-ConsoleMonitor $script:monitorPort
