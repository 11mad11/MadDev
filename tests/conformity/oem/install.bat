@echo off
REM dockur runs this on the Windows guest's first interactive logon, as
REM Administrator. We use it to enable OpenSSH Server, install rene's
REM authorized_keys, and unlock the box for the rest of our automation
REM to drive over SSH.

set LOG=C:\OEM\install.log
echo === mad oem setup === > %LOG%
date /t >> %LOG%
time /t >> %LOG%

REM ---- OpenSSH Server ------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0" >> %LOG% 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Service -Name sshd -StartupType Automatic" >> %LOG% 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Service sshd" >> %LOG% 2>&1

REM Allow port 22 inbound (the install rule may not be enabled by default).
powershell -NoProfile -ExecutionPolicy Bypass -Command "New-NetFirewallRule -Name 'sshd' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue" >> %LOG% 2>&1

REM ---- authorized_keys for rene -------------------------------------
REM dockur creates the rene user as a LOCAL ADMINISTRATOR. For admin
REM users, Windows OpenSSH reads authorized_keys ONLY from
REM C:\ProgramData\ssh\administrators_authorized_keys (per
REM Match Group administrators / AuthorizedKeysFile in sshd_config_default).
mkdir C:\ProgramData\ssh 2>nul
copy /Y C:\OEM\rene.pub C:\ProgramData\ssh\administrators_authorized_keys >> %LOG% 2>&1
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" >> %LOG% 2>&1

REM Force pubkey auth (default sshd_config_default is mostly fine but
REM ensure the admin authorized_keys path is honored).
echo PubkeyAuthentication yes >> C:\ProgramData\ssh\sshd_config
echo PasswordAuthentication no >> C:\ProgramData\ssh\sshd_config

REM ---- restart sshd so the new keys take effect ---------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "Restart-Service sshd" >> %LOG% 2>&1

REM ---- ready marker -------------------------------------------------
echo READY > C:\OEM\ready.txt
echo === done === >> %LOG%
