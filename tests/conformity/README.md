# Conformity test bench

Docker-compose stack that boots a mad gateway + four Linux clients in
two groups, then runs a conformity test suite (`run-tests.sh`).

A Windows client service is defined in `docker-compose.yml` but
profile-gated (`--profile windows`). It uses `dockurr/windows`, which
spins up a real Windows VM via QEMU inside Docker — first boot is
~30 minutes (Windows ISO download + install). On the kept-running
Linux bench all five core containers come up in ~15 s, so we leave
Windows out of the default flow and let the dedicated test PC at
`192.168.2.14` cover the wintun/L3 path there. To exercise the
Windows-in-Docker path:

```sh
docker compose --profile windows up -d windows
# wait ~30 min on first boot, then RDP to localhost:3389 (user rene/madtest)
# install bun + git for windows, then run `mad tun join rene@gateway/ga`
```

Requires `/dev/kvm` exposed to the LXC and nested-virt enabled on
the proxmox host.

## Layout

```
gateway  ── runs mad daemon + sshd
              + Linux groups ga (10.77.10.0/24), gb (10.77.20.0/24)
              + Linux users alice/bob (ga), carol/dave (gb)

alice ─┐
bob   ─┴── group ga via `mad tun join`
carol ─┐
dave  ─┴── group gb via `mad tun join`
```

All five containers share a single docker bridge (`madnet`,
10.99.0.0/24) for the SSH control plane. The mad tunnels overlay on
top — each client gets a `tun0` with an IP in their group's subnet
(10.77.10.x or 10.77.20.x).

## Setup (one-time, on the proxmox LXC)

```sh
# transfer mad source from your dev workstation
tar czf - --exclude='.git' --exclude='node_modules' --exclude='target' MadDev | ssh root@<lxc> 'tar xzf - -C /root/'

# generate per-user SSH keys
cd /root/mad/tests/conformity
mkdir -p keys && cd keys
for u in alice bob carol dave; do ssh-keygen -t ed25519 -N "" -f $u -C "$u@mad-test"; done
cd ..

# bring up the bench
docker compose build
docker compose up -d
```

## Run the tests

```sh
./run-tests.sh
```

## Tests included

| # | What it checks | Mechanism |
|---|---|---|
| 0 | All six clients joined (4 L3 + 2 L2) | grep MAD_TUN_OK in each client's log |
| 1 | Intra-group reachability — L3↔L3, L2↔L2, L3↔L2 mixed | ping across all combinations within `ga` and within `gb` |
| 2 | Cross-group isolation | ping from `ga` clients to `gb` IPs (and vice-versa) must fail |
| 3 | L2 broadcast scope | eve sends ARP-who-has; frank (same group, L2) sees it on tap0; dave (other group) does not |
| 4 | Packet integrity | iperf3 UDP @ 50 Mbps for 5 s, expect 0 lost packets |
| 5 | Payload preservation | 1 MiB random blob over netcat, md5 match |
| 6 | No plaintext leak | tcpdump on docker bridge during a magic-string ping, magic must not appear |
| 7 | `ssh -R` socket creation | alice's `ssh -R …web.sock` binds with mode 0660 + group `ga` (StreamLocalBindMask 0117 + 2770-setgid dir) |
| 8 | `ssh -L` service-forwarding works | bob's `ssh -L … service ping ga/web` chains through to alice's nc listener; canary bytes round-trip |
| 9 | Cross-group `ssh -L` blocked | carol (gB) cannot read alice's gA socket — denied at the 2770 group-dir level |

Plus a bonus throughput probe: iperf3 TCP 4×parallel `alice → bob`
through gateway IP-forwarding. Last measured: **263 Mbps** on the
proxmox docker LXC (16 cores / 16 GB).

## Conformity properties this validates

- **Isolation** — clients in different groups cannot route to each
  other, even though both groups live on the same gateway.
- **Reachability** — clients in the same group reach each other via
  the gateway's IP-forwarding between per-group tun interfaces.
- **Integrity** — packets arrive intact (UDP 0% loss at 50 Mbps;
  1 MiB blob md5 byte-perfect).
- **Confidentiality** — the SSH transport encrypts everything; a
  known canary string in ICMP payload never appears on the wire.

## Gotchas hit while building this bench

- `net.ipv4.ip_forward` is **off by default inside docker containers**
  (it's a per-netns sysctl). The gateway service sets it via
  `sysctls: { net.ipv4.ip_forward: "1" }`.
- `/root/.bun/bin/bun` is unreachable by unprivileged users that
  sshd's `ForceCommand` forks as (`/root` is `0700`). The Dockerfiles
  `install -m 0755` bun into `/usr/local/bin/` instead.
- mad's `assertValidName` only accepts lowercase + digits + `_`/`-`,
  so the test groups are `ga`/`gb`, not `gA`/`gB`.
- Bun's modern `compose build` requires buildx 0.17+; Debian 13's
  apt ships an old buildx. Install the latest from the GitHub release
  before `docker compose build`.
