import { readFileSync } from "fs";
import { cmd } from "./_helper";
import { input as inputO } from '@inquirer/prompts';
import { readFile } from "fs/promises";
import { ServerChannel } from "ssh2";
import { Readable, Writable } from "stream";
import { quote } from "shescape/stateless";

function input(...args: Parameters<typeof inputO>): ReturnType<typeof inputO> {
    const prompt = inputO(...args);
    args[1]?.input?.on("close", () => {
        prompt.cancel();
    })
    return prompt;
}

export default cmd(({ user, prog, channel }) => {
    const cmd = prog.command("mad").action(async () => {
        const ctx = {
            input: createProxy(channel, "in"),
            output: createProxy(channel, "out")
        };
        const username = await input({
            message: "Username",
            required: true,
            default: user.username
        }, ctx);
        const ip = await input({
            message: "Server Address",
            required: true
        }, ctx);
        const port = await input({
            message: "Port",
            validate(value) {
                return String(parseInt(value, 10)) == value || "Should be a number"
            },
            default: "22",
            required: true
        }, ctx);
        const key = await input({
            message: "Private key location",
            default: "~/.ssh/id_rsa",
            required: true
        }, ctx);

        channel.write("Enter these command to download the utility script:\n");
        {
            channel.write(`ssh default@${ip}`)
            if (port != "22")
                channel.write(` -p ${port}`)
            channel.write(` mad download ${key} ${ip} ${port} ${username}`);
            channel.write(` > mad.sh\n`);
            channel.write(`chmod +x mad.sh\n\n`);
        }

        channel.write(`If you do not want to use a password:\n`);
        {
            channel.write(`./mad.sh sign`);
        }
    });

    function complete(raw: string, list: [start: string, end: string][]) {
        for (const item of list) {
            raw = raw.replace(item[0], item[0] + quote(item[1], { shell: true }))
        }
        return raw;
    }

    cmd.command("download <key> <ip> <port> <username>").action(async (key, ip, port, username) => {
        const raw = (await readFile("./src/bash/templates/mad.sh")).toString();
        const modified = complete(raw, [
            ["key=", key],
            ["ssh_server=", `${username}@${ip} -p ${port}`],
            ["ssh_user=", username],
            ["ssh_ip=", ip],
            ["ssh_port=", port],
        ]);

        channel.write(modified);
        channel.eof();
    })
})


function createProxy<T extends object>(obj: T, name: string): T {
    return new Proxy(obj, {
        get(target, property, receiver) {
            if (property === "end")
                return () => { }
            if (property === "eof")
                return () => { }
            if (property === "close")
                return () => { }
            //console.log(`Property accessed: ${String(property)} on ${name}`);
            return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
            //console.log(`Property set: ${String(property)} = ${value}`);
            return Reflect.set(target, property, value, receiver);
        }
    });
}