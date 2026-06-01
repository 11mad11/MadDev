import { Command, OptionValues } from "@commander-js/extra-typings";
import { FixedInquirer, TreeNodeParent } from "./utils/inquirer";

export interface Ctx {
    username: string;
    uid: number;
    groups: string[];
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    inquirer: FixedInquirer;
    mode: "shell" | "exec";
}

type ConvertOpts<T extends OptionValues = {}> = {
    [K in keyof T]: T[K] extends true ? boolean : T[K];
};

export interface Cmd<Args extends any[] = [], Opts extends OptionValues = {}> {
    perm(ctx: Ctx): boolean | Promise<boolean>;
    cmd(): Command<Args, Opts>;
    pty(ctx: Ctx): Promise<[Args, ConvertOpts<Opts>] | false>;
    run(ctx: Ctx, opts: ConvertOpts<Opts>, ...args: Args): Promise<void>;
}

export function cmdDef<T extends Cmd<any, any>>(cmd: T): T {
    return cmd;
}

export function cmdMenu(cmd: MenuNodeParent): MenuNodeParent {
    return cmd;
}

/**
 * A menu node that groups Cmds. If `cliName` is set, this group also
 * becomes a Commander subcommand: e.g. `cliName: "service"` makes the
 * menu's children reachable as `mad service <child>` from the CLI.
 * If `cliName` is omitted (e.g. the top-level "Menu" or "Admin"
 * groupings), the parent is a menu-only construct and children get
 * added to whatever Commander parent we already had.
 */
export type MenuNodeParent = { text: string; children: MenuNode[]; cliName?: string };
export type MenuNode = MenuNodeParent | Cmd<any, any>;

type TNT = (() => (void | Promise<void>) | null);

export async function runMenu(ctx: Ctx, menu: MenuNodeParent): Promise<number> {
    const tree = await menuToTree(ctx, menu);
    let exitCode = 0;
    try {
        while (true) {
            const action = await ctx.inquirer.tree({
                tree,
                pageSize: 5
            });
            if (!action)
                break;
            await action();
        }
    } catch {
        exitCode = -1;
    }
    return exitCode;
}

export async function runExec(ctx: Ctx, menu: MenuNodeParent, args: string[]): Promise<number> {
    const prog = new Command();
    prog.exitOverride((err) => { throw err });
    prog.configureOutput({
        writeErr(str) { ctx.output.write(str) },
        writeOut(str) { ctx.output.write(str) },
    });

    await menuToTree(ctx, menu, prog);

    try {
        await prog.parseAsync(args, { from: 'user' });
        return 0;
    } catch (err: any) {
        ctx.output.write((err?.toString?.() ?? "error") + "\n");
        return err?.exitCode ?? 1;
    }
}

export async function menuToTree(ctx: Ctx, menu: MenuNodeParent, prog?: Command): Promise<TreeNodeParent<TNT>> {

    async function leaf(menuNode: Cmd<any, any>, parent: TreeNodeParent<TNT>, commanderParent: Command | undefined) {
        const cmd = menuNode.cmd();
        // If the same name is already registered on `commanderParent`
        // (e.g. cli.ts defined `mad help` directly, or two menu nodes
        // happen to share a topic name), leave the existing one alone
        // and just keep the interactive-menu entry. This avoids
        // throwing when menu trees overlap CLI-side names — happens
        // for help-topic Cmds named "ca"/"groups"/etc. that collide
        // with top-level command areas.
        const alreadyRegistered = !!commanderParent?.commands.find(c => c.name() === cmd.name());
        if (commanderParent && !alreadyRegistered) {
            cmd.copyInheritedSettings(commanderParent);
            commanderParent.addCommand(cmd);
            cmd.action(async (...args) => {
                try {
                    if (!await menuNode.perm(ctx)) {
                        ctx.output.write(`mad ${cmd.name()}: permission denied\n`);
                        process.exitCode = 1;
                        return;
                    }
                    await menuNode.run(ctx, args.at(-2), ...(args.slice(0, -2) as []));
                } catch (e: any) {
                    ctx.output.write((e?.toString?.() ?? "error") + "\n");
                }
            });
        }
        if (!await menuNode.perm(ctx))
            return;
        parent.childs.push({
            text: cmd.summary() ?? cmd.name(),
            value: async () => {
                try {
                    const args = await menuNode.pty(ctx);
                    if (args)
                        await menuNode.run(ctx, args[1], ...args[0]);
                } catch (e: any) {
                    ctx.output.write((e?.toString?.() ?? "error") + "\n");
                }
            }
        });
    }

    async function node(nodeMenu: MenuNodeParent, commanderParent: Command | undefined) {
        const tree: TreeNodeParent<TNT> = {
            text: nodeMenu.text,
            childs: []
        };

        // If this menu group has a cliName, it owns a Commander
        // subcommand that nests its children. The interactive menu
        // doesn't care about cliName; it nests by text.
        // If a same-named subcommand already exists (cli.ts defined
        // it directly), reuse that one instead of throwing.
        let childCommander: Command | undefined = commanderParent;
        if (commanderParent && nodeMenu.cliName) {
            const existing = commanderParent.commands.find(c => c.name() === nodeMenu.cliName);
            childCommander = existing ?? commanderParent.command(nodeMenu.cliName).description(nodeMenu.text);
        }

        for (const child of nodeMenu.children) {
            if ("text" in child) {
                const childTree = await node(child, childCommander);
                if (childTree.childs.length)
                    tree.childs.push(childTree);
            } else {
                await leaf(child, tree, childCommander);
            }
        }
        return tree;
    }

    const root = await node(menu, prog);
    root.childs.unshift({
        text: "Exit",
        value: null as any
    });
    return root;
}
