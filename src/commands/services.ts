import { createCommand } from "@commander-js/extra-typings";
import { cmdDef, cmdMenu } from "../menu";
import { listServices } from "../services/discover";
import { installForwarding, installSshShare } from "./install";

export const serviceList = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("service-ls").summary("List available services"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const services = listServices();
        if (!services.length) {
            ctx.output.write("(none visible)\n");
            return;
        }
        for (const s of services) {
            ctx.output.write(`${s.group}/${s.name}\t${s.socketPath}\n`);
        }
    },
});

function hostHint(ctx: { username: string }) {
    return `${ctx.username}@<server>`;
}

export const serviceRegister = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("service-register").summary("Print ssh -R to register a service"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        const name = await ctx.inquirer.input({ message: "Service name" });
        const target = await ctx.inquirer.input({ message: "Local target (host:port)", default: "localhost:8080" });
        return [[group, name, target] as const, {}];
    },
    async run(ctx, _opts, group, name, target) {
        ctx.output.write(`Run this from the host of the service:\n`);
        ctx.output.write(`  ssh -R /run/mad/groups/${group}/${name}.sock:${target} ${hostHint(ctx)}\n`);
    },
});

export const serviceUse = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("service-use").summary("Print ssh -L to use a service"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        const name = await ctx.inquirer.input({ message: "Service name" });
        const localPort = await ctx.inquirer.input({ message: "Local port to listen on", default: "9000" });
        return [[group, name, localPort] as const, {}];
    },
    async run(ctx, _opts, group, name, localPort) {
        ctx.output.write(`Run this on the machine that wants the service:\n`);
        ctx.output.write(`  ssh -L ${localPort}:/run/mad/groups/${group}/${name}.sock ${hostHint(ctx)}\n`);
    },
});

export default cmdMenu({
    text: "Services",
    children: [serviceList, serviceRegister, serviceUse, installForwarding, installSshShare],
});
