import { SSHGateway, User } from "./gateway";
import { Command, Option, OptionValues } from "@commander-js/extra-typings";
import { PseudoTtyInfo, ServerChannel } from "ssh2";
import { FixedInquirer, TreeNodeParent, fixedInquirer, getInquirerContext } from "./utils/inquirer";
import { Duplex } from "stream";
import menu from "./commands"

export interface Ctx {
    gateway: SSHGateway,
    user: User,
    channel: ServerChannel,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    inquirer: FixedInquirer,
    pty: false | PseudoTtyInfo,
    mode: "shell" | "exec"
}

type ConvertOpts<T extends OptionValues = {}> = {
    [K in keyof T]: T[K] extends true ? boolean : T[K];
};
export interface Cmd<Args extends any[] = [], Opts extends OptionValues = {}> {
    perm(ctx: Ctx): boolean | Promise<boolean>
    cmd(): Command<Args, Opts>
    /*cmd: {
        name: string
        summary: string
        args?: Args
        opts?: {
            [key in keyof Opts]: {
                default: Opts[key],
                desc: string
            }
        }
    }*/
    pty(ctx: Ctx): Promise<[Args, ConvertOpts<Opts>] | false>
    run(ctx: Ctx, opts: ConvertOpts<Opts>, ...args: Args): Promise<void>
}

export function cmdDef<Args extends any[] = [], Opts extends OptionValues = {}>(
    cmd: Cmd<Args, Opts>
): Cmd<Args, Opts> {
    return cmd;
}
export function cmdMenu(
    cmd: MenuNodeParent
): MenuNodeParent {
    return cmd;
}

class FixPTYStream extends Duplex {
    constructor(
        public ori: ServerChannel
    ) {
        super({
            write(chunk, encoding, callback) {
                const str: string = chunk.toString();
                ori.write(str.replace(/\n/g, '\r\n'));
                callback();
            },
            read(size) {
            },
        });

        (ori as Duplex).on("data", chunk => {
            if (chunk.includes('\u0003')) {
                ori.end("\r\nInterupted by user\r\n");
                return;
            }
            this.push(chunk);
        })
    }

    end(cb?: () => void): this;
    end(chunk: any, cb?: () => void): this;
    end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this;
    end(...args): this {
        if (args.length)
            console.warn("end not implemented", args);
        //Ignore end comming from inquirejs. inquirejs call end after each prompt
        return this;
    }
}

export class ShellManager {

    constructor(
        public gateway: SSHGateway
    ) {

    }

    async shell(user: User, channel: ServerChannel, isPTY: false | PseudoTtyInfo) {
        //if (!isPTY)
        //    throw new Error("not implemented without pty");
        const fix = new FixPTYStream(channel);
        const ctx: Ctx = {
            gateway: this.gateway,
            channel,
            user,
            input: fix,
            output: fix,
            inquirer: fixedInquirer({
                input: fix,
                output: fix
            }),
            pty: isPTY,
            mode: "shell"
        };

        const menu = await menuToTree(ctx);

        let exitCode = 0;
        try {
            while (true) {
                const action = await ctx.inquirer.tree({
                    tree: menu,
                    pageSize: 5
                });
                if (!action)
                    break;
                await action();
            }
        } catch {
            exitCode = -1;
        }
        channel.exit(exitCode);
        channel.close();
    }

    async exec(user: User, channel: ServerChannel, command: string, isPTY: false | PseudoTtyInfo) {
        const prog = new Command();
        const fix = new FixPTYStream(channel);
        const ctx: Ctx = {
            gateway: this.gateway,
            channel,
            user,
            input: fix,
            output: fix,
            inquirer: fixedInquirer({
                input: fix,
                output: fix
            }),
            pty: isPTY,
            mode: "exec"
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

        await menuToTree(ctx, prog);

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

type TNT = (() => (void | Promise<void>) | null);
async function menuToTree(ctx: Ctx, prog?: Command): Promise<TreeNodeParent<TNT>> {

    async function leaf(menuNode: Cmd<any, any>, parent: TreeNodeParent<TNT>) {
        const cmd = menuNode.cmd();
        if (prog) {
            cmd.copyInheritedSettings(prog);
            prog.addCommand(cmd);
            /*const cmd = prog.command(menuNode.cmd.name).summary(menuNode.cmd.summary);
            for (const arg of (menuNode.cmd.args || [])) {
                cmd.argument(arg);
            }
            for (const [n, v] of Object.entries(menuNode.cmd.opts || {})) {
                cmd.option(n, v.desc, v.default);
            }*/
            cmd.action(async (...args) => {
                try {
                    if (!menuNode.perm(ctx))
                        return;
                    await menuNode.run(ctx, args.at(-2), ...(args.slice(0, -2) as []));
                } catch (e) {
                    ctx.channel.stderr.write(e.toString() + "\r\n");
                }
            });
        }
        if (!menuNode.perm(ctx))
            return;
        parent.childs.push({
            text: cmd.summary(),
            value: async () => {
                try {
                    const args = await menuNode.pty(ctx);
                    if (args)
                        await menuNode.run(ctx, args[1], ...args[0]);
                } catch (e) {
                    ctx.channel.stderr.write(e.toString() + "\r\n");
                }
            }
        });
    }

    async function node(text: string, children: MenuNode[]) {
        const tree: TreeNodeParent<TNT> = {
            text: text,
            childs: []
        };
        for (const child of children) {
            if ("text" in child) {
                const childTree = await node(child.text, child.children);
                if (childTree.childs.length)
                    tree.childs.push(childTree);
            } else
                await leaf(child, tree);
        }
        return tree;
    }

    const root = await node(menu.text, menu.children as MenuNode[]);
    root.childs.unshift({
        text: "Exit",
        value: null
    })
    return root;
}

export type MenuNodeParent = {
    text: string,
    children: MenuNode[]
};
export type MenuNode = MenuNodeParent | Cmd<any, any>;// | (Cmd & { children: MenuNode[] });
