import { ServerChannel } from "ssh2";
import { CommandRegister } from "../command";
import * as inquirerO from '@inquirer/prompts';

export function cmd(cmd: CommandRegister) {
    return cmd;
}

export function getInquirerContext(channel: ServerChannel) {
    return {
        input: createProxy(channel, "in"),
        output: createProxy(channel, "out")
    }
}

type InquirerCtx = Parameters<typeof inquirerO.input>[1];

const selectFixed = fix(inquirerO.select);
type SelectConfig = Omit<Parameters<typeof inquirerO.select>[0],"choices"> & { choices: (Parameters<typeof inquirerO.select>[0]["choices"][number] & { action?: () => Promise<void> })[] }
export const inquirer = {
    input: fix(inquirerO.input),
    select: async (config: SelectConfig, ctx?: InquirerCtx) => {
        const rep = await selectFixed(config, ctx);
        for (const c of config.choices) {
            if ("value" in c && c.value == rep) {
                await c?.action();
                break;
            }
        }
        return rep;
    },
    checkbox: fix(inquirerO.checkbox),
    confirm: fix(inquirerO.confirm),
    editor: fix(inquirerO.editor),
    expand: fix(inquirerO.expand),
    number: fix(inquirerO.number),
    password: fix(inquirerO.password),
    rawlist: fix(inquirerO.rawlist),
}

function fix<A extends [any, Parameters<typeof inquirerO.input>[1]], F extends (...args: A) => ReturnType<import("@inquirer/type").Prompt<any, any>>>(fn: F): F {
    return ((...args: A) => {
        const prompt = fn(...args);
        args[1]?.input?.on("close", () => {
            prompt.cancel();//Without this, the server process can't exit if a user close stream mid-prompt
        })
        return prompt;
    }) as F
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
            //console.log(`Property accessed: ${String(property)} on ${name}`);
            return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
            //console.log(`Property set: ${String(property)} = ${value}`);
            return Reflect.set(target, property, value, receiver);
        }
    });
}