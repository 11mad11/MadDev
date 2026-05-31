# mad

## 1.0.0-alpha.0

### Major Changes

- Complete rewrite as a Linux-native SSH gateway helper.

  The custom ssh2-based server, the separately-built Bun client, the Rust `native/` module, and the `ssh2` patch are all gone. In their place: one CLI (`/usr/bin/mad`) that runs as users' login shell via sshd's `ForceCommand`, plus a small privileged daemon (`mad daemon`) that owns kernel-touching ops (TAP allocation, CA signing, KRL maintenance, OTP minting). System `sshd` handles all transport and auth; mad's CA signs user certs that sshd accepts via `TrustedUserCAKeys`.

  Highlights:

  - **System sshd does auth.** Linux users + Linux groups. Permissions on TCP services are enforced by the kernel via setgid directories at `/run/mad/groups/<group>/` (mode 2770).
  - **TCP forwarding** through stock OpenSSH Unix-socket forwarding — `ssh -R /run/mad/groups/<g>/<svc>.sock:…` and `ssh -L … <svc>.sock`. Zero custom data-path code. Concurrent clients work naturally via SSH channel multiplexing.
  - **L2 VPN per group** via persistent TAP devices (`ip tuntap add user … group …`), allocated by the daemon, attached to a per-group bridge.
  - **OTP-driven self-service enrollment** via a dedicated `otp` Linux user whose ForceCommand is `mad enroll`.
  - **Full SSH CA** with monotonic serials, signed KRL at `/etc/ssh/mad_krl`, and revocation that takes effect on the gateway immediately (sshd reads `RevokedKeys` on every auth attempt) and on field devices on their next incoming tech connection (the wrapper script `mad-tech-handler` fetches a fresh KRL via the device's existing reverse-tunnel `ControlMaster` before piping each connection to local sshd).
  - **Field-device sharing** via `mad service install-ssh <group/device>` — a self-contained bash install script with the CA pubkey and initial signed KRL embedded, plus the socat-based wrapper and a shared `mad-tech` user keyed off the group as a cert principal.
  - **Dual-axis revocation.** `mad cert revoke` blocks device access (KRL); `mad user forget-keys` blocks gateway access (authorized_keys). `mad user lockout` does both. Gateway login uses `authorized_keys`, populated by mad on enrollment, so a missing/expired/revoked cert never locks anyone out of the gateway — they can SSH in with just their key and `mad cert refresh`.
  - **Idempotent ops.** `mad setup` provisions groups, dirs, CA, sshd snippet, systemd unit, and `/usr/bin/mad` wrapper, acting only on what's not already correct. `mad update` is `git pull --ff-only` + `bun install` + `mad setup` + `systemctl restart mad-daemon`.
  - **Runtime is bun** (not Node/tsx). `SO_PEERCRED` uses `bun:ffi`. No Rust, no patched ssh2.
  - **Cert validity** defaults to 520 weeks (10 years), configurable via `MAD_CERT_VALIDITY_WEEKS` on the systemd unit.

  Per-feature documentation lives in `docs/`.

## 0.1.0

### Minor Changes

- 05956d6: Add cmd buildclient to the server
- 1a696e1: added tcp forward to the client
