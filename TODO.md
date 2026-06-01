# TODO — review punch list

Findings from the 2026-06-01 full project review. Roughly ordered by leverage. Severity tags: C = critical, H = high, M = medium, L = low, N = note.

## Doing now

- [x] **(refactor)** Merge menu + Commander definitions into one sub-folder tree under `src/commands/`. Each area's parent lives at `src/commands/<area>.ts` and imports children from `src/commands/<area>/<child>.ts`. Menu wraps every Cmd in a `perm` check on dispatch, so the C1 admin-gate fix becomes a one-line `perm: isAdmin` per command.
- [x] **C1 — Admin commands have no CLI-level admin gate** (`src/cli.ts:208-269`). After the restructure, set `perm: isAdmin` on every admin command and delete the duplicate direct-Commander definitions in `cli.ts`. *(Done implicitly by the restructure: `group/user/cert revoke/unrevoke/ca sign` all have `perm: isAdmin` and go through `menuToTree`'s wrapper, which now writes "permission denied" + exit code 1 when perm fails.)*
- [ ] **H11 — Documentation refresh** (`CLAUDE.md`, `README.md`, `docs/install.md`, `docs/cli-reference.md`, `docs/client.md`, `systemd/sshd_config.snippet`). Stale `ssh -w` claims, deleted `otp` Linux user, deleted daemon-side socat, deleted `/etc/mad/groups`, deleted Networking menu branch, missing Windows port docs, missing `mad doctor`.
- [ ] **C3 — Rust FFI exports panic across C ABI (UB)** (`native/windows-tap/src/lib.rs:39-404`). Wrap every `#[no_mangle] extern "C"` body in `std::panic::catch_unwind(AssertUnwindSafe(|| { ... }))` and translate panics into `set_last_error` + the function's error sentinel.
- [ ] **C4 — `try_recv` doesn't reset `pending` on error → stuck pump** (`native/windows-tap/src/tap_win6.rs:92-130`). Clear `read.pending` and reset the event on every failure return.

## Test only after all of the above

## Other findings (deferred)

### Critical / High

- [ ] **C2 — No CI runs typecheck, build, or tests**. Only `.github/workflows/prerelease.yml` exists. Add `ci.yml` that runs `npm run typecheck`, `npm run build:linux`, `cargo check --target x86_64-pc-windows-gnu`, and the conformity bench.
- [ ] **H1 — `enroll-self` accepts unvalidated authorized_keys content** (`src/daemon/handlers.ts:303-316`). Reject pubkey strings with `\n`, `\r`, or leading `command=`/`environment=` options.
- [ ] **H2 — OTP is biased + no rate-limit** (`src/daemon/handlers.ts:271`, `systemd/sshd_config.snippet`). Switch to higher-entropy base32 + add `MaxAuthTries 3` to the Match block.
- [ ] **H3 — OTP expiry enforced only by 60 s timer; `passwd -l` failures swallowed silently** (`src/daemon/handlers.ts:485-498`, `src/daemon/server.ts:49-54`). Schedule a per-OTP `setTimeout(passwd -l, ttl)` at mint time + log failures.
- [ ] **H4 — `mad tun join` on Linux has zero SIGINT/SIGTERM cleanup → Ctrl+C leaks the local tap** (`src/commands/tunClient.ts:176`). Add signal handlers mirroring `windowsTunClient.ts`.
- [ ] **H5 — `tun-state.json` written non-atomically; lost mid-write resets `nextSerial` → cert serial reuse → KRL bypass** (`src/daemon/state.ts:30-37`). `write tmp → fsync → rename` + refuse to start on parse error.
- [ ] **H6 — `/24 subnet route heuristic` only correct for /24 groups** (`src/commands/tunClient.ts:147`, `src/commands/windowsTunClient.ts:231`). Have the daemon emit `subnet=<cidr>` in `MAD_TUN_OK` and use it verbatim.
- [ ] **H7 — `transmute_proc` over `FARPROC` works by accident** (`native/windows-tap/src/wintun.rs:120-123`). Pattern-match `Some(fn)` in `resolve` and pass the bare fn pointer.
- [ ] **H8 — `Pump::stop()` load-bearing invariant: captured `Arc<dyn Backend>` keeps event handles alive** (`native/windows-tap/src/pump.rs:185-204`). Either document or restructure into a guard struct.
- [ ] **H9 — `mad_l2_create_adapter` shells `netsh` with unvalidated `mad-<group>`** (`native/windows-tap/src/tap_win6.rs:472-484`). Independent regex validation in Rust.
- [ ] **H10 — `marshalArgv` lifetime hazard** (`src/utils/winNative.ts:69-79`). Keep `data` buffer alive across the FFI call.
- [ ] **H12 — OTP enrollment flow has zero automated coverage** (`tests/conformity/init/gateway-init.sh:18-32`).
- [ ] **H13 — CA/KRL/cert lifecycle never exercised end-to-end**.
- [ ] **H14 — TAP-Windows6 IOCTL passes same `&u32` as both `*const` and `*mut` (UB)** (`native/windows-tap/src/tap_win6.rs:561-563`).

### Medium / Low

- [ ] **M** Field `socatPid` (state) + value (sshPid) + header (socatPid) — three names for one PID column (`src/commands/tunClient.ts:165, 215`).
- [ ] **M** `assertValidName` not called on every code path that takes a name (e.g., resolved `username` after `id -nu`) (`src/daemon/handlers.ts:303-316`).
- [ ] **M** `SO_PEERCRED` uses `socket._handle.fd` (Node private) — no per-request re-check (`src/daemon/peercred.ts:24-40`).
- [ ] **M** `forgetUserKeysAll` hardcodes `/home/<user>/...` — non-standard homes aren't de-keyed (`src/commands/admin/user.ts:11`).
- [ ] **M** `parseInt(opts.serial)` accepts partial parses (`src/cli.ts:192,203`).
- [ ] **M** `mad doctor --install-l2-driver` downloads installer with no integrity check (`src/commands/doctor.ts:18-39`).
- [ ] **M** Per-frame `CreateEventW`/`CloseHandle` in TAP-Windows6 `send` — perf cliff (`native/windows-tap/src/tap_win6.rs:132-169`).
- [ ] **M** `WintunAdapter: Sync` overstates wintun's thread-safety contract (`native/windows-tap/src/wintun.rs:138-139`).
- [ ] **M** `pump.rs:108` leaks ssh child if `recv_wait_handle()` fails after spawn.
- [ ] **M** Conformity bench has no L2 (TAP) coverage.
- [ ] **M** No crash/kill cleanup test.
- [ ] **M** State-file recovery untested.
- [ ] **M** `winAssets.ts` static `import x with { type: "file" }` likely bloats Linux/macOS builds (`src/utils/winAssets.ts:27-28`).
- [ ] **M** Asymmetric L2-fallback policy: macOS falls back to L3, Windows hard-errors.
- [ ] **M** Cleanup paths swallow all errors.
- [ ] **M** `nextHost` counter never wraps or recycles released IPs (`src/daemon/handlers.ts:204-220`).
- [ ] **L** `setup.ts:97` uses `spawnSync(..., { shell: true })` for a static command.
- [ ] **L** CA cert default validity is 520 weeks (~10 years).
- [ ] **L** `mad otp <user>` prints OTP to admin terminal with no audit-log entry.
- [ ] **L** `RegQueryValueExW` consumer doesn't reject odd `data_size`.
- [ ] **L** `mad_last_error` doesn't NUL-terminate when `n == cap`.
- [ ] **L** Mixed ESM/CJS in `cli.ts` (`require("fs")` in an ESM file at lines 218–248).
- [ ] **L** Unused imports in `cli.ts:2`.
- [ ] **L** `runMenu` swallows error types + writes errors to stdout (`src/menu.ts:51,88-90,102-104`).
- [ ] **L** `process.exit(-1)` becomes 255 — indistinguishable from real bugs (`src/cli.ts:553`).
