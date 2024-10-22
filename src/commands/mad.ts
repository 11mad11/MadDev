import { readFile } from "fs/promises";
import { quote } from "shescape/stateless";
import { cmdDef, cmdMenu } from "../shell";
import { createCommand } from "@commander-js/extra-typings";
import { FixedInquirer } from "../utils/inquirer";
import { User } from "../gateway";

export default cmdMenu({
    text: "Installation",
    children: [
        cmdDef({
            cmd: () => createCommand("mad-config").summary("Create configuration file").argument("[ip]").argument("[port]"),
            perm: (ctx) => ctx.mode === "exec",
            async pty(ctx) {
                return false;
            },
            async run({ channel, inquirer, user, pty }, opts, ip, port) {
                if (!pty) {
                    channel.stderr.write("Error: This command should be call from a tty");
                    return;
                }
                const rep = await askConfig(inquirer, user, ip, port);

                channel.write("Writting config file...\n");
                channel.write("\f\n");
                channel.write(rep.script);
                channel.eof();
            }
        }),
        cmdDef({
            cmd: () => createCommand("download").summary("Script download"),
            perm: (ctx) => ctx.mode === "exec",
            async pty() {
                return false;
            },
            async run({ channel }, opts) {
                channel.write("#!/usr/bin/env bash\n");
                channel.write((await readFile("./src/bash/mad/config.sh")).toString());
                channel.write("\n");
                channel.write((await readFile("./src/bash/mad/logic.sh")).toString());
                channel.write("\n");
                channel.eof();
            },
        }),
        cmdDef({
            cmd: () => createCommand("install").summary("Script install"),
            perm: (ctx) => ctx.mode === "exec",
            async pty() {
                return false;
            },
            async run({ channel }, opts) {
                channel.write((await readFile("./src/bash/mad/install.sh")).toString());
                channel.write("\n");
                channel.eof();
            },
        }),
        cmdDef({
            cmd: () => createCommand("nix"),
            perm: (ctx) => ctx.mode === "exec",
            async pty() { return false; },
            async run(ctx, opts, ...args) {
                const rep = await askConfig(ctx.inquirer, ctx.user);
                const rawNix = (await readFile("./src/bash/mad/default.nix")).toString();
                const scriptRaw = rep.script + (await readFile("./src/bash/mad/logic.sh")).toString();
                const script = rawNix.replace("[[script]]", scriptRaw.replace(/(\$){/g, "''\${"));

                ctx.channel.write("Writting config file...\n");
                ctx.channel.write("\f\n");
                ctx.channel.write(script);
                ctx.channel.eof();
            },
        })
    ]
});

async function askConfig(inquirer: FixedInquirer, user: User, defaultIp?: string, defaultPort?: string) {
    const rep = {
        username: await inquirer.input({
            message: "Username",
            required: true,
            default: user.username
        }),
        ip: await inquirer.input({
            message: "Server Address",
            required: true,
            default: defaultIp
        }),
        port: await inquirer.input({
            message: "Port",
            validate(value) {
                return String(parseInt(value, 10)) == value || "Should be a number"
            },
            default: defaultPort ?? "22",
            required: true
        }),
        key: await inquirer.input({
            message: "Private key location",
            default: "~/.ssh/id_rsa",
            required: true
        })
    };

    let script = "";
    script += "key=" + quote(rep.key, { shell: true });
    script += "\n";
    script += "ssh_user=" + quote(rep.username, { shell: true });
    script += "\n";
    script += "ssh_ip=" + quote(rep.ip, { shell: true });
    script += "\n";
    script += "ssh_port=" + quote(rep.port, { shell: true });
    script += "\n";

    return {
        ...rep,
        script
    }
}