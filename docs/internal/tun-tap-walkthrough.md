# How mad tun/tap works — a friendlier walkthrough

> Internal reference. For the user-facing doc, see [`../tun.md`](../tun.md).

## What we're trying to do

`mad` lets users join a **private virtual LAN** hosted on a gateway, using only SSH as the transport. Two users in the same group end up looking like they're plugged into the same Ethernet switch, even though they could be anywhere on the internet.

There's no VPN protocol involved — everything rides inside a regular SSH connection.

## Key networking concepts you'll need

**TAP device** — A "fake" network card that lives in software. Programs can write Ethernet frames into it, and the Linux kernel treats them as if they came from a real NIC. Operates at Layer 2 (full Ethernet — has MAC addresses, ARP, broadcast).

**TUN device** — Same idea, but Layer 3 (just IP packets — no Ethernet header, no broadcast, just point-to-point routing).

**Bridge** — A virtual Ethernet switch inside the Linux kernel. You attach network interfaces to it, and any frame coming in on one interface gets flooded/forwarded to the others, with MAC learning just like a real switch.

**L2 vs L3 mode in mad** — L2 means "plug into the bridge, you're on the LAN with everyone else." L3 means "give me a point-to-point IP tunnel to the gateway."

**SSH exec channel** — When you run `ssh host some-command`, SSH opens an encrypted tunnel and pipes the stdin/stdout of that remote command back to your local side. mad uses this to carry network frames.

**Length-prefix framing** — A simple way to mark frame boundaries inside a byte stream: each frame is preceded by a small fixed-size header saying how many bytes follow. mad uses 2 bytes (big-endian) — enough for any Ethernet frame, since the TAP MTU caps at 65535.

---

## The big picture

```
┌────────────┐                                              ┌──────────────┐
│  client A  │                                              │   gateway    │
│            │                                              │              │
│  tap0 ←→ tapPipe ←→ ssh ═══(internet)═══ sshd ←→ mad ←→ tapPipe ←→ tap-A│
│ (10.55.0.3)                                                       ↓      │
└────────────┘                                                  bridge mad-stress
                                                                    ↑
┌────────────┐                                                     │
│  client B  │                                                     │
│  tap0 ←→ tapPipe ←→ ssh ══════════════════ sshd ←→ mad ←→ tapPipe ←→ tap-B
│ (10.55.0.4)                                                              │
└────────────┘                                              └──────────────┘
```

Everyone connected to the same bridge can ping each other. The bridge is just a kernel-level switch.

`tapPipe` is a small piece of mad code that opens the kernel's TAP device directly and shovels framed bytes back and forth between it and the SSH connection. It replaced an earlier `socat`-based design — see the [framing rationale](#why-no-socat) below.

---

## Phase 1: One-time setup (admin does this once)

Before any user can join, the gateway needs:

1. **The `mad` binary installed**, with sshd configured so any login from a `mad-users` group member runs `mad` instead of giving them a shell.
2. **A privileged daemon running** that owns the dangerous operations (creating network interfaces, attaching to bridges). It listens on two unix sockets:
   - A "user" socket that regular logged-in users can talk to.
   - A "root" socket only root processes can talk to.
3. **The group must exist** with a bridge backing it. The admin runs `mad group create stress --subnet 10.55.0.0/24`. This:
   - Creates a Linux group called `stress`.
   - Tells the daemon to create a Linux bridge called `mad-stress`.
   - Gives the bridge IP `10.55.0.1` (it acts as the gateway for the subnet).
   - Records `{group: stress, subnet: 10.55.0.0/24, nextHost: 2}` so future joiners get sequential IPs.
4. **The user must be added to the group** (`mad group add stress alice`).

Once this is done, alice can SSH in and join the network.

---

## Phase 2: Joining the network

Alice runs `sudo mad tap join mygw/stress` on her laptop. (`mad tun join` is the L3 variant.)

### Step A — Create a local virtual NIC

mad asks the kernel to create a TAP device called `tap0` on alice's machine. This is a virtual network card she can write packets to and read packets from. It gets some networking tweaks:

