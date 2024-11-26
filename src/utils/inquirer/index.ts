import { ServerChannel } from "ssh2";
import * as inquirerO from '@inquirer/prompts';
import { Context } from "@inquirer/type";
import { createPrompt, isBackspaceKey, isDownKey, isEnterKey, isUpKey, useKeypress, usePagination, usePrefix, useState } from "@inquirer/core";


export function getInquirerContext(channel: ServerChannel): Context {
    return {
        input: createProxy(channel, "in"),
        output: createProxy(channel, "out")
    }
}

export type TreeNodeAction<V> = { text: string, value: V }
export type TreeNodeParent<V> = { text: string, childs: TreeNode<V>[] }
export type TreeNode<V> = TreeNodeAction<V> | TreeNodeParent<V>;

const Tree: <V>(config: {
    tree: TreeNodeParent<V>,
    pageSize: number
}, context?: import("@inquirer/type").Context) => import("@inquirer/type").CancelablePromise<V> = createPrompt((config, done) => {
    /**
     * Stack must always have:
     * length>0
     */
    const [stack, setStack] = useState([0] as number[]);
    const [state, setState] = useState("idle" as "idle" | "done");

    const parent: TreeNodeParent<any> = stack.slice(0, -1).reduce((o, c) => {
        const child = o.childs[c];
        if ("childs" in child)
            return child;
        throw new Error();
    }, config.tree);

    const current = parent.childs[stack.at(-1)];

    useKeypress((e, rl) => {
        if (isUpKey(e)) {
            let val = stack.at(-1) - 1;
            if (val < 0)
                val = parent.childs.length - 1;
            setStack([...stack.slice(0, -1), val]);
        } else if (isDownKey(e)) {
            let val = stack.at(-1) + 1;
            if (val >= parent.childs.length)
                val = 0;
            setStack([...stack.slice(0, -1), val]);
        } else if (isEnterKey(e)) {
            if ("value" in current) {
                setState("done");
                done(current.value);
            } else {
                setStack([...stack, 0]);
            }
        } else if (isBackspaceKey(e)) {
            if (stack.length > 1)
                setStack([...stack.slice(0, -1)]);
        }
    });

    //rendering
    const prefix = usePrefix({ isLoading: false });
    const path = stack.slice(0, -1).reduce((o, c) => {
        const child = o[0].childs[c];
        if ("childs" in child)
            return [child, o[1] + "/" + child.text] as const;
        throw new Error();
    }, [config.tree, config.tree.text] as const);

    if (state === "done")
        return `${prefix} ${path[1]}/${current.text}`;

    const page = usePagination({
        items: parent.childs,
        active: stack.at(-1),
        renderItem: ({ item, index, isActive }) => `${isActive ? ">" : " "}${"childs" in item ? "+" : " "} ${item.text}`,
        pageSize: config.pageSize,
        loop: false
    });

    return `${prefix} ${path[1]}\n${page}\n\u001B[?25l`;
});

type InquirerCtx = Parameters<typeof inquirerO.input>[1];
export type FixedInquirer = ReturnType<typeof fixedInquirer>;

type SelectConfig<V> = Omit<Parameters<typeof inquirerO.select<V>>[0], "choices"> & { choices: (Parameters<typeof inquirerO.select<V>>[0]["choices"][number] & { action?: () => Promise<void> })[] }
export function fixedInquirer(ctx: InquirerCtx) {
    const selectFixed = fix(inquirerO.select, ctx);
    return {
        ctx,
        input: fix(inquirerO.input, ctx),
        select: async <V>(config: SelectConfig<V>): Promise<V> => {
            const rep = await selectFixed(config);
            for (const c of config.choices) {
                if ("value" in c && c.value == rep) {
                    await c?.action();
                    break;
                }
            }
            return rep as V;
        },
        checkbox: fix(inquirerO.checkbox, ctx),
        confirm: fix(inquirerO.confirm, ctx),
        editor: fix(inquirerO.editor, ctx),
        expand: fix(inquirerO.expand, ctx),
        number: fix(inquirerO.number, ctx),
        password: fix(inquirerO.password, ctx),
        rawlist: fix(inquirerO.rawlist, ctx),
        tree: fix(Tree, ctx)
    }
}

function fix<
    A,
    R extends ReturnType<import("@inquirer/type").Prompt<any, A>>
>(fn: (arg: A, ctx: InquirerCtx) => R, ctx: InquirerCtx): (arg: A) => R {
    return ((arg: A) => {
        const prompt = fn(arg, ctx);
        ctx.input?.on("close", () => {
            prompt.cancel();//Without this, the server process can't exit if a user close stream mid-prompt
        })
        return prompt;
    })
}

/**
 * Inquirer close the stream after each prompt
 * @param obj 
 * @param name 
 * @returns 
 */
function createProxy<T extends object>(obj: T, name: string): T {
    return new Proxy(obj, {
        get(target, property, receiver) {
            if (property === "end")
                return () => { }
            if (property === "eof")
                return () => { }
            if (property === "close")
                return () => { }
            if (property === "write")
                return (...args) => {
                    console.log(args);
                    target[property](...args);
                }
            //console.log(`Property accessed: ${String(property)} on ${name}`);
            return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
            //console.log(`Property set: ${String(property)} = ${value}`);
            return Reflect.set(target, property, value, receiver);
        }
    });
}