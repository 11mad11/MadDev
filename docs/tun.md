# L2/L3 VPN into a group's network

An SSH session that gives your laptop a `tapN` (L2) or `tunN` (L3) interface inside a group's subnet. Other members become reachable directly. In L2 mode, ARP and broadcast cross too — so LAN-discovery games work.

## L2 (TAP) vs L3 (TUN)

- **L2 — `mad tap join`** — Ethernet frames. IP + ARP + broadcast + non-IP. Use for Hamachi-style P2P LANs, LAN-discovery games, multicast services.
- **L3 — `mad tun join`** — IP unicast only. Lower overhead. The only option on macOS (no kernel TAP driver).

In L2 mode the gateway bridges your tap into `mad-<group>`, so broadcasts reach every other member's tap on that bridge.

## Prerequisites

**On the gateway** (done by `mad system setup`):

- The mad sshd snippet.
- The group must have a subnet — `mad admin group create <name> 10.42.0.0/24`.

**On the client** (per join):

- Root (for `ip link`/`ip tuntap`).
- Linux (tap or tun) or macOS (tun only). Windows: see the platform matrix.

## Joining

```sh
sudo mad tap join <gateway>/<group>      # L2
sudo mad tun join <gateway>/<group>      # L3
```

Example:

```sh
sudo mad tap join mad/demo
# → opening tap tap0 (L2 bridged) via ssh mad…
# → ✔ mad/demo tap0 10.42.0.43/24 (L2)
```

The SSH session runs in the foreground. Background it with `&`, tmux, or a systemd unit if needed. The tap/tun device persists until you `tap leave` (or the process dies).

## Listing

```sh
mad tap ls       # active L2 sessions
mad tun ls       # active L3 sessions
```

Reads `~/.config/mad/tun-state.json` and shows which gateway/group each `tapN`/`tunN` belongs to.

## Leaving

```sh
sudo mad tap leave <gateway>/<group>     # or `mad tun leave`
```

SIGTERMs the SSH process. mad deletes the local kernel device; the gateway side cleans up its end. If the local process dies without `leave`, the gateway still cleans up — but the local `tapN` stays around until you `ip link delete <ifname>` or reboot.

## Reaching others

- **L2** — your tap is bridged onto `mad-<group>`. Other members' taps are on the same bridge. IP, broadcast, mDNS all work.
- **L3** — point-to-point `/32` to the gateway, which routes to the bridge. Unicast IP works; broadcast doesn't cross.

## Platform matrix

- **Linux** — TAP and TUN, both native.
- **macOS** — TUN works; `mad tap join` auto-falls-back to L3 (no kernel TAP).
- **Windows** — neither, today. mad's frame pump uses Linux/macOS `/dev/net/tun` ioctls. Use TCP forwarding instead (see below).

### Windows workaround for P2P games

If the game supports direct-IP connect:

```sh
# on the host (linux/mac):
mad service register <group>/<game> localhost:<gamePort>

# on the windows guest:
mad service use <gw>/<group>/<game> <localPort>
```

Games that depend on LAN broadcast discovery need L2 — Linux or macOS only.

## Why default to L2

The original use case is Hamachi-style P2P LANs. Most LAN-discovery games rely on broadcast or non-IP protocols that don't cross an L3 link. Use `mad tun` when you only need IP unicast and want the lighter overhead.
