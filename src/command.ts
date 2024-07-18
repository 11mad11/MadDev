import { SSHGateway, User } from "./gateway";
import { Command } from "@commander-js/extra-typings";
import { ServerChannel } from "ssh2";

export type CommandRegister = (ctx: { gateway: SSHGateway, user: User, prog: Command, channel: ServerChannel }) => void

export class CommandManager {

    constructor(
        public gateway: SSHGateway
    ) {

    }

    async exec(user: User, channel: ServerChannel, command: string) {
        const prog = new Command();
        const ctx: Parameters<CommandRegister>[0] = {
            gateway: this.gateway,
            channel,
            prog,
            user
        };

        prog.exitOverride((err) => { throw err });
        prog.configureOutput({
            writeErr(str) {
                channel.stderr.write(str)
            },
            writeOut(str) {
                channel.write(str)
            },
        });

        (await import("./commands/otp")).default(ctx);
        (await import("./commands/signsshkey")).default(ctx);
        (await import("./commands/tun")).default(ctx);
        (await import("./commands/mad")).default(ctx);
        (await import("./commands/admin")).default(ctx);
        (await import("./commands/readme")).default(ctx);

        try {
            await prog.parseAsync(command.split(" "), { from: 'user' })
            channel.exit(0);
            channel.end();
            channel.close();
        } catch (err) {
            channel.stderr.write(err?.toString?.());
            channel.exit(err.exitCode ?? 1);
            channel.end();
            channel.close();
        }
    }

}