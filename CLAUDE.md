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

Commander root. Subcommands:
- `daemon` — spawns `runDaemon()` (root-only).
- `enroll` — runs `runEnroll()`. Invoked by an enrolling user via `ssh user@gw enroll` after `mad otp` has set their Linux password to the OTP. Identifies the caller via `process.getuid()`, asks daemon to sign their pubkey + write authorized_keys + `passwd -l`.
- `ca {pubkey,sign}` — local CA call if uid 0, daemon call otherwise.
- `group {create,ls,members,add,rm}` — wraps `groupadd`/`usermod`/`gpasswd`/`getent`.
- `user {del,forget-keys}` — wraps `userdel` / truncates `~user/.ssh/authorized_keys`.
- `service {ls,register,use}` — walks `/run/mad/groups/*/` and prints the right `ssh -R` / `ssh -L`.
- `tap {join,leave,ls}` — talks to the daemon to allocate/release persistent TAPs.
- `otp <user>` — root-only, asks the daemon to mint an OTP.

Default action (no args): builds a `Ctx` (username, uid, group memberships, stdin/stdout streams, inquirer wrapper) and runs `runMenu(ctx, menu)` from `src/menu.ts`.

`SSH_ORIGINAL_COMMAND` handling: if set (sshd's ForceCommand passes the user-requested command through this env var), it's whitespace-split and parsed as argv. Otherwise `process.argv` is used directly.

### Menu (`src/menu.ts`, `src/commands/`)

The `Cmd` interface (`perm`/`cmd`/`pty`/`run`) and the inquirer-tree-based menu loop. `menuToTree` recursively builds an `inquirer.tree` from a `MenuNodeParent`, filtering out leaves the current `Ctx` can't see (the `perm(ctx)` check). `runExec` adds the same `Cmd`s to a Commander instance for non-interactive use.

The menu tree (`src/commands/index.ts`) is: Help, Services, Networking, Admin. Admin (Group/Users/CA/OTP) is gated by membership in `mad-admin`.

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
- `allocate-tap` — create `tap-<group>-<uid>` owned by the calling user, attach to the bridge, assign the next host IP from the subnet. Persistent across CLI exits and daemon restarts.
- `release-tap` — `ip link delete` the TAP.
- `list-taps` — filtered to the caller's UID (root sees all).
- `create-otp` (root) — ensures the Linux user exists and is in `mad,mad-users`, generates an 8-digit code, `chpasswd`'s it as the user's Linux password, persists a record with 15-minute TTL. The user authenticates to sshd via that password on their next `ssh user@gw enroll`.
- `enroll-self` (peer-credentialled) — identifies the caller via `SO_PEERCRED`, signs the supplied pubkey, appends to `authorized_keys`, `passwd -l <user>` to invalidate the OTP. Used by `mad enroll` after sshd already authenticated the user.
- `ca-sign` (root) — sign an arbitrary pubkey for an arbitrary username (admin tool).
- `ca-pubkey` — print the CA pub for `TrustedUserCAKeys`.

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

- **Linux-only.** Calls `ip`, `getent`, `useradd`, `userdel`, `usermod`, `groupadd`, `gpasswd`, `id`. The daemon shells out to `iproute2` rather than using netlink directly (the previous Rust netlink module was dropped).
- **`bun:ffi` is used only for `SO_PEERCRED`.** The old `src/ffi/`, `src/utils/NetNS.ts`, `native/` Rust module, and `ffi-rs` dependency are gone; the daemon doesn't manage namespaces in-process.
- **No tests today.** Verification is the end-to-end smoke test in the plan file (`~/.claude/plans/create-a-plan-for-stateless-popcorn.md`) — OTP enrollment, group dir mode check, concurrent `curl` over a forwarded socket, cross-group denial, TAP join/leave.
- **`SO_PEERCRED` via `bun:ffi`.** `peercred.ts` opens libc and calls `getsockopt` directly. The fd is read from `socket._handle.fd`. Bun's compat for Node's net module preserves that property.
- **Versioning is by Changesets** (`.changeset/`); `npm run release` invokes release-it for the tag. There is no client to build separately anymore.
