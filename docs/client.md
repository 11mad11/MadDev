# mad as a client

The same `mad` binary serves both as the gateway (where `mad daemon` runs as root) and as a client tool on your laptop. This page covers the client side.

## Install

Grab the prebuilt binary for your platform and put it on `$PATH`:

- **Linux x64** — `dist/mad-linux-x64`
- **macOS x64** — `dist/mad-darwin-x64`
- **macOS arm64** — `dist/mad-darwin-arm64`
- **Windows x64** — `dist/mad-windows-x64.exe`

Build them yourself on a Linux box with `bun`:

```sh
bun run build:all
```

Each binary is ~100 MB and self-contained. No installer, no shared libs, no Node.

## How mad finds gateways

mad reads `~/.ssh/config`. A gateway is a normal `Host` block with one extra line:

```
Host mad
    HostName            gw.example.com
    User                alice
    IdentityFile        ~/.ssh/id_ed25519
    ServerAliveInterval 30
    SetEnv              MAD_GATEWAY=1
```

`SetEnv MAD_GATEWAY=1` is the marker. Anything in `~/.ssh/config` without it is a regular SSH host and mad ignores it.

You can keep using `ssh mad …` for raw access — the `SetEnv` line is invisible to OpenSSH.

## Managing gateways

- `mad gateway add user@host [--alias <a>]` — appends the Host block. Runs `ssh <alias> ca pubkey` once to trigger SSH's standard `known_hosts` prompt (TOFU pin).
- `mad gateway ls` — list every alias carrying the marker.
- `mad gateway rm <alias>` — remove the Host block. Pass `--keep-host` to keep raw `ssh <alias>` working and only strip the `SetEnv` line.
- `mad gateway test <alias>` — round-trip-ping. Prints latency and the gateway's CA pubkey.

## Listing services across gateways

By default, `mad service ls` fans out across every gateway in your ssh_config in parallel (5-second per-gateway timeout) and prefixes each row with the gateway alias:

```
mad/marc/web        /run/mad/groups/marc/web.sock
gw2/finance/db      /run/mad/groups/finance/db.sock
```

Flags:

- `--gateway <a>` — query just one.
- `--local-only` — skip the fan-out; list local `/run/mad/groups/`.
- `--orphans` — include orphan sockets (no live listener).
- `--json` — machine-parseable.

If you have no gateways with the marker, it falls back to local behaviour.

## Using and registering services

Both accept either a 3-segment path `<gateway>/<group>/<name>` (uses the named alias) or the older 2-segment `<group>/<name>` (uses the literal alias `mad`):

```sh
mad service use mad/marc/web 9000
# → ssh -L 9000:/run/mad/groups/marc/web.sock mad service ping marc/web

mad service register gw2/finance/api localhost:8000
# → ssh -R /run/mad/groups/finance/api.sock:localhost:8000 gw2 service hold finance/api
```

## Platform matrix

- **service ls / use / register** — Linux, macOS, Windows.
- **gateway add / ls / rm / test** — Linux, macOS, Windows.
- **cert refresh, ca pubkey, enroll** — Linux, macOS, Windows.
- **tun join / leave / ls** (L3) — Linux, macOS, Windows (wintun).
- **tap join / leave / ls** (L2) — Linux, Windows (TAP-Windows6 via `mad system doctor`). Not on macOS (no kernel TAP).
- **daemon, system setup, system update** (server-side) — Linux + root only.
- **admin / cert revoke / otp** — works from any client, over SSH to a gateway.

Server-only commands fail loudly on the wrong platform:

```
mad daemon requires root (try sudo mad daemon).
mad system setup requires Linux (you are on darwin).
```
