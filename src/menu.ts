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

export type MenuNodeParent = { text: string, children: MenuNode[] };
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

async function menuToTree(ctx: Ctx, menu: MenuNodeParent, prog?: Command): Promise<TreeNodeParent<TNT>> {

    async function leaf(menuNode: Cmd<any, any>, parent: TreeNodeParent<TNT>) {
        const cmd = menuNode.cmd();
        if (prog) {
            cmd.copyInheritedSettings(prog);
            prog.addCommand(cmd);
            cmd.action(async (...args) => {
                try {
                    if (!await menuNode.perm(ctx))
                        return;
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

    async function node(text: string, children: MenuNode[]) {
        const tree: TreeNodeParent<TNT> = {
            text,
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

    const root = await node(menu.text, menu.children);
    root.childs.unshift({
        text: "Exit",
        value: null as any
    });
    return root;
}
