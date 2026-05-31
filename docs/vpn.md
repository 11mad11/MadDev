# L2 VPN per group

Who: any group member.
What: get a TAP device on your machine that's bridged with every other member's TAP, so you all see one another as if on the same LAN.

## Concepts

- Each mad group that was created with `--subnet <cidr>` has a Linux bridge `mad-<group>` on the gateway.
- When you `mad tap join`, the daemon creates a persistent TAP device `tap-<group>-<uid>` owned by your Linux user, attaches it to the group's bridge, and assigns the next available host address from the subnet.
- The TAP is persistent: it survives daemon restarts, your SSH session ending, and reboots-by-the-daemon. It's released only by `mad tap leave`.

## Set up the group's subnet (admin, once)

If the group wasn't created with `--subnet`, an admin needs to either recreate it or update its metadata. For now, the easiest is to delete and recreate:

```sh
ssh <admin>@<gw>
# Menu → Admin → Groups → group-create  (or via CLI)
ssh <admin>@<gw> group create demo --owner alice --subnet 10.42.0.0/24
```

This triggers the daemon op `create-group-netns` which sets up the bridge.

## Join (any group member)

```sh
ssh <you>@<gw> tap join demo
# → tap-demo-1004    10.42.0.5/24
```

On the gateway, you now have a TAP device owned by your Linux user. To "see" the device from your client machine, you'd need either:

- An OpenVPN-style userland bridge that pipes packets between your client and the TAP, or
- To work *on* the gateway directly (e.g., ssh in, and the TAP is local to you there).

For typical use, members sshto the gateway and run their workloads there, or use the TAP from inside the gateway (since mad's CLI runs there with their identity). The TAP is owned by `<your-mad-user>:<group>` so your processes can `open("/dev/net/tun")` + `TUNSETIFF tap-demo-<uid>` and shuffle frames; the IP routing is already set up by the daemon.

> The current L2 VPN feature is most useful when group members log into the gateway and run their code there. A "TAP-on-my-laptop" workflow would need a userspace tunnel between the laptop and the gateway, which mad does not yet provide.

## Leave

```sh
ssh <you>@<gw> tap leave demo
```

Daemon deletes the TAP. Bridge stays; other members keep their TAPs.

## List

```sh
ssh <you>@<gw> tap ls
```

Lists your own TAPs (only root sees everyone's).

## What `mad tap join` does, under the hood

1. Daemon verifies via `SO_PEERCRED` that the caller is in the group.
2. If the group's bridge doesn't exist yet, create it: `ip link add name mad-demo type bridge; ip link set dev mad-demo up; ip addr add 10.42.0.1/24 dev mad-demo`.
3. Compute interface name: `tap-demo-<uid>` (truncated to 15 chars).
4. If the user already has one allocated for this group, return that record.
5. Otherwise: `ip tuntap add mode tap user <user> group <group> name <ifname>`, `ip link set master mad-demo`, `ip link set up`, `ip addr add <next-host>/<prefix>`.
6. Persist the record in `/var/lib/mad/state.json`.

The user owns the TAP, so they can open it and shuffle frames without further privilege.
