import { readFileSync } from "fs";
import { Cmd, cmdDef, cmdMenu } from "../shell";
import { createCommand } from "@commander-js/extra-typings";

export default [
    cmdDef({
        cmd: () => createCommand("tun").summary("Open a Tunnel").argument("<service>"),
        perm(ctx) {
            return !ctx.pty;
        },
        async pty(ctx) {
            throw new Error("Can't be interactive");
        },
        async run(ctx, opts, service) {
            const s = ctx.gateway.services[2].services.get(service);
            if (!s)
                throw new Error("No service by name: " + service)

            await new Promise<void>((resolve, reject) => {
                s.connect(ctx.user.username, ctx.channel);
                ctx.channel.on("close", () => {
                    resolve();
                })
            });
        },
    }),
    cmdDef({
        cmd: () => createCommand("tun-ip").summary("Get ip for tunnel").argument("<service>"),
        perm(ctx) {
            return true;
        },
        async pty(ctx) {
            return [
                [
                    await ctx.inquirer.input({ message: "Service name" })
                ] as const,
                {}
            ]
        },
        async run(ctx, opts, service) {
            const s = ctx.gateway.services[2].services.get(service);
            if (!s)
                throw new Error("No service by name: " + service)

            ctx.output.write(s.getSubnet(ctx.user.client) + "\n");
        },
    })
];
/*
export default cmd(({ channel, user, prog, gateway }) => {
    const cmd = prog.command("tun");

    cmd.command("getSubnet <service>").action((service)=>{
        
    })

    cmd.command("open <service>").action((service) => {
        const s = gateway.services[2].services.get(service);
        if (!s)
            throw new Error("No service by name: " + service)

        return new Promise((resolve, reject) => {
            s.connect(user.username, channel);
            channel.on("close", () => {
                resolve();
            })
        })
    })
});*/