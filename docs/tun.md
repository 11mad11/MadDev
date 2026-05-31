# TUN/TAP-over-SSH: L2/L3 connectivity into a group's network

Who: any user in a group with a configured subnet on a mad gateway.
What: an SSH session that gives your local machine a `tapN` (L2, default) or `tunN` (L3) interface with an IP in the group's subnet. Other group members become reachable directly from your laptop — and in L2 mode, broadcast/ARP also crosses, so LAN-discovery P2P games (Hamachi-style) work.

## L2 (TAP) vs L3 (TUN)

| Mode | Command | Kernel device | What flows | Use it for |
|---|---|---|---|---|
| L2 | `mad tap join` | `tapN` | Ethernet frames — IP + ARP + broadcast + non-IP | Hamachi-style P2P LANs, LAN-discovery games, multicast services |
| L3 | `mad tun join` | `tunN` | IP packets only, point-to-point | Lower overhead when you only need IP unicast, or on macOS (which lacks a kernel TAP driver) |

In L2 mode, the gateway bridges your tap device into `mad-<group>`. Broadcast frames from your laptop reach every other group member attached to that bridge — that's what makes LAN-discovery work.

## How it works

mad runs over a regular SSH session — no `ssh -w`, no `PermitTunnel`. Each end creates its own TAP (or TUN) device and runs a small in-process pump that reads one Ethernet frame at a time, prefixes it with a 2-byte length, and writes it into the SSH stream. The receiving end parses the length, slices out exactly one frame, and writes it to its own TAP. The daemon's role is to allocate the gateway-side device with your Linux UID's ownership so the unprivileged `mad tun-attach` process can open it directly — no CAP_NET_ADMIN needed inside sshd. On the gateway, L2 devices are then enslaved into the `mad-<group>` Linux bridge; L3 devices get a `/32` with the client as an explicit peer.

```
~~~~~~~~~~~~~~~~ your laptop ~~~~~~~~~~~~~~~~      ~~~~~~~~~~~~~~~~ gateway ~~~~~~~~~~~~~~~~

   local tapN (10.42.0.43/24)    ssh session       remote tap-<group>-N
   ip addr add 10.42.0.43/24     + framed frames   mad tun-attach <group>
   ip link set up                ─────────────►    → daemon enslaves into mad-<group>
   tapPipe pump                                    → broadcast/ARP reaches every other
                                                     group member's tap → LAN discovery
```

Same single port as everything else (port 22 = SSH). No new firewall holes.

## Prerequisites

**On the gateway (one-time, done by `mad setup`):**
- sshd_config snippet under `Match Group mad-users` (`ForceCommand /usr/bin/mad`, `AllowStreamLocalForwarding all`, `PasswordAuthentication yes`).
- Group must have a subnet (`mad group create <name> --subnet 10.42.0.0/24`).

**On the client (per join):**
- Root, for `ip link`/`ip tuntap`.
- Linux (`tap` or `tun`) or macOS (`tun` only — see platform matrix).

## Joining

```sh
sudo mad tap join <gateway>/<group>           # L2 — broadcast crosses
sudo mad tun join <gateway>/<group>           # L3 — IP unicast only
```

For example, with a `Host mad` block in your ssh_config and a `demo` group on the gateway:

```sh
sudo mad tap join mad/demo
# → opening tap tap0 (L2 bridged) via ssh mad…
# → ✔ mad/demo tap0 10.42.0.43/24 (L2)
# → ssh pid 12345 — leave with: mad tap leave mad/demo
```

The SSH session runs in the same `mad tap join` process — `sudo mad tap join …` stays in the foreground while the tunnel is live. Run it under `&`, `screen`, `tmux`, or a systemd user unit if you want it backgrounded. The tap/tun device persists until you `mad tap leave` (or the process is killed for any reason).

## Listing active sessions

```sh
mad tap ls           # only TAP sessions
mad tun ls           # only TUN sessions
```

Reads `~/.config/mad/tun-state.json` and shows which gateway/group each `tapN`/`tunN` belongs to, plus liveness of the underlying SSH process.

## Leaving

```sh
sudo mad tap leave <gateway>/<group>          # or `mad tun leave` for L3
```

SIGTERM to the SSH process; mad deletes the local kernel device; the gateway-side cleanup handler tears down the remote device and state record. If the local `mad tap join` process is killed without `tap leave` (laptop crash, network drop), the gateway side still cleans up on its own — but the local `tapN` device stays in the kernel until you run `ip link delete <ifname>` manually or reboot.

## Reaching other group members

The gateway's `mad-<group>` bridge carries traffic for everyone in the group's subnet.

- **L2:** your tap device is bridged onto `mad-<group>` directly. Other members' tap devices are bridged onto the same bridge. Reach them by IP, by broadcast, by mDNS — anything that works on a normal LAN.
- **L3:** you get a point-to-point `/32` link to the gateway end; the gateway routes between you and the bridge. Unicast IP works; broadcast does not cross.

## Platform matrix

| Platform | `mad tap join` (L2) | `mad tun join` (L3) | Notes |
|---|---|---|---|
| Linux | ✓ TAP | ✓ TUN | Both work natively |
| macOS | (auto-fallback to L3) | ✓ utun | macOS has no native kernel TAP driver; `mad tap join` warns and falls back to L3 |
| Windows | ✗ | ✗ | mad's frame pump uses Linux/macOS-only `/dev/net/tun` ioctls — no Windows TAP driver integration. Use TCP forwarding instead — see below |

### Windows workaround for P2P games

Windows can still host or join P2P games that support **direct IP connect**:

```sh
# on the host (linux/mac):
mad service register <group>/<game> localhost:<gamePort>

# on the windows guest, eval the printed `ssh -L` to forward the port:
mad service use <gw>/<group>/<game> <localPort>
```

Games that depend on LAN broadcast discovery (no direct-IP option) need L2 — which currently means Linux or macOS. Native Windows L2 support would need a TAP-Windows6 backend in `tapPipe`; not bundled.

## Why default to L2 (TAP)?

The original use case is Hamachi-style P2P LANs for gaming. Most LAN-discovery games rely on broadcast frames or non-IP protocols that don't cross an L3 link. `mad tap` keeps the "just works on a virtual LAN" feel; use `mad tun` when you specifically don't need broadcast and want the lighter overhead.
