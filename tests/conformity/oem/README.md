# Windows-in-Docker setup

dockur/windows runs a full Windows 11 VM via QEMU/KVM inside the
container. We use it for the conformity bench's Windows-side client.

## How dockur picks up these scripts

dockur scans `/oem/install.bat` (mounted via the `./oem:/oem`
volume in `docker-compose.yml`) during image build and bakes it into
the Windows install. On first interactive logon as the configured
user (rene/madtest), the .bat runs as Administrator.

## What the scripts do

| File | Runs on | Job |
|---|---|---|
| `install.bat` | Windows guest, first boot, as Administrator | Enables OpenSSH Server, installs `rene.pub` (next to it) into `C:\ProgramData\ssh\administrators_authorized_keys`, opens firewall port 22, restarts sshd. |
| `setup-windows-client.ps1` | Windows guest, via SSH after install | Installs Chocolatey + Git for Windows + Bun + Rust GNU toolchain. |
| `setup-mad-windows.ps1` | Windows guest, via SSH after toolchain setup | git clone, bun install, fetch wintun.dll, cargo build mad_wintap.dll. |

After all three run, the Windows VM is ready to `mad tun join`. The
post-install steps are not in the OEM bake (so they can be iterated
without re-installing Windows) — they get piped in over SSH:

```sh
# from the LXC host:
ssh -p 2222 -i keys/rene rene@localhost \
    powershell -NoProfile -ExecutionPolicy Bypass -Command - \
    < oem/setup-windows-client.ps1
ssh -p 2222 -i keys/rene rene@localhost \
    powershell -NoProfile -ExecutionPolicy Bypass -Command - \
    < oem/setup-mad-windows.ps1
```

## Required pre-setup

`rene.pub` must sit alongside these scripts before `docker compose
build` reads the OEM folder. Generate it the same way as the other
test keys:

```sh
cd ../keys
ssh-keygen -t ed25519 -N "" -f rene -C "rene@mad-test"
cp rene.pub ../oem/rene.pub
```

(The compose's `gateway` service also expects `rene` to be a user
on the gateway. The auto-init script in `init/gateway-init.sh` does
not currently include rene — add `[rene]=ga` to the `USER_GROUPS`
map there, or `useradd` rene in the running gateway container
before joining.)

## Tested numbers

From a single LXC on Proxmox (16 cores, 16 GB):

| Path | Bandwidth |
|---|---|
| Windows guest → alice (TCP, 4 streams) | **252 Mbps** |
| alice → Windows guest (TCP, 4 streams) | **250 Mbps** |
| Windows guest → alice (UDP, 50 Mbps target) | 0 / 21374 lost |
| Cross-group (Windows-gA → carol-gB) | **blocked** ✓ |
