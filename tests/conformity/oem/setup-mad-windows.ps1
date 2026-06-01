# Post-OEM mad client setup, runs over SSH on the dockur Windows VM.
# Clones the mad repo, installs deps, fetches wintun.dll, builds
# mad_wintap.dll via the Rust GNU toolchain installed by
# `setup-windows-client.ps1`. Idempotent.

$ProgressPreference = 'SilentlyContinue'
$env:Path = "$env:Path;C:\Program Files\Git\cmd;C:\Users\rene\.cargo\bin"

function Run([string]$desc, [scriptblock]$block) {
    Write-Host ">> $desc"
    & $block 2>&1 | Out-Null
}

$repo = "$env:USERPROFILE\mad"
if (-not (Test-Path $repo)) {
    Set-Location $env:USERPROFILE
    cmd /c "git clone https://github.com/11mad11/MadDev.git mad >NUL 2>&1"
} else {
    Set-Location $repo
    cmd /c "git pull --rebase >NUL 2>&1"
}
Set-Location $repo
"==> mad checked out at $(cmd /c 'git rev-parse --short HEAD')"

Write-Host ">> bun install"
cmd /c "bun install >NUL 2>&1"

# wintun.dll (signed redistributable from wintun.net)
$vendor = "$repo\native\windows-tap\vendor"
if (-not (Test-Path "$vendor\wintun.dll")) {
    New-Item -ItemType Directory -Force $vendor | Out-Null
    Invoke-WebRequest 'https://www.wintun.net/builds/wintun-0.14.1.zip' -OutFile "$env:TEMP\wintun.zip"
    Expand-Archive "$env:TEMP\wintun.zip" -DestinationPath "$env:TEMP\wintun-ext" -Force
    Copy-Item "$env:TEMP\wintun-ext\wintun\bin\amd64\wintun.dll" $vendor -Force
}
"==> wintun.dll $((Get-Item "$vendor\wintun.dll").Length) bytes"

Write-Host ">> cargo build (release, GNU target)"
Set-Location "$repo\native\windows-tap"
cmd /c "cargo build --release --target x86_64-pc-windows-gnu 2>&1" | Select-Object -Last 3
$dll = "$repo\native\windows-tap\target\x86_64-pc-windows-gnu\release\mad_wintap.dll"
if (Test-Path $dll) {
    "==> mad_wintap.dll $((Get-Item $dll).Length) bytes"
} else {
    "FAIL: mad_wintap.dll not built"
    exit 1
}

# Clear cached extracted DLL so the new build is picked up
Remove-Item "$env:LOCALAPPDATA\mad\native\mad_wintap.dll" -Force -ErrorAction SilentlyContinue

"==> READY"
