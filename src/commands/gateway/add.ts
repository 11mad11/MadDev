import { createCommand } from "@commander-js/extra-typings";
import { spawnSync } from "child_process";
import chalk from "chalk";
import { cmdDef } from "../../menu";
import { appendHostBlock } from "../../utils/sshConfig";

function parseUserHost(spec: string): { user: string; host: string } {
    const m = spec.match(/^([^@]+)@(.+)$/);
    if (!m) throw new Error(`expected user@host, got '${spec}'`);
    return { user: m[1], host: m[2] };
}

function defaultAlias(host: string): string {
    return host.split(".")[0];
}

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("add")
        .summary("Append a Host block for a gateway in ~/.ssh/config")
        .argument("<user@host>")
        .option("--alias <name>", "Host alias (defaults to the hostname's first label)"),
    async pty(ctx) {
        const spec = await ctx.inquirer.input({ message: "user@gateway-host" });
        const alias = await ctx.inquirer.input({ message: "Local alias", default: defaultAlias(parseUserHost(spec).host) });
        return [[spec] as const, { alias }] as any;
    },
    async run(ctx, opts, spec) {
        const { user, host } = parseUserHost(spec);
        const alias = (opts as any).alias ?? defaultAlias(host);
        appendHostBlock(alias, host, user);
        ctx.output.write(`✦ added Host ${alias} → ${user}@${host} (SetEnv MAD_GATEWAY=1)\n`);
        const r = spawnSync("ssh", ["-o", "StrictHostKeyChecking=accept-new", alias, "ca", "pubkey"], { encoding: "utf-8" });
        if (r.status === 0) {
            ctx.output.write(chalk.green(`✔ ${alias} CA: ${(r.stdout ?? "").trim()}\n`));
        } else {
            ctx.output.write(chalk.yellow(`! ssh ${alias} ca pubkey failed: ${(r.stderr ?? "").trim()}\n`));
        }
    },
});
