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
import { runSetup } from "./commands/setup";
import { runUpdate } from "./commands/update";
import { sshConfigBlock, gatewayHost } from "./utils/sshConfig";

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

    program.command("daemon")
        .description("Run the privileged daemon (root)")
        .action(async () => {
            requireLinuxRoot("mad daemon");
            await runDaemon();
        });

    program.command("setup")
        .description("Idempotently provision groups, dirs, CA, sshd snippet, and systemd unit (root)")
        .action(async () => {
            requireLinuxRoot("mad setup");
            await runSetup();
        });

    program.command("update")
        .description("git pull + bun install + setup + restart daemon (root)")
        .action(async () => {
            requireLinuxRoot("mad update");
            await runUpdate();
        });

    program.command("enroll")
        .description("First-time enrollment: writes your pubkey to authorized_keys and locks the OTP password")
        .action(async () => {
            await runEnroll();
        });

    program.command("help")
        .description("Render a doc page in the terminal")
        .argument("[topic]", "doc file under docs/ (omit for the index)")
        .action((topic) => runHelpCli(topic));

    program.command("ssh-config")
        .description("Print an ssh_config Host block for paste-into-~/.ssh/config")
        .option("--alias <name>", "Host alias", "mad")
        .option("--host <hostname>", "Override the gateway hostname")
        .action(async (opts) => {
            const host = gatewayHost(opts.host);
            process.stdout.write(sshConfigBlock(opts.alias!, host, currentUsername()));
        });

    program.command("doctor")
        .description("Diagnose mad client setup; can install missing Windows L2 driver")
        .option("--install-l2-driver", "Download and run the TAP-Windows6 installer (Windows only, UAC)")
        .action(async (opts) => {
            const { runDoctor } = await import("./commands/doctor");
            await runDoctor(opts);
        });

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

            let cleaning = false;
            const cleanup = async () => {
                if (cleaning) return;
                cleaning = true;
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
                await pump({ fd, remoteIn: process.stdin, remoteOut: process.stdout });
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
