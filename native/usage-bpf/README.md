# native/usage-bpf

eBPF byte counter for AF_UNIX service forwards (Phase 2 of mad's usage
metering — see `docs/usage-metering.md` if it exists, otherwise the plan
at `.claude/plans/`).

## Files

- `usage_unix.bt` — bpftrace script that traces `unix_stream_connect`
  to learn (sock → path) pairs, then sums bytes per path at
  `unix_stream_sendmsg` / `unix_stream_recvmsg`. Prints + clears the
  aggregates every 60 s.

## How mad uses it

`src/daemon/bpfUsage.ts` (loaded by the daemon at boot) spawns
`bpftrace usage_unix.bt`, parses the framed output, and writes
`svc-publish` / `svc-consume` rows into `/var/lib/mad/usage.db`. If
bpftrace isn't installed on the gateway, the daemon logs a warning and
TAP/TUN metering (Phase 1) still works fine.

## Why bpftrace, not Rust + aya

The plan calls for a `Rust + aya` implementation alongside
`native/windows-tap/`. The current code uses bpftrace as a working
prototype:

- Real eBPF, real kprobes, real per-path aggregation.
- Zero compilation step at install time.
- One self-contained script anyone can read.

The collector contract is the line-framed output between
`MAD_USAGE_TICK` and `MAD_USAGE_END`. A future libbpf/aya rewrite that
emits the same lines is a drop-in replacement.

## Known limitations of the prototype

- Only `unix_stream_*` is hooked; `unix_dgram_*` is missing.
- Accepted server-side sockets aren't traced — `unix_stream_connect`
  fires on the client side only, so bytes flowing from the listener
  back through the accepted socket are accounted on the client's path
  entry (still correct for total per-service bytes, just not split by
  endpoint owner).
- Path attribution to publisher uid relies on `stat()` of
  `/run/mad/groups/<g>/<n>.sock`, which is the listener's owning uid.

## Production path

Replace `usage_unix.bt` with a libbpf-rs (or aya) implementation that:

1. Hooks `unix_stream_connect`, `unix_accept`, and the four sendmsg /
   recvmsg paths.
2. Walks `unix_sock(sk)->addr->name->sun_path` on accept to recover the
   listener path for server-side sockets.
3. Pins its map at `/sys/fs/bpf/mad/usage_unix` so map state survives
   daemon restarts.
4. Exposes the same line-framed output (or a small C ABI consumable via
   `bun:ffi`) so `bpfUsage.ts` doesn't change.
