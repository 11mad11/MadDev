# CLI reference

Every command shape, plus what permission it needs. Run any of them either by typing in the interactive menu (when applicable) or by `ssh mad <cmd>` from a client. When invoked through ssh, the subcommand string is passed via `SSH_ORIGINAL_COMMAND`.

The `Where` column tells you which socket the daemon-side command goes through:
- **user** — `/run/mad/daemon.sock` (mode 0660 root:mad). Needs the `mad` group.
- **root** — `/run/mad/daemon-root.sock` (mode 0600 root:root). Needs uid 0.
- **n/a** — pure local action, no daemon involved.

## Lifecycle (sysadmin)

| Command | Where | Notes |
|---|---|---|
| `mad daemon` | — | Runs the privileged daemon. Use systemd in prod. |
| `mad setup` | n/a (root) | Idempotent: groups, dirs, CA, sshd snippet, systemd unit, `/usr/bin/mad` wrapper. |
| `mad update` | n/a (root) | `git pull --ff-only` + `bun install` (if commit advanced) + `mad setup` + `systemctl restart mad-daemon`. |

## CA / certs

| Command | Where | Notes |
|---|---|---|
| `mad ca pubkey` | user (or local if root) | Prints the CA public key. |
| `mad ca sign <username>` | root | Reads pubkey on stdin, prints signed cert on stdout. |
| `mad ca krl [--raw]` | user | Prints the current signed KRL (base64 by default, `--raw` for binary). Devices fetch this on every incoming tech connection. |
| `mad cert refresh` | user | Reads your pubkey on stdin, prints a fresh cert reflecting your current group memberships. |
| `mad cert ls [--user <u>]` | user | List certs. Non-root sees their own; root sees everyone's. |
| `mad cert revoke --serial <n>` | root | Revoke by serial. |
| `mad cert revoke --user <u>` | root | Revoke all currently-issued certs for a user. |
| `mad cert unrevoke <serial>` | root | Remove from the revocation list. |

## Groups

| Command | Where | Notes |
|---|---|---|
| `mad group create <name> [--subnet <cidr>]` | mixed | `groupadd`, mkdir, `chown root:<gid>` + setgid, optional bridge if subnet given. No `--owner` — group dirs are `root:<group>`. |
| `mad group ls` | n/a | Walks `/run/mad/groups/*`. |
| `mad group members <name>` | n/a | Parses `getent group <name>`. |
| `mad group add <group> <user>` | n/a | `usermod -aG <group> <user>`. |
| `mad group rm <group> <user>` | n/a | `gpasswd -d <user> <group>`. |

## Users

| Command | Where | Notes |
|---|---|---|
| `mad user del <name>` | n/a (root) | `userdel -r`. |
| `mad user forget-keys <name>` | n/a (root) | Empties `/home/<name>/.ssh/authorized_keys` — blocks GATEWAY login. Doesn't touch the KRL. |
| `mad user lockout <name> [--reason …]` | mixed (root) | Both `cert revoke --user` and `forget-keys` — full lockout. |

## Enrollment

| Command | Where | Notes |
|---|---|---|
| `mad otp <username>` | root | Ensures the Linux user (creates if missing, adds to `mad,mad-users`), mints a 15-min OTP, sets it as the user's Linux password via `chpasswd`. Hand the OTP to the user. |
| `mad enroll` | user | Run AS the enrolling user after `ssh user@gw enroll`. Prompts for pubkey, signs it, writes `authorized_keys`, locks the OTP password (`passwd -l`). |

## Services (forwarding)

| Command | Where | Notes |
|---|---|---|
| `mad service ls [group]` | n/a | Walks visible `/run/mad/groups/*/*.sock`. |
| `mad service register <group/name> <addr:port>` | n/a | Prints the `ssh -R …` you'd run. |
| `mad service use <group/name> <localport>` | n/a | Prints the `ssh -L …` you'd run. |
| `mad service install <group/name> <addr:port> [--scope user\|system]` | n/a | Prints a bash install script that drops a systemd unit running `ssh -R`. Pipe to `sh`. See [forwarding.md](forwarding.md). |
| `mad service install-ssh <group/device> [--tech-user <name>] [--scope user\|system]` | n/a | Prints a bash install script for a field device: trust mad CA, create shared user, set principals file, run `ssh -R …:22`. Pipe to `sudo sh` on the device. See [field-devices.md](field-devices.md). |

## L2 VPN

| Command | Where | Notes |
|---|---|---|
| `mad tun join <gw>/<group>` | client (Linux/macOS/Windows, root/admin) | Opens an SSH exec channel to `<gw>` running `mad tun-attach <group>`, then shuttles length-prefixed Ethernet/IP frames over the channel between the local TUN device and the gateway-allocated one. Holds the session in the foreground. |
| `mad tun leave <gw>/<group>` | client | SIGTERM the held SSH; the local tun device vanishes; gateway side cleans up via the ppid poll; state record cleared. |
| `mad tun ls` | client | Lists active tun sessions on this machine from `~/.config/mad/tun-state.json`. |
| `mad tap {join,leave,ls}` | client (Linux/macOS/Windows) | Same as `tun` but L2 (Ethernet frames, bridged into `mad-<group>`). Windows requires the TAP-Windows6 driver — install with `mad doctor --install-l2-driver`. |
| `mad doctor [--install-l2-driver]` | client (Windows) | Reports wintun + TAP-Windows6 status; optionally downloads + UAC-elevates the OpenVPN tap-windows installer. |
| `mad gateway add <user@host> [--alias <a>]` | client | Appends a Host block to `~/.ssh/config` with `SetEnv MAD_GATEWAY=1`. |
| `mad gateway ls / rm <alias> / test <alias>` | client | List / remove / round-trip-ping gateways. |

## Help

| Command | Where | Notes |
|---|---|---|
| `mad --help` | n/a | Standard Commander help. |
| `mad <subcommand> --help` | n/a | Per-subcommand help. |

## Notes on the interactive menu vs subcommands

When a user in `mad-users` SSHes in, `ForceCommand /usr/bin/mad` fires. The behavior:

- No `SSH_ORIGINAL_COMMAND` → the interactive Inquirer menu opens.
- `SSH_ORIGINAL_COMMAND` set (i.e., user typed `ssh server "service install …"`) → mad parses it as a Commander subcommand and runs the action non-interactively.

So you can use any of the subcommands listed above either through the menu or programmatically. The menu omits a few that don't fit interactive use (`daemon`, `setup`, `update`).
