# TUN/TAP-over-SSH: L2/L3 connectivity into a group's network

Who: any user in a group with a configured subnet on a mad gateway.
What: an `ssh -w` tunnel that gives your local machine a `tapN` (L2, default) or `tunN` (L3) interface with an IP in the group's subnet. Other group members become reachable directly from your laptop — and in L2 mode, broadcast/ARP also crosses, so LAN-discovery P2P games (Hamachi-style) work.

## L2 (default) vs L3

| Mode | ssh option | Kernel device | What flows | Use it for |
|---|---|---|---|---|
| L2 (default) | `Tunnel=ethernet` | `tapN` | Ethernet frames — IP + ARP + broadcast + non-IP | Hamachi-style P2P LANs, LAN-discovery games, multicast services |
| L3 (`--l3`) | `Tunnel=point-to-point` | `tunN` | IP packets only, point-to-point | Lower overhead when you only need IP unicast, or on macOS (which lacks a kernel TAP driver) |

In L2 mode, the gateway bridges your tap device into `mad-<group>`. Broadcast frames from your laptop reach every other group member attached to that bridge — that's what makes LAN-discovery work.

## How it works

OpenSSH has built-in tunnel forwarding via `-w <local>:<remote>`. With `Tunnel=ethernet`, sshd creates a TAP device on each end; with `Tunnel=point-to-point`, it creates a TUN. The mad daemon either bridges the gateway-side TAP into `mad-<group>` (L2) or assigns an IP and routes (L3). When the SSH session dies, both kernel devices vanish — no orphans, no cleanup needed.

```
~~~~~~~~~~~~~~~~ your laptop ~~~~~~~~~~~~~~~~      ~~~~~~~~~~~~~~~~ gateway ~~~~~~~~~~~~~~~~

   local tapN (10.42.0.43/24)    ssh -w 0:0       remote tap0
   ip addr add 10.42.0.43/24     Tunnel=ethernet  mad tun-attach <group> tap0
   ip link set up                ─────────────►   → daemon bridges tap0 into mad-<group>
                                                  → broadcast/ARP reaches every other
                                                    group member's tap → LAN discovery
```

Same single port as everything else (port 22 = SSH). No new firewall holes.

## Prerequisites

**On the gateway (one-time, done by `mad setup`):**
- sshd_config snippet includes `PermitTunnel yes` under `Match Group mad-users`.
- Group must have a subnet (`mad group create <name> --subnet 10.42.0.0/24`).

**On the client (per join):**
- Root, for `ip link`.
- Linux (default L2) or macOS (auto-falls back to L3 — see platform matrix).

## Joining

```sh
sudo mad tun join <gateway>/<group>           # L2 (default on Linux)
sudo mad tun join <gateway>/<group> --l3      # force L3
```

For example, with a `Host mad` block in your ssh_config and a `demo` group on the gateway:

```sh
sudo mad tun join mad/demo
# → opening tap tap0 (L2 bridged) via ssh mad…
# → ✔ mad/demo tap0 10.42.0.43/24 (L2)
# → ssh pid 12345 — leave with: mad tun leave mad/demo
```

The SSH session runs detached; your shell prompt comes back. The tap/tun device persists until you `mad tun leave` (or the SSH session dies for any other reason).

## Listing active sessions

```sh
mad tun ls
```

Reads `~/.config/mad/tun-state.json` and shows which gateway/group each `tapN`/`tunN` belongs to, plus liveness of the underlying SSH process.

## Leaving

```sh
sudo mad tun leave <gateway>/<group>
```

SIGTERM to the SSH process; both kernel devices vanish; the state record is cleaned up.

## Reaching other group members

The gateway's `mad-<group>` bridge carries traffic for everyone in the group's subnet.

- **L2:** your tap device is bridged onto `mad-<group>` directly. Other members' tap devices are bridged onto the same bridge. Reach them by IP, by broadcast, by mDNS — anything that works on a normal LAN.
- **L3:** you get a point-to-point link to the gateway end; the gateway routes between you and the bridge. Unicast IP works; broadcast does not cross.

## Platform matrix

| Platform | L2 default | L3 (`--l3`) | Notes |
|---|---|---|---|
| Linux | ✓ TAP | ✓ TUN | Both work natively |
| macOS | (auto-fallback to L3) | ✓ utun | macOS has no native kernel TAP driver; mad warns and falls back to L3 |
| Windows | ✗ | ✗ | OpenSSH for Windows doesn't implement `-w`. Use TCP forwarding instead — see below |

### Windows workaround for P2P games

Windows can still host or join P2P games that support **direct IP connect**:

```sh
# on the host (linux/mac):
mad service register <group>/<game> localhost:<gamePort>

# on the windows guest, eval the printed `ssh -L` to forward the port:
mad service use <gw>/<group>/<game> <localPort>
```

Games that depend on LAN broadcast discovery (no direct-IP option) need L2 — which currently means Linux or macOS. Native Windows L2 support would need TAP-Windows6 + a custom stdio bridge between OpenSSH and the driver; not bundled.

## Why default L2?

The original use case is Hamachi-style P2P LANs for gaming. Most LAN-discovery games rely on broadcast frames or non-IP protocols that don't cross an L3 link. Defaulting to L2 keeps the "just works on a virtual LAN" feel; pass `--l3` when you specifically don't need broadcast and want the lighter overhead.