- **`txqueuelen 100`** — a small transmit queue. Combined with `fq_codel`, this is what creates clean backpressure: when the SSH side can't keep up, the queue fills fast, packets get dropped, and TCP's congestion window shrinks instead of letting frames pile up.
- **`fq_codel` queueing discipline** — a smart AQM (active queue management) algorithm. When latency in the queue exceeds 5 ms, it starts dropping packets to signal congestion to TCP. Result: shallow queues end-to-end and low RTT under load.

> This is a recent reversal. The previous tuning was `txqueuelen 10000` + `pfifo_fast`, because `fq_codel`'s drops were "breaking" TCP. The real problem was upstream: socat was losing frames at the framing layer, and `fq_codel` was correctly reacting to those losses as if they were congestion. Now that mad has its own length-prefix framing (zero loss at that layer), `fq_codel` does its actual job and the small queue keeps latency tight.

### Step B — Open the SSH tunnel

mad spawns an `ssh` child process directly (no more `socat` wrapper). The SSH command logs into the gateway and runs `tun-attach stress` over there. Because of the gateway's sshd config, `mad tun-attach stress` is what actually executes.

The data path so far:
```
alice's kernel  →  tap0  →  mad's tapPipe pump  →  ssh stdin
                                                      ↓
                                          (encrypted SSH session)
                                                      ↓
                                     sshd  →  mad tun-attach (on gateway)
```

Everything that's written to alice's `tap0` flows through mad's pump, into ssh, across the internet, and out on the gateway side. Just bytes — no special VPN protocol.

### Step C — The gateway side sets things up

On the gateway, `mad tun-attach` is now running as alice's Linux user (not root). Its job:

1. **Ask the daemon to allocate a TAP device** for alice on the gateway side. The daemon does several things:
   - Checks alice is actually in the `stress` group (using `SO_PEERCRED` — a kernel feature that tells you who's on the other end of a unix socket).
   - Picks a free interface name: `tap-stress-0` for L2, `tun-stress-0` for L3.
   - Creates the TAP device with **alice's user ownership** — this is the clever bit. The device is owned by alice's Linux UID, so the unprivileged `mad tun-attach` process can open it later without needing root.
   - **L2 only**: attaches the device to the bridge (`mad-stress`). Now anything that comes in on this TAP goes onto the LAN.
   - Allocates IPs from the subnet:
     - **L2**: only the client gets an IP (`10.55.0.3/24`). The gateway-side TAP is bridged, doesn't need its own.
     - **L3**: both ends get a `/32` with the other as an explicit peer (`ip addr add 10.55.0.3/32 peer 10.55.0.4/32 …`). This keeps the route point-to-point and avoids collision with the bridge's `/24` on the same host.
   - Increments `nextHost` so the next joiner gets the next address.
   - Records all this in `/var/lib/mad/state.json` for cleanup later.
2. **Tell the client side what IP to use** by printing a magic line on stderr: `MAD_TUN_OK tap-stress-0 (bridged) peer=10.55.0.3/24 group=stress mode=l2`. Stderr because stdout is now the data plane — printing to stdout would corrupt frame bytes.
3. **Open the TAP device directly** via the kernel's standard tun/tap ioctl. Because the daemon created it with alice's UID, no privilege is needed.
4. **Start the framing pump**: shovel length-prefixed Ethernet frames between the SSH connection (stdin/stdout) and the TAP device.

### Step D — Client finishes setup

Back on alice's machine, mad sees the `MAD_TUN_OK` line on ssh's stderr, parses out the IP, and assigns it to `tap0`:

- **L2**: `ip addr add 10.55.0.3/24 dev tap0`
- **L3**: `ip addr add 10.55.0.3/32 peer 10.55.0.4/32 dev tun0`

Then mad opens `tap0` directly (using the same ioctl trick) and starts its own pump between the TAP fd and ssh's stdin/stdout. The pump runs in the same Node process — no separate helper binary.

Alice now has a working virtual NIC. She can ping `10.55.0.1` (the bridge itself), `10.55.0.4` (bob, if he joined), etc.

---

## Phase 3: Packets in flight

Say alice pings bob (`ping 10.55.0.4`):

1. Alice's kernel needs bob's MAC address. It writes an ARP "who has 10.55.0.4?" Ethernet frame into `tap0`.
2. Alice's tapPipe pump reads the frame from `tap0` (the kernel hands back exactly one frame per read).
3. The pump wraps it: `[2-byte length][frame bytes]` and writes the whole thing to ssh's stdin in a single write.
4. ssh encrypts and sends the bytes over the internet.
5. Gateway's sshd hands the bytes to `mad tun-attach`.
6. Gateway's pump buffers incoming bytes, reads the 2-byte length, slices out one full frame, and writes it to `tap-stress-0` — exactly one syscall per frame.
7. The kernel bridge sees a frame arrive on `tap-stress-0`, learns alice's MAC, and **floods the ARP request out all other ports** — including `tap-stress-1` (bob's gateway-side TAP).
8. Bob's gateway-side pump reads the frame from `tap-stress-1`, wraps it with its length prefix, sends it back through SSH to bob's laptop.
9. Bob's local pump unwraps it and writes the frame to bob's `tap0`.
10. Bob's kernel processes the ARP, sends a reply back via the symmetric path.

