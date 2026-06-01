# Post-OEM Windows setup. Runs over SSH after dockur finishes the
# unattended install + our install.bat enables OpenSSH. Idempotent.
#
# Installs the mad client toolchain (Git for Windows, Bun, Rust GNU
# toolchain) on the Windows VM, transfers the mad source from the
# LXC host via the SSH session, builds mad_wintap.dll, and prepares
# the SSH client config that points at the gateway container.

$ErrorActionPreference = 'Stop'
$ProgressPreference   = 'SilentlyContinue'

Write-Host "[mad-setup] Installing Git for Windows + Bun + Rust ..."

# Use Chocolatey for repeatability. Install if missing.
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = "$env:Path;C:\ProgramData\chocolatey\bin"
}

# Git for Windows ships an MSYS-based ssh.exe — required for mad's
# binary-safe stdin frame stream.
choco install -y --no-progress git
choco install -y --no-progress bun
choco install -y --no-progress rustup.install

# Make sure cargo/rustc/bun are visible in this shell.
$env:Path = "$env:Path;C:\Program Files\Git\usr\bin;$env:USERPROFILE\.bun\bin;$env:USERPROFILE\.cargo\bin"

rustup target add x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu

Write-Host "[mad-setup] Toolchain installed:"
git --version
& "$env:USERPROFILE\.bun\bin\bun.exe" --version
& "$env:USERPROFILE\.cargo\bin\cargo.exe" --version

Write-Host "[mad-setup] DONE"
