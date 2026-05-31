import { createCommand } from "@commander-js/extra-typings";
import { spawnSync } from "child_process";
import chalk from "chalk";
import { Cmd, cmdDef, cmdMenu } from "../menu";
import {
    appendHostBlock,
    isMadGateway,
    listMadGateways,
    removeHostBlock,
} from "../utils/sshConfig";

function parseUserHost(spec: string): { user: string; host: string } {
    const m = spec.match(/^([^@]+)@(.+)$/);
    if (!m) throw new Error(`expected user@host, got '${spec}'`);
    return { user: m[1], host: m[2] };
}

function defaultAlias(host: string): string {
    return host.split(".")[0];
}

export const gatewayAdd = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("add")
        .summary("Add a mad gateway as a Host block in ~/.ssh/config")
        .argument("<user@host>")
        .option("--alias <name>", "Host alias to use (defaults to the hostname's first label)"),
    async pty(ctx) {
        const spec = await ctx.inquirer.input({ message: "user@gateway-host" });
        const alias = await ctx.inquirer.input({ message: "Local alias", default: defaultAlias(parseUserHost(spec).host) });
        return [[spec, alias] as const, {}];
    },
    async run(ctx, opts, spec, aliasFromPty) {
        const { user, host } = parseUserHost(spec);
        const alias = (aliasFromPty as string | undefined) ?? (opts as any).alias ?? defaultAlias(host);
        appendHostBlock(alias, host, user);
        ctx.output.write(`✦ added Host ${alias} → ${user}@${host} (SetEnv MAD_GATEWAY=1)\n\n`);
        ctx.output.write("Verifying reachability (this triggers ssh's known_hosts prompt on first contact)...\n");
        const r = spawnSync("ssh", ["-o", "StrictHostKeyChecking=accept-new", alias, "ca", "pubkey"], { encoding: "utf-8" });
        if (r.status === 0) {
            ctx.output.write("\n" + chalk.green(`✔ ${alias} responds with`) + " " + (r.stdout ?? "").trim() + "\n");
            ctx.output.write(`\nTry: ${chalk.yellow("mad service ls")} (now fans out across your gateways)\n`);
        } else {
            ctx.output.write("\n" + chalk.yellow(`! ${alias} added to ssh_config, but \`ssh ${alias} ca pubkey\` failed:`) + "\n");
            ctx.output.write("  " + (r.stderr ?? "").trim() + "\n");
        }
    },
});

export const gatewayList = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ls").summary("List the mad gateways in your ssh_config"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const gws = listMadGateways();
        if (gws.length === 0) {
            ctx.output.write("(no gateways — add one with `mad gateway add user@host`)\n");
            return;
        }
        for (const g of gws) ctx.output.write(`${g.alias}\t${g.user}@${g.hostName}\n`);
    },
});

export const gatewayRemove = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("rm").summary("Remove a gateway's Host block from ~/.ssh/config").argument("<alias>"),
    async pty(ctx) {
        const alias = await ctx.inquirer.input({ message: "Alias to remove" });
        return [[alias] as const, {}];
    },
    async run(ctx, _opts, alias) {
        const removed = removeHostBlock(alias);
        if (removed) ctx.output.write(`removed Host ${alias}\n`);
        else ctx.output.write(`no Host '${alias}' found\n`);
    },
});

export const gatewayTest = cmdDef({
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
        }
    },
});

export default cmdMenu({
    text: "Gateways",
    children: [gatewayAdd, gatewayList, gatewayRemove, gatewayTest],
});
