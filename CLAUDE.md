# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mad` is a Linux-native SSH gateway helper. There is no custom SSH server — system `sshd` does auth and channel transport — and there is no custom user store. The codebase is one Node binary with two shapes:

1. **A CLI** (`src/cli.ts`, run as a user's sshd `ForceCommand`). When invoked with no args and a TTY, it shows an interactive Inquirer tree menu; when invoked with subcommands (directly or via `$SSH_ORIGINAL_COMMAND`), it dispatches Commander handlers for scripting.
2. **A privileged daemon** (`mad daemon` → `src/daemon/server.ts`, started by `systemd/mad-daemon.service`). It owns operations that need privilege: TAP allocation, bridge setup, CA signing, OTP minting.

User identity = Linux users. Authorization = Linux groups. Permission enforcement on services = filesystem ACLs on `/run/mad/groups/<group>/` (mode 2770 + setgid). The daemon additionally checks peer credentials via `SO_PEERCRED`.

## Commands

```sh
npm start             # bun run --watch src/cli.ts
npm run daemon        # sudo bun run src/cli.ts daemon (dev only — prod uses systemd)
npm run changeset     # add a changeset entry
npm run release       # release-it
```

There is no lint, no test runner. Verification is end-to-end (see README and the plan at `~/.claude/plans/create-a-plan-for-stateless-popcorn.md`).

## Architecture

### Entry (`src/cli.ts`)

Thin Commander root. Only the truly-top-level (not-in-menu) commands are defined inline:
- `daemon` — spawns `runDaemon()` (root-only).
- `setup`, `update` — root-only provisioning.
- `enroll` — invoked by an enrolling user via `ssh user@gw enroll` after `mad otp` has set their Linux password to the OTP. Identifies the caller via `process.getuid()`, asks daemon to sign their pubkey + write authorized_keys + `passwd -l`.
- `help [topic]` — render a doc page.
- `ssh-config` — print an ssh_config Host block.
- `doctor` — Windows-side diagnostics + `--install-l2-driver` UAC flow.
- `tun-attach <group>` — gateway-side glue called via SSH_ORIGINAL_COMMAND.

Everything else flows through the menu tree (`menuToTree(ctx, menu, program)` side-effects the Commander program with subcommands derived from the menu). The menu tree owns one Cmd per leaf with its own `perm(ctx)`, so the same `perm: isAdmin` enforces both menu visibility AND CLI dispatch — there's no parallel direct-Commander definition that could bypass the gate.

Default action (no args, TTY): builds a `Ctx` (username, uid, group memberships, stdin/stdout streams, inquirer wrapper) and runs `runMenu(ctx, menu)` from `src/menu.ts`.

`SSH_ORIGINAL_COMMAND` handling: if set (sshd's ForceCommand passes the user-requested command through this env var), it's whitespace-split and parsed as argv. Otherwise `process.argv` is used directly.

### Menu (`src/menu.ts`, `src/commands/`)

The `Cmd` interface (`perm`/`cmd`/`pty`/`run`) + the inquirer-tree-based menu loop. `menuToTree` recursively builds both an `inquirer.tree` (for interactive menu) and adds Commander subcommands to a passed-in `Command` instance (for CLI dispatch). Each leaf's `cmd.action(...)` wrapper calls `menuNode.perm(ctx)` first — denial writes `mad <cmd>: permission denied` + `exit 1`.

`MenuNodeParent.cliName?: string` controls Commander nesting: when set, the parent becomes a Commander subcommand and its children nest under it (`mad gateway add`, `mad cert revoke`); when unset (e.g. the "Admin" grouping), the children are added to the parent Commander directly so they surface at the root (`mad group create`, not `mad admin group create`).

The menu tree (`src/commands/index.ts`) is: Help / Gateways / Services / CA / Certs / TAP / TUN / Admin. Admin's children (Groups, Users, OTP) carry `perm: isAdmin` so they're invisible to non-admin users in the interactive menu AND rejected at the CLI for non-admin callers.

Each area follows a consistent file layout:
- `src/commands/<area>.ts` — the parent menu node (imports its children, sets `text`/`cliName`)
- `src/commands/<area>/<child>.ts` — one Cmd per leaf

Areas:
- `gateway/{add,ls,rm,test}`
- `services/{ls,register,use,hold,ping,install,install-ssh}`
- `ca/{pubkey,sign,krl}`
- `cert/{refresh,ls,revoke,unrevoke}`
- `tap/{join,leave,ls}`
- `tun/{join,leave,ls}`
- `admin/{group,user,otp}` — group and user are themselves menu parents (`group/{create,ls,members,add,rm}` etc. live inline in `admin/group.ts`)

### CA (`src/ca.ts`)

`new CA(keyPath)` loads (or generates) an ed25519 key at `keyPath` (default `/etc/mad/ca/ca.key`). Methods: `signSSHKey(pubkey, username)`, `publicKey()`, `validate(cert)`, `parse(buf)`, `getKey(...)`. No `SSHGateway` coupling; safe to instantiate anywhere root can read the key.

### Groups (`src/groups.ts`)

Thin wrappers over `id`, `getent`, `groupadd`, `groupdel`, `usermod`, `gpasswd`, `userdel`. `assertValidName(name)` rejects shell-unsafe names before any exec.

### Daemon (`src/daemon/`)

- `protocol.ts` — JSON request/response types, socket paths (`/run/mad/daemon.sock` + `/run/mad/daemon-root.sock`), state record types.
- `peercred.ts` — uses `bun:ffi` to call `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ...)` and return `{pid, uid, gid}` of the connecting peer. The socket fd comes from `socket._handle.fd`.
- `state.ts` — load/save `/var/lib/mad/state.json` (TAP records, OTP records, group network records).
- `handlers.ts` — one function per op. Authorization: `requireRoot` checks `isRootSocket && uid==0`; `requireGroup` looks up the peer's username via `id -nu <uid>` and verifies group membership via `id -nG`.
- `server.ts` — `runDaemon()` binds both sockets (mode 0660 root:mad for normal, 0600 root:root for root-only) and dispatches newline-delimited JSON.
- `client.ts` — `daemon.*` helpers used by CLI subcommands; root-only ops go to the root socket, the rest to the user socket.

### Operations on the wire

- `create-group-netns` / `delete-group-netns` (root) — create a bridge `mad-<group>` and remember its subnet.
- `tap-allocate` — for a client's `mad tap/tun join`: pick a free `tap-<g>-<n>` or `tun-<g>-<n>` ifname, create it with `ip tuntap add … user <uid>` so the calling Linux user owns it, attach to the bridge (L2) or assign /32 + peer (L3), bring up, set txqueuelen + qdisc. Returns a `TunRecord`. The client's `mad tap/tun-attach` then opens that device directly (no CAP_NET_ADMIN needed because of `user <uid>`) and shuttles length-prefixed Ethernet/IP frames over the SSH exec channel.
- `tun-release` — `ip link delete` the tap/tun device + drop the state record.
- `list-tuns` — filtered to the caller's UID (root sees all).
- `create-otp` (root) — ensures the Linux user exists and is in `mad,mad-users`, generates an 8-digit code, `chpasswd`'s it as the user's Linux password, persists a record with 15-minute TTL. The user authenticates to sshd via that password on their next `ssh user@gw enroll`.
- `enroll-self` (peer-credentialled) — identifies the caller via `SO_PEERCRED`, signs the supplied pubkey, appends to `authorized_keys`, `passwd -l <user>` to invalidate the OTP. Used by `mad enroll` after sshd already authenticated the user. Note: enroll-self does NOT issue a cert — it just installs the pubkey.
- `ca-sign` (root) — sign an arbitrary pubkey for an arbitrary username (admin tool).
- `ca-pubkey` — print the CA pub for `TrustedUserCAKeys`.
- `ca-krl` — fetch the daemon-signed KRL bytes (used by field devices for revocation propagation).
- `refresh-cert` — re-sign the caller's pubkey with their current `mad-*` group memberships as principals.
- `list-certs` / `revoke-cert` / `unrevoke-cert` / `list-revoked` — cert inventory + revocation. Records live in `state.json` under `certs[]` and `revoked[]`.

The frame pump itself uses a 2-byte big-endian length prefix per Ethernet/IP frame, NOT `ssh -w`'s built-in tunnel mode (which would need PermitTunnel + CAP_NET_ADMIN inside sshd). This is what makes mad work in unprivileged containers / LXCs.

### Filesystem layout at runtime

```
/etc/mad/ca/{ca.key,ca.pub}        # CA material (0400 root:root for the key)
                                   # (no per-group metadata files — Linux's /etc/group is the source of truth;
                                   # subnets live in /var/lib/mad/state.json under netns[])
/run/mad/daemon.sock               # 0660 root:mad
/run/mad/daemon-root.sock          # 0600 root:root
/run/mad/groups/<g>/               # 2770 <owner>:<g>; sockets created by ssh -R inherit gid
/var/lib/mad/state.json            # daemon state
```

The `2770` mode + setgid on `/run/mad/groups/<g>/` is what makes group-based isolation work: any socket created by sshd's `StreamLocalBindMask 0117` inside the directory inherits group `<g>`, so members can connect via `ssh -L … <svc>.sock` and non-members can't even traverse the directory.

### sshd integration

`systemd/sshd_config.snippet` is the source of truth. One `Match Group mad-users` block sets `ForceCommand /usr/bin/mad`, `PasswordAuthentication yes` (needed by the enrollment flow), and the `StreamLocalBind*` knobs. There is no shared `otp` Linux user any more — each enrolling user is their own account; the daemon sets their password to the OTP via `chpasswd` for the 15-minute enrollment window and `passwd -l`'s it on successful enroll.

## Conventions worth knowing

- **Linux-only gateway** (the daemon, the sshd glue, the `ip`/`groupadd`/`usermod`/`id` shellouts). Clients run on Linux/macOS/Windows.
- **`bun:ffi` use sites**:
  - `src/daemon/peercred.ts` — `getsockopt(SO_PEERCRED)` against libc on the gateway.
  - `src/utils/tapPipe.ts` — opens `/dev/net/tun` via `TUNSETIFF` ioctl on Linux clients.
  - `src/utils/winNative.ts` — loads the Windows-only Rust native module (`native/windows-tap/mad_wintap.dll`) for wintun / TAP-Windows6.
- **Windows port** lives in `native/windows-tap/` (Rust `cdylib`). Cross-compiles from Linux via `mingw-w64`. Embedded into the compiled mad.exe via `bun build --compile`'s file-import attribute and extracted to `%LOCALAPPDATA%\mad\native\` on first run. See `docs/internal/tun-tap-walkthrough.md` for the full architecture.
- **No tests today.** Verification is the end-to-end smoke test in the plan file (`~/.claude/plans/create-a-plan-for-stateless-popcorn.md`) — OTP enrollment, group dir mode check, concurrent `curl` over a forwarded socket, cross-group denial, TAP join/leave.
- **`SO_PEERCRED` via `bun:ffi`.** `peercred.ts` opens libc and calls `getsockopt` directly. The fd is read from `socket._handle.fd`. Bun's compat for Node's net module preserves that property.
- **Versioning is by Changesets** (`.changeset/`); `npm run release` invokes release-it for the tag. There is no client to build separately anymore.
