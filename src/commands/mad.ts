import { cmd, fixedInquirer, getInquirerContext } from "./_helper";
import { readFile } from "fs/promises";
import { quote } from "shescape/stateless";

export default cmd(({ user, prog, channel }) => {
    const cmd = prog.command("mad")

    cmd.command("config <ip> [port]").action(async (defaultIp, defaultPort) => {
        const rep = await askConfig(defaultIp, defaultPort);

        channel.write("Writting config file...\n");
        channel.write("\f\n");
        channel.write(rep.script);
        channel.eof();
    })

    cmd.command("download").action(async () => {
        channel.write("#!/usr/bin/env bash\n");
        channel.write((await readFile("./src/bash/mad/config.sh")).toString());
        channel.write("\n");
        channel.write((await readFile("./src/bash/mad/logic.sh")).toString());
        channel.write("\n");
        channel.eof();
    })

    cmd.command("nix").action(async () => {
        const rep = await askConfig();
        const rawNix = (await readFile("./src/bash/mad/default.nix")).toString();
        const scriptRaw = rep.script + (await readFile("./src/bash/mad/logic.sh")).toString();
        const script = rawNix.replace("[[script]]", scriptRaw.replace(/(\$){/g, "''\${"));

        channel.write("Writting config file...\n");
        channel.write("\f\n");
        channel.write(script);
        channel.eof();
    })

    async function askConfig(defaultIp?: string, defaultPort?: string) {
        const ctx = getInquirerContext(channel);
        const inquirer = fixedInquirer(ctx);
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
})