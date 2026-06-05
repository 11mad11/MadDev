# CLI reference

Every subcommand. Run them either by typing in the interactive menu or by `ssh mad <cmd>` from a client.

Permission notation:

- **user** — needs the `mad` group (default for any enrolled user).
- **admin** — needs the `mad-admin` group.
- **root** — needs uid 0 on the gateway.
- **client** — runs locally on your laptop, no daemon involved.

## System (sysadmin)

- `mad daemon` — run the privileged daemon. Use systemd in prod. **root**
- `mad system setup` — provision groups, dirs, CA, sshd snippet, systemd unit. Idempotent. **root**
- `mad system update` — `git pull` + `bun install` + setup + restart daemon. **root**
- `mad system ssh-config` — print an `ssh_config` Host block.
- `mad system doctor` — diagnose client setup; can install Windows TAP driver.

## Help

- `mad help` — render the docs index.
- `mad help <topic>` — render a specific topic (`install`, `enrollment`, `groups`, etc.).
- `mad --help` / `mad <cmd> --help` — Commander help.

## Enrollment

- `mad admin otp <username>` — mint a 15-min OTP (creates the user if missing). **admin**
- `mad enroll` — run AS the enrolling user, after `ssh <user>@<gw> enroll`. Pastes pubkey → writes `authorized_keys` → locks the OTP password.

## Gateways (client)

- `mad gateway add <user@host> [--alias <a>]` — append a Host block with `SetEnv MAD_GATEWAY=1`.
- `mad gateway ls` — list aliases marked as mad gateways.
- `mad gateway rm <alias>` — remove the Host block.
- `mad gateway test <alias>` — round-trip-ping; prints latency and CA pubkey.

## Services (forwarding)

- `mad service ls [group]` — list visible services. Fans out across gateways by default.
  - `--gateway <a>` — only one gateway.
  - `--local-only` — skip fan-out.
  - `--orphans` — include orphan socket files.
  - `--json` — machine-readable.
- `mad service register <group>/<name> <addr:port>` — print the `ssh -R …`.
- `mad service use <group>/<name> <localport>` — print the `ssh -L …`.
- `mad service install <group>/<name> <addr:port>` — print install script for an always-on forward.
  - `--scope user|system` (default `user`).
- `mad service install-ssh <group>/<device>` — print install script for a field device.
  - `--tech-user <name>` (default `mad-tech`).
  - `--scope user|system` (default `system`).

The 3-segment form `<gateway>/<group>/<name>` is accepted by `register`/`use` to target a specific gateway alias from your ssh_config.

## CA / certs

- `mad ca pubkey` — print the CA public key.
- `mad ca sign <username>` — sign a pubkey on stdin. **admin**
- `mad ca krl [--raw]` — print the signed KRL (base64 default).
- `mad cert refresh` — re-sign your pubkey (stdin) with your current group memberships as principals.
- `mad cert ls [--user <u>]` — list certs. Non-admin sees only their own.
- `mad cert revoke --serial <n>` — revoke by serial. **admin/root**
- `mad cert revoke --user <u>` — revoke all of a user's currently-issued certs. **admin/root**
- `mad cert unrevoke <serial>` — remove from the KRL. **admin/root**

## Groups (admin)

- `mad admin group create <name> [subnet]` — `groupadd` + setgid dir + optional bridge.
- `mad admin group ls` — list `/run/mad/groups/*`.
- `mad admin group members <name>` — `getent group <name>` parsed for members.
- `mad admin group add <group> <user>` — `usermod -aG`.
- `mad admin group rm <group> <user>` — `gpasswd -d`.

## Users (admin)

- `mad admin user del <name>` — `userdel -r` (removes home dir).
- `mad admin user forget-keys <name>` — empty `/home/<name>/.ssh/authorized_keys`. Blocks gateway login; doesn't touch the KRL.

## Usage

- `mad usage` — your own usage (bytes + packets) per group.
  - `--since <iso|epoch>`, `--until <iso|epoch>`, `--group <g>`.
- `mad admin usage report` — per-user × per-group usage totals. **admin**
- `mad admin usage export` — JSON or CSV dump for billing. **admin**

## VPN (client, needs root locally)

- `mad tap join <gw>/<group>` — L2 (Ethernet frames, bridged into `mad-<group>`).
- `mad tun join <gw>/<group>` — L3 (IP unicast only).
- `mad tap leave <gw>/<group>` / `mad tun leave <gw>/<group>` — close the tunnel.
- `mad tap ls` / `mad tun ls` — active sessions on this machine.

`mad tap join` on macOS falls back to L3. Windows needs the TAP-Windows6 driver — install via `mad system doctor --install-l2-driver`.

## Menu vs subcommands

`ForceCommand /usr/bin/mad` fires on every login for `mad-users` members:

- No `SSH_ORIGINAL_COMMAND` → interactive menu.
- With one → mad parses it as a subcommand and runs non-interactively.

So every subcommand here works both ways. The menu hides a handful that don't fit interactive use (`daemon`, `tun-attach`, `service hold`, `service ping`).