Then ICMP echo + reply flow the same way. Conceptually it's just like both laptops were physically cabled to the same dumb switch — that's exactly the abstraction a Linux bridge provides.

### Backpressure

If the SSH connection is slow, the pump's writes back out to ssh's stdin will start returning "buffer full." The TUN-reading side of the pump pauses immediately; reads only resume when ssh's input pipe drains. This pushes pressure back into the kernel's TAP queue, which fills to `txqueuelen` (100), which trips `fq_codel`'s 5 ms target, which drops a packet, which tells TCP to slow down. Result: end-to-end the queue stays short and latency stays low even under heavy load.

### The L3 variant

Same flow, but:
- The gateway-side TUN isn't attached to the bridge. Each end has a `/32` with the other as the explicit peer — a textbook point-to-point link.
- No broadcast, no ARP — pure IP routing.
- The kernel device is `tun-` not `tap-`, and only carries IP packets (no Ethernet header).

Useful when you only want connectivity to the gateway itself, or when running on macOS (which doesn't have a kernel TAP driver).

---

## Phase 4: Cleanup

### When alice disconnects gracefully (`mad tap leave`)

1. mad kills the local ssh process.
2. ssh dying closes the pipes, which sends EOF to the gateway.
3. The gateway's pump sees EOF and returns.
4. Gateway-side `mad tun-attach` runs its cleanup handler, which tells the daemon to release the TAP. The daemon deletes the device (which automatically removes it from the bridge) and clears the state record.
5. Locally, mad runs `ip link delete tap0` and updates its state file.

### When alice's laptop crashes / network drops

The gateway side has three independent cleanup triggers:

- The pump's read or write throwing (because the SSH pipes died).
- A signal (SIGHUP/SIGTERM/SIGINT).
- A **1-Hz poll of its parent process ID** — covers the case where sshd silently reaps the whole session cgroup without sending a signal.

Whichever fires first, the daemon gets notified within ~1 second and tears down the gateway-side TAP.

The client side is messier: if mad crashes without running `tap leave`, the local `tap0` stays in the kernel until next reboot or manual cleanup. There's no watchdog on the laptop side.

---

## Why this design is interesting

### Why no socat?

The earlier design used `socat` on both sides to shovel bytes between the SSH connection and the TAP device. Then we measured a strange 17% packet loss in the bursty direction (client→hub) but only 2% on the return path.

The cause: **socat doesn't know about Ethernet frame boundaries.** SSH delivers bytes, not frames. When several Ethernet frames arrive back-to-back, socat's read returns them concatenated. socat then writes that whole blob to `/dev/net/tun` in one syscall — but the TUN driver only accepts **one frame per write**. The rest is silently dropped.

The fix: explicit length-prefix framing. Each Ethernet frame is prefixed with a 2-byte big-endian length before going into the SSH byte stream. The receiver reads bytes into a buffer, peels off complete frames, and writes each one with its own syscall. Zero ambiguity, zero loss.

As a bonus, removing socat removed an Ubuntu-22.04-specific `setcap cap_net_admin` workaround on `/usr/bin/socat`. The pump runs in the same Node process as the rest of mad now.

### Why not `ssh -w`?

SSH has a built-in tunneling mode that exposes tun devices to both ends. But it requires the sshd to keep `CAP_NET_ADMIN`, which doesn't work in unprivileged containers (LXCs). Using a regular SSH session + a userspace pump works anywhere SSH works.

### Why does the daemon create the TAP with the user's UID?

Opening `/dev/net/tun` normally requires `CAP_NET_ADMIN`. By creating the device with `user <uid>` ownership ahead of time, the *unprivileged* `mad tun-attach` process can attach to it without needing root. This is the key trick that lets the actual data-plane process run as the regular user.

### Why two sockets (user vs root)?

Operations like "create a bridge" need root. Operations like "give me a TAP in my group" just need group membership. Splitting the sockets makes the privilege boundary explicit — a leaked user socket connection can never accidentally create a new group bridge.

### Why three layers of authorization?

1. **Filesystem permissions** on the socket gate who can even connect.
2. **`SO_PEERCRED`** tells the daemon which Linux user is on the other end (the kernel guarantees this — you can't lie).
3. **Per-operation checks** confirm the user's group membership for each request.

Defense in depth.

### Why /32 + peer for L3?

Earlier L3 used `/24` on both ends, the same prefix as the L2 bridge. That created routing ambiguity on the gateway: was a packet for `10.55.0.5` supposed to go through the L3 TUN or out the bridge? Switching to `/32` + an explicit peer address makes each L3 link a textbook point-to-point route with no overlap.

### Why the small queue + AQM combo?

A common instinct is "more buffer = fewer drops = better throughput." It's wrong under congestion: large buffers just hide the problem, letting latency balloon (bufferbloat) before TCP notices. `fq_codel` deliberately drops a packet when the queue's standing latency exceeds 5 ms, telling TCP to back off *immediately*. A short `txqueuelen` keeps the kernel's own queue from masking that signal. The end result is throughput close to line rate but with RTT staying within a few ms of the unloaded baseline.

This combination only works because of the framing fix above. With socat in the loop, AQM drops looked indistinguishable from socat's frame-boundary losses, and TCP was reacting to noise. Now the only drops are real congestion signals.

---

## Windows clients: a different shape

Linux and macOS clients open `/dev/net/tun` directly and run the framing pump in-process via `bun:ffi` against libc. Windows can't do either: there's no `/dev/net/tun`, and the TUN/TAP devices Windows DOES have (wintun for L3, TAP-Windows6 for L2) are kernel drivers reached through Win32 APIs, not file paths. So we ship a small Rust native module — `mad_wintap.dll` — that the Windows binary loads via `bun:ffi`.

### Stack

```
Windows mad.exe ──► bun:ffi ──► mad_wintap.dll  (Rust cdylib)
                                  │
                                  ├─ wintun.dll          (L3, signed redistributable)
                                  │     └─ wintun kernel driver
                                  └─ TAP-Windows6 driver  (L2, OpenVPN-signed)
                                        └─ tap0901 kernel driver
```

The native module exposes a small C ABI (`mad_open`, `mad_pump_start_ssh`, `mad_pump_wait_handshake`, `mad_pump_is_running`, `mad_close`, …) that mirrors the openTap/pump shape of the Linux/macOS path. From the JS side the only Windows-specific code is `src/commands/windowsTunClient.ts`, which handles the things Linux gets from the kernel for free: adapter creation, IP assignment via `netsh`, and choosing the right SSH executable (more on that below).

The frame pump itself lives entirely in Rust — three threads per session: TAP→ssh, ssh→TAP, and a stderr scanner that surfaces `MAD_TUN_OK` for the JS handshake while passing every other ssh stderr line through to our own stderr. That keeps the data path zero-JS once the tunnel is established, and uses Win32 manual-reset events + WaitForMultipleObjects rather than fd-based polling.

### The Microsoft-OpenSSH stdin gotcha

Windows 10/11 ship Microsoft OpenSSH at `C:\Windows\System32\OpenSSH\ssh.exe`. It treats its stdin handle in **text mode**:

- Bytes `0x0D 0x0A` get collapsed to `0x0A` (CRLF → LF)
- `0x1A` is interpreted as Ctrl-Z, an EOF marker

Both translations silently corrupt our binary frame stream. Symptoms when this happens: the TX-side frame counter grows happily, sshd on the gateway sees a trickle of bytes, and ping replies never come back. The pump looks healthy from every counter you can read.

Git for Windows bundles an MSYS-based `ssh.exe` at `C:\Program Files\Git\usr\bin\ssh.exe` that handles binary stdin correctly. `windowsTunClient.ts::resolveSshExe()` prefers Git's, falls back to whatever's on PATH with a loud warning, and respects a `MAD_SSH=<path>` override.

We also pass `-T -e none` regardless, to disable any leftover TTY allocation or escape-character processing.

### L3 mode (wintun) — production

1. `winNative.loadWintun()` — extracts `wintun.dll` from the compiled `mad.exe` to `%LOCALAPPDATA%\mad\native\`, sets it as the DLL search dir, then `LoadLibraryW`s it.
2. `winNative.open(group, "l3")` — `WintunCreateAdapter("mad-<group>", ...)`, then `WintunStartSession` with a 2 MiB ring buffer. The adapter appears in Network Connections immediately.
3. `winNative.pumpStartSsh(handle, sshExe, args)` — spawns ssh as a child of `mad_wintap.dll`, owns its stdio pipes, and starts the three pump threads.
4. `winNative.pumpWaitHandshake(handle, 15000)` — blocks until ssh stderr emits `MAD_TUN_OK <ifname> <ip> peer=<peer> group=<g> mode=l3`.
5. `netsh interface ipv4 set address name="mad-<group>" static <ip> 255.255.255.0` — assigns the address. /24 mask gives Windows an on-link route for the whole group subnet, which is what makes cross-client reachability work.
6. JS polls `winNative.pumpIsRunning(handle)` until the pump exits (ssh died, SIGINT, or `mad tun leave`), then `winNative.close(handle)` releases the adapter.

Tested working end-to-end at **216 Mbps** TCP single-stream, 0% loss at 100 Mbps UDP.

### L2 mode (TAP-Windows6) — scaffolded

Same JS flow, but `winNative.open(group, "l2")` opens an existing TAP-Windows6 device at `\\.\Global\<NetCfgInstanceId>.tap` with `FILE_FLAG_OVERLAPPED`, then issues `TAP_WIN_IOCTL_SET_MEDIA_STATUS(1)` to bring it "connected." Read is one overlapped `ReadFile` in flight at a time with the completion event re-used across iterations; the recv_wait_handle exposed to the pump IS that event. Write is a synchronous overlapped `WriteFile` per frame.

Adapter discovery walks the Net-class registry path
`HKLM\SYSTEM\CurrentControlSet\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}\<guid>\Connection`
and matches on the user-visible `Name` REG_SZ — `mad-<group>`. The subkey name IS the NetCfgInstanceId GUID we need for the device path.

L2 is gated behind a driver-installed check (`mad_l2_driver_installed` probes for `HKLM\SYSTEM\CurrentControlSet\Services\tap0901`). If the driver isn't present, mad surfaces clear install instructions instead of crashing.

### Packaging

`bun build --compile --target=bun-windows-x64` embeds both `wintun.dll` and `mad_wintap.dll` into the final `mad.exe` via the `import x from "./file.dll" with { type: "file" }` attribute. On first run `winAssets.extractDlls()` copies them out to `%LOCALAPPDATA%\mad\native\` (a stable per-user path — wintun's docs recommend a stable location, and `bun build --compile`'s built-in extraction dir is recreated per launch). Subsequent runs skip the copy when the bytes match what's already there.

### Stale-adapter sweep

On every `mad tap/tun join` startup, `windowsTunClient.ts::sweepStaleAdapters` reads `~/.config/mad/tun-state.json`, finds entries whose owning PID is no longer alive, calls `winNative.deleteWintunAdapter(name)` to reclaim each (wintun's auto-abandonment timeout is ~60 s — we don't want to wait), and prunes the state file. Cheap and idempotent.
