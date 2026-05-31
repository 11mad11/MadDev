# TCP service forwarding

Who: any user enrolled in mad, in at least one group.
What: expose a TCP service on your machine so other members of one of your groups can reach it through the gateway.

## How it works

OpenSSH supports forwarding to/from Unix-domain sockets (≥ 6.7). Mad relies on this — there's zero custom forwarding code in the project. The Linux kernel enforces group access via filesystem permissions on `/run/mad/groups/<g>/`.

```
host A (you)           gateway                          host B (a group member)
─────────                 ───                          ─────────
backend                  sshd                          ssh client
:8080  ←── ssh -R ───→  /run/mad/groups/g/web.sock  ←── ssh -L ───   :9000
                       (0660 you:g)
```

A member of `g` can `ssh -L` to the socket. A non-member can't even traverse the directory (`Permission denied` on `open()`).

## One-off forward (no install needed)

Register from host A (the machine running the backend):

```sh
ssh -R /run/mad/groups/demo/web.sock:localhost:8080 alice@<gw>
```

Use from host B (any other group member):

```sh
ssh -L 9000:/run/mad/groups/demo/web.sock bob@<gw>
curl http://localhost:9000/
```

If `mad` is your login shell (it is, for `mad-users` members), `ssh -R/-L` still works because the `Match Group mad-users` block in sshd_config sets `AllowStreamLocalForwarding all` for you.

The `mad` menu has convenience entries that print the right `ssh -R` / `ssh -L` for you given a group/name/target:

- **Services → service-register** prints the `ssh -R …` to register
- **Services → service-use** prints the `ssh -L …` to use
- **Services → service-ls** walks `/run/mad/groups/*/*.sock` and lists what's visible to you

## Persistent forward (systemd unit on the client)

For services you want always-on, mad generates an install script that drops a systemd unit on the client side.

Interactive: **Services → install**, supply group, service name, target addr:port, scope (user/system).

Scripted (recommended):

```sh
ssh alice@<gw> service install demo/web localhost:8080 --scope user | sh
```

What the script does on the client:

| Step | What |
|---|---|
| Add `Host mad` to `~/.ssh/config` (user) or `/root/.ssh/config` (system) | `HostName`, `User`, `IdentityFile`, `CertificateFile` — pointed at the gateway and your enrollment cert |
| Write `mad-fwd-<group>-<service>.service` | runs `ssh -N -R /run/mad/groups/<g>/<n>.sock:<target> mad`, `Restart=on-failure` |
| `systemctl --user enable --now <unit>` (user scope) or `systemctl enable --now <unit>` (system scope) | brings the forward up immediately |
| Prompt about `loginctl enable-linger` | only for user scope — required for the unit to survive logout |

The script is idempotent: re-running it overwrites unchanged content with the same content and reports `·`, only emitting `✦` when something actually changes.

## Scope choice

| Scope | Unit lives at | Runs as | Survives logout? | Best for |
|---|---|---|---|---|
| `user` | `~/.config/systemd/user/` | your Linux user | only after `sudo loginctl enable-linger <you>` | most cases |
| `system` | `/etc/systemd/system/` | the unit specifies `User=<sudo-user>` | yes, naturally | "always on" servers, headless boxes |

## Concurrency

Many clients can `ssh -L` against the same registered socket simultaneously. Each gets an independent SSH channel on its own session; sshd opens a fresh `connect(2)` to the Unix socket per channel; the registering peer's `ssh -R` multiplexes channels back to its single TCP session and opens a fresh connection to the local backend per channel. Capacity is bounded by the registerer's bandwidth and backend, not by mad.

## Why a non-member can't connect

`/run/mad/groups/demo/` is mode `2770 owner:demo`. A user not in `demo` lacks the `x` bit on the directory and the kernel refuses `connect()` to anything inside before sshd's per-user code even sees the request. There's no mad code involved in the denial — it's the kernel's filesystem ACL.
