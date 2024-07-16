import { ServerChannel } from "ssh2";
import { CommandRegister } from "../command";
import { input } from '@inquirer/prompts';

export function cmd(cmd: CommandRegister) {
    return cmd;
}

export function getInquirerContext(channel: ServerChannel) {
    return {
        input: createProxy(channel, "in"),
        output: createProxy(channel, "out")
    }
}

export const inquirer = {
    input(...args: Parameters<typeof input>): ReturnType<typeof input> {
        const prompt = input(...args);
        args[1]?.input?.on("close", () => {
            prompt.cancel();
        })
        return prompt;
    }
}


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