import { createCommand } from "@commander-js/extra-typings";
import { spawnSync } from "child_process";
import chalk from "chalk";
import { cmdDef } from "../../menu";
import { isMadGateway } from "../../utils/sshConfig";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("test").summary("Round-trip-ping a gateway and print its CA pubkey").argument("<alias>"),
    async pty(ctx) {
        const alias = await ctx.inquirer.input({ message: "Alias" });
        return [[alias] as const, {}];
    },
    async run(ctx, _opts, alias) {
        if (!isMadGateway(alias)) {
            ctx.output.write(chalk.yellow(`'${alias}' isn't marked as a mad gateway (no SetEnv MAD_GATEWAY=1)\n`));
        }
        const t0 = Date.now();
        const r = spawnSync("ssh", [alias, "ca", "pubkey"], { encoding: "utf-8" });
        const ms = Date.now() - t0;
        if (r.status === 0) {
            ctx.output.write(`✔ ${alias}  ${ms}ms\n  CA: ${(r.stdout ?? "").trim()}\n`);
        } else {
            ctx.output.write(chalk.red(`✘ ${alias} failed:\n  ${(r.stderr ?? "").trim()}\n`));
            process.exitCode = 1;
        }
    },
});
