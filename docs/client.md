# mad as a client

The same `mad` binary serves both as the gateway server (where `mad daemon` runs as root) and as a client tool on your laptop. This page covers the client side.

## Install

Grab the prebuilt binary for your platform and put it on `$PATH`.

| Platform | Binary |
|---|---|
| Linux x64 | `dist/mad-linux-x64` |
| macOS x64 (Intel) | `dist/mad-darwin-x64` |
| macOS arm64 (Apple Silicon) | `dist/mad-darwin-arm64` |
| Windows x64 | `dist/mad-windows-x64.exe` |

Build them yourself from a Linux box that already has `bun`:

```sh
bun run build:all
```

Each binary is ~100 MB and self-contained (the bun runtime is embedded). No installer, no shared libs, no Node.

## How mad finds your gateways

mad reads `~/.ssh/config`. A gateway is just a normal `Host` block with one extra line:

```
Host mad
    HostName gw.example.com
    User alice
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    SetEnv MAD_GATEWAY=1
```

`SetEnv MAD_GATEWAY=1` is the marker. Anything in `~/.ssh/config` without it is a regular SSH host and mad ignores it. mad uses `ssh -G <alias>` to read the effective config (which resolves `Include` directives and aliases natively), then filters for hosts whose effective `setenv` contains `mad_gateway=1`.

You can keep using `ssh mad …` for raw access — the `SetEnv` line is invisible to OpenSSH.

## `mad gateway` — manage gateways

| Command | What |
|---|---|
| `mad gateway add user@host [--alias <a>]` | Appends a Host block with `SetEnv MAD_GATEWAY=1`. Runs `ssh <alias> ca pubkey` once, which triggers SSH's standard `known_hosts` prompt for the host key (your TOFU pin). |
| `mad gateway ls` | Lists every Host alias in your ssh_config that carries the marker. |
| `mad gateway rm <alias>` | Removes the Host block. (Keep the alias if you still want raw `ssh <alias>` — pass `--keep-host` and only the `SetEnv` line is removed.) |
| `mad gateway test <alias>` | Round-trip-ping. Prints latency + the gateway's CA pubkey for human inspection. |

## `mad service ls` across gateways

By default `mad service ls` fans out across every gateway in your ssh_config in parallel (5-second per-gateway timeout) and prints rows prefixed with the gateway alias:

```
mad/marc/web       /run/mad/groups/marc/web.sock
gw2/finance/db     /run/mad/groups/finance/db.sock
```

Flags:
- `--gateway <alias>` — query just one
- `--local-only` — skip the fanout, list local `/run/mad/groups/`
- `--orphans` — include orphan socket files (no live listener; defaults to filtered)
- `--json` — machine-parseable output

If you have no gateways with the marker, `mad service ls` falls back to local behaviour — exactly what it did before this feature existed.

## `mad service use` / `mad service register`

Both accept a 3-segment path `<gateway>/<group>/<name>` (uses the named alias in the printed `ssh -L/-R`) or the older 2-segment `<group>/<name>` (uses the literal alias `mad`):

```sh
mad service use mad/marc/web 9000
# → ssh -L 9000:/run/mad/groups/marc/web.sock mad service ping marc/web

mad service register gw2/finance/api localhost:8000
# → ssh -R /run/mad/groups/finance/api.sock:localhost:8000 gw2 service hold finance/api
```

## Platform matrix

| Command | Linux | macOS | Windows |
|---|---|---|---|
| `service ls / use / register` | ✓ | ✓ | ✓ |
| `gateway add / ls / rm / test` | ✓ | ✓ | ✓ |
| `cert refresh`, `ca pubkey`, `enroll` | ✓ | ✓ | ✓ |
| `tun join / leave / ls` (L2 VPN to a group) | ✓ | ✓ | ✗ (no `ssh -w`) |
| `daemon`, `setup`, `update` (server-side) | ✓ (root) | ✗ | ✗ |
| `group / user / cert revoke / otp` (admin, talk to daemon) | over SSH to a gateway | over SSH | over SSH |

Server-only commands print a clear error if run on the wrong platform or without root:
```
mad daemon requires root (try sudo mad daemon).
mad setup requires Linux (you are on darwin).
```

## Backward compatibility

A user who never marks a Host block as a gateway keeps seeing `mad service ls` work exactly as before — local-only. The fanout layer is silent unless at least one ssh_config Host has `SetEnv MAD_GATEWAY=1`.
