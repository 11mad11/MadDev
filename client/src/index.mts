import { program } from "@commander-js/extra-typings";
import { input } from '@inquirer/prompts';
import { mergician } from 'mergician';
import chalk from "chalk";
import { closeSync, createWriteStream, fdatasyncSync, openSync, readFileSync, writeFileSync, writeSync, writevSync } from "fs";
import { NodeSSH } from "node-ssh"
import { userInfo } from "os";
import tmp from "tmp";
import type { Duplex, Readable } from "stream";
import { execSync } from "child_process";

tmp.setGracefulCleanup();

const APP_NAME = `mad`;
const CONFIG_FILE = `${process.env["HOME"]}/.mad/configuration.cfg`;
const SSH_KEY_FILE = `${process.env["HOME"]}/.ssh/id_rsa`;

let config = {
    host: undefined as string | undefined,
    port: 22,
    user: userInfo().username
};

async function connect(overwrite?: any) {
    const ssh = new NodeSSH();
    await ssh.connect({
        host: config.host,
        port: config.port,
        username: config.user,
        privateKeyPath: SSH_KEY_FILE,
        algorithms: {
            serverHostKey: {
                append: ["ssh-ed25519"],
                prepend: [],
                remove: []
            }
        },
        ...overwrite
    });
    return ssh;
}

const setup_cmd = program.command("setup");
setup_cmd.action(async () => {
    console.log("\n" + chalk.bgWhite.underline.black("  Welcome!  ") + "\n");

    config.host = await input({
        message: "What is the host of the server?",
        required: true,
        default: config.host,
        transformer: (v) => v.trim()
    });
    config.port = parseInt(await input({
        message: "What is the port of the ssh server?",
        required: true,
        default: String(config.port),
        transformer: (v) => v.trim(),
        validate: (value) => String(parseInt(value, 10)) === value || "Must be a number"
    }), 10);
    config.user = await input({
        message: "What is your username?",
        required: true,
        default: config.user,
        transformer: (v) => v.trim()
    });

    console.log(`If an OTP is provided, this script will register your ssh key with the server under the user given`);
    const otp = await input({ message: "What is your otp?(left empty to skip)", transformer: (v) => v.trim() });
    if (otp) {
        console.debug(`Connecting to ssh server "${config.user}@${config.host}:${config.port}" with key at "${SSH_KEY_FILE}"`);

        const ssh = await connect({
            password: otp
        });

        ssh.dispose();
    }

    console.debug(`Writting configuration file "${CONFIG_FILE}"`);

    const raw = JSON.stringify(config);
    writeFileSync(CONFIG_FILE, raw);

    console.log("\n" + chalk.bgWhite.underline.black(" You are now good to go! ") + "\n");
    console.log(`Enter this command for getting started: ${chalk.yellow(APP_NAME + " help")}`);
});


program.command("update").action(async () => {
    /*
    ssh_cmd mad download ${key} ${ssh_ip} ${ssh_port} ${ssh_user} | tee /tmp/newmad.sh > /dev/null
    {
        sudo rm ${SCRIPT}
        sudo mv /tmp/newmad.sh ${SCRIPT}
        sudo chmod +x ${SCRIPT}
        echo "Updated!"
    }
    */

    if (!Bun.main.startsWith("/$bunfs"))
        throw new Error("Cannot update from source");

    const ssh = await connect();

    //File is bigger than what a string can hold, so I use streams
    //https://bun.sh/blog/bun-v1.1.23#fixed-fs-readfile-memory-size-limits
    await new Promise<void>((resolve, reject) => {
        ssh.connection!.exec("install", {}, (err, channel) => {
            if (err)
                return reject(err);

            const scriptFile = tmp.fileSync({
                mode: 0o755
            });

            let pos = 0;
            (channel as Readable).on('data', (chunk: Buffer) => {
                pos += writeSync(scriptFile.fd, chunk, 0, chunk.length, pos)
            });

            (channel as Readable).on('close', () => {
                resolve();
                fdatasyncSync(scriptFile.fd);
                closeSync(scriptFile.fd);
                execSync(`${scriptFile.name} -np ${process.execPath}`);
            });
        })
    });

    ssh.dispose();
})

program.command("test").action(async () => {
    console.log("b");
})

program.hook("preAction", (_t, a) => {
    const cmd_name = (a as any)._name;

    console.debug(`Reading configuration file "${CONFIG_FILE}"`);

    try {
        const raw = readFileSync(CONFIG_FILE).toString();
        const parsed = JSON.parse(raw);
        config = mergician({
            dedupArrays: true,
            sortArrays: true
        })(config, parsed);
    } catch (e) {
        // The user do not need to know if there's an error in the config in setup, as it would be overwritten
        if (cmd_name === "setup")
            return;

        console.error("You may have an old or corrupted config file");
        console.error(`Run '${APP_NAME} setup' to rewrite the config file`);
        throw e;
    }
});

await program.parseAsync();