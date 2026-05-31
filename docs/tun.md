# TUN-over-SSH: L3 connectivity from your laptop into a group's network

Who: any user in a group with a configured subnet on a mad gateway.
What: an `ssh -w` tunnel that gives your local machine a `tunN` interface with an IP in the group's subnet. Other group members in the same subnet become reachable directly from your laptop.

## How it works

OpenSSH has built-in tunnel forwarding via `-w <local>:<remote>`. The gateway's sshd creates a tun device on each end of the SSH session and forwards packets between them. The mad daemon allocates the gateway end's IP and brings it up; mad's client side configures the local end. When the SSH session dies, both tun devices vanish — no orphans, no cleanup needed.

```
~~~~~~~~~~~~~~~~ your laptop ~~~~~~~~~~~~~~~~      ~~~~~~~~~~~~~~~~ gateway ~~~~~~~~~~~~~~~~
                                                  
   local tunN (10.42.0.43/24)    ssh -w 0:0       remote tun0 (10.42.0.42/24)
   ip addr add 10.42.0.43/24     ─────────────►   mad tun-attach <group> tun0
   ip link set up                                  → daemon allocates IP, ip link up
                                                  → packets reach the mad-<group>
                                                    bridge → other group members
```

Same UDP port as everything else (port 22 = SSH). No new firewall holes.

## Prerequisites

**On the gateway (one-time, done by `mad setup`):**
- sshd_config snippet now includes `PermitTunnel point-to-point` under `Match Group mad-users`.
- Group must have a subnet (`mad group create <name> --subnet 10.42.0.0/24`).

**On the client (per join):**
- Root, for `ip link` on Linux (macOS uses `utun` and may have different requirements).
- Linux or macOS — Windows OpenSSH does not implement `-w`.

## Joining

```sh
sudo mad tun join <gateway>/<group>
```

For example, with a `Host mad` block in your ssh_config and a `demo` group on the gateway:

```sh
sudo mad tun join mad/demo
# → opening tun tun0 via ssh mad…
# → ✔ mad/demo tun0 10.42.0.43/24
# → ssh pid 12345 — leave with: mad tun leave mad/demo
```

The SSH session runs detached; your shell prompt comes back. The tun device persists until you `mad tun leave` (or the SSH session dies for any other reason).

## Listing active sessions

```sh
mad tun ls
```

Reads `~/.config/mad/tun-state.json` and shows which gateway/group each `tunN` belongs to, plus liveness of the underlying SSH process.

## Leaving

```sh
sudo mad tun leave <gateway>/<group>
```

SIGTERM to the SSH process; both tun devices vanish; the state record is cleaned up.

## Reaching other group members

The gateway's `mad-<group>` bridge already carries traffic for everyone in the group's subnet. Your tun device gets routed through that bridge by the gateway-side IP allocation, so:

- Reach the gateway end on the IP listed by `mad tun ls` (column `ip`).
- Other members get IPs in the same subnet; their addresses come from `mad tun ls` on their own machines or from the gateway's `state.json`.

## Platform matrix

| Platform | `mad tun join` | Notes |
|---|---|---|
| Linux | ✓ | `ip link`, requires root |
| macOS | ✓ | `utun`, requires root |
| Windows | ✗ | OpenSSH for Windows doesn't implement `-w`. Use port forwarding instead — see `mad service register/use`. |

## Difference from the old `mad tap` (now removed)

The previous `mad tap join` allocated a TAP device on the gateway and attached it to a Linux bridge — useful only when you were shelled into the gateway itself. Your laptop never saw the network.

TUN-over-SSH gives your actual client machine a working L3 interface into the group's subnet. No L2 (broadcast/multicast doesn't traverse). For most "I want to reach this group's hosts from my laptop" cases that's the right tradeoff.

If you specifically need L2 (broadcast/multicast/non-IP protocols), you'd have to layer something like a bridged VPN on top. That's not bundled.
