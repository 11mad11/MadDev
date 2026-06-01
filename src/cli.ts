import { Command } from "@commander-js/extra-typings";
import menu from "./commands";
import { runMenu, menuToTree, Ctx } from "./menu";
import { runHelpCli } from "./commands/help";
import { fixedInquirer } from "./utils/inquirer";
import { currentUid, currentUsername, getCurrentUserGroups } from "./groups";
import { daemon } from "./daemon/client";
import { runDaemon } from "./daemon/server";
import { requireLinuxRoot } from "./utils/platform";
import { runEnroll } from "./commands/enroll";

function buildCtx(mode: "shell" | "exec"): Ctx {
    const input = process.stdin;
    const output = process.stdout;
    const uid = currentUid();
    const groups = getCurrentUserGroups();
    // root bypasses the mad-admin gate — it can do everything anyway.
    if (uid === 0 && !groups.includes("mad-admin")) groups.push("mad-admin");
    return {
        username: currentUsername(),
        uid,
        groups,
        input,
        output,
        inquirer: fixedInquirer({ input, output }),
        mode,
    };
}

async function main() {
    const program = new Command();
    program.name("mad").description("Linux-native SSH gateway helper");

    // ---- top-level commands that aren't in the interactive menu --------
    // (most provisioning lives under `mad system *` — these are the
    // three exceptions: daemon is started by systemd, enroll is a
    // one-shot first-connect flow, tun-attach is sshd ForceCommand
    // glue invoked by the tun client.)

    program.command("daemon")
        .description("Run the privileged daemon (root)")
        .action(async () => {
            requireLinuxRoot("mad daemon");
            await runDaemon();
        });

    program.command("enroll")
        .description("First-time enrollment: writes your pubkey to authorized_keys and locks the OTP password")
        .action(async () => {
            await runEnroll();
        });

    // `mad help` (no subcommand) shows the docs index. The Help menu
    // parent has cliName="help"; the walker reuses this Commander
    // command and adds each topic as a real subcommand, so
    // `mad help install` etc. become discoverable in --help and tab
    // completion. Unknown topics get a Commander "unknown command" —
    // that's intentional per the menu/CLI alignment decision.
    program.command("help")
        .description("Render a doc page in the terminal")
        .action(() => runHelpCli(undefined));

    program.command("tun-attach")
        .description("Gateway-side glue for `ssh <gw> mad tun-attach <group>` — pumps length-prefixed Ethernet frames between stdio and a daemon-allocated tap")
        .argument("<group>")
        .option("--l3", "Use L3 (TUN) instead of L2 (TAP)")
        .action(async (group, opts) => {
            const mode: "l2" | "l3" = opts.l3 ? "l3" : "l2";
            const r = await daemon.tapAllocate(group, mode);

            // Single control line on stderr — the client parses this; stdout
            // is the (framed) data channel and must stay clean.
            process.stderr.write(`MAD_TUN_OK ${r.ifname} ${r.ip} peer=${r.peerIp} group=${r.group} mode=${r.mode}\n`);

            const { openTap, pump } = await import("./utils/tapPipe");
            const fd = openTap(r.ifname, r.mode);

            // Usage metering: count bytes/packets in each direction, flush
            // deltas to the daemon every 60s and once more in cleanup() so
            // an abrupt SSH drop only loses the last sub-60s slice.
            const totals = { rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0 };
            const counters = {
                addTx(bytes: number) { totals.txBytes += bytes; totals.txPackets += 1; },
                addRx(bytes: number) { totals.rxBytes += bytes; totals.rxPackets += 1; },
            };
            const sessionStart = Date.now();
            let lastFlush = sessionStart;
            const flushed = { rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0 };
            // Serialize flushes: an in-flight 60s tick must finish before
            // cleanup's final flush starts, otherwise overlapping windows
            // would double-bill the bytes counted while the tick was awaiting.
            let pending: Promise<void> = Promise.resolve();
            const flush = (): Promise<void> => {
                pending = pending.then(async () => {
                    const windowStart = lastFlush;
                    const windowEnd = Date.now();
                    const drx = totals.rxBytes - flushed.rxBytes;
                    const dtx = totals.txBytes - flushed.txBytes;
                    const drxp = totals.rxPackets - flushed.rxPackets;
                    const dtxp = totals.txPackets - flushed.txPackets;
                    if (drx === 0 && dtx === 0) { lastFlush = windowEnd; return; }
                    try {
                        await daemon.usageRecord([{
                            kind: r.mode === "l2" ? "tap" : "tun",
                            uid: r.uid,
                            username: r.username,
                            group: r.group,
                            ifname: r.ifname,
                            mode: r.mode,
                            windowStart, windowEnd,
                            rxBytes: drx, txBytes: dtx,
                            rxPackets: drxp, txPackets: dtxp,
                        }]);
                        flushed.rxBytes += drx;
                        flushed.txBytes += dtx;
                        flushed.rxPackets += drxp;
                        flushed.txPackets += dtxp;
                        lastFlush = windowEnd;
                    } catch (e: any) {
                        // Best-effort; next tick retries with the still-larger delta.
                        process.stderr.write(`mad tun-attach usage flush: ${e?.message ?? e}\n`);
                    }
                });
                return pending;
            };
            const flushTick = setInterval(() => { flush(); }, 60 * 1000);

            let cleaning = false;
            const cleanup = async () => {
                if (cleaning) return;
                cleaning = true;
                clearInterval(flushTick);
                await flush();
                try { await daemon.tunRelease(r.ifname); } catch {}
                process.exit(0);
            };
            process.on("SIGHUP", cleanup);
            process.on("SIGTERM", cleanup);
            process.on("SIGINT", cleanup);
            const originalPpid = process.ppid;
            setInterval(() => {
                if (process.ppid !== originalPpid) cleanup();
            }, 1000);

            try {
                await pump({ fd, remoteIn: process.stdin, remoteOut: process.stdout, counters });
            } catch (e: any) {
                process.stderr.write(`mad tun-attach pump: ${e.message}\n`);
            }
            await cleanup();
        });

    // ---- menu commands (gateway/service/ca/cert/tap/tun/admin) ---------
    // menuToTree walks the menu tree and side-effects `program`, adding
    // a Commander subcommand for every MenuNodeParent with a cliName +
    // wrapping each leaf Cmd's action with its perm() check.
    const ctx = buildCtx("exec");
    await menuToTree(ctx, menu, program);

    // Default action (no subcommand, TTY) drops into the interactive menu.
    program.action(async () => {
        const shellCtx = buildCtx("shell");
        const code = await runMenu(shellCtx, menu);
        process.exit(code);
    });

    program.exitOverride();

    const original = process.env.SSH_ORIGINAL_COMMAND;
    const argv = original
        ? ["node", "mad", ...original.split(/\s+/).filter(Boolean)]
        : process.argv;

    try {
        await program.parseAsync(argv);
    } catch (e: any) {
        if (e?.code === "commander.helpDisplayed" || e?.code === "commander.help") return;
        process.stderr.write((e?.message ?? String(e)) + "\n");
        process.exit(e?.exitCode ?? 1);
    }
}

main();
