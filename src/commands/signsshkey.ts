import { StringDecoder } from "string_decoder";
import { Cmd } from "../shell";
import { createCommand } from "@commander-js/extra-typings";

export default {
    cmd: () => createCommand("signsshkey").summary("Sign a SSH key"),
    perm(ctx) {
        return ctx.mode === "exec"
    },
    async pty(ctx){
        return [[],{}]
    },
    async run(ctx, opts) {
        if(ctx.pty){
            ctx.output.write("Cannot be used in pty mode\n");
            return;
        }
        const decoder = new StringDecoder("utf-8");
        const inputs: string[] = [];

        ctx.input.on("data", (data) => {
            inputs.push(decoder.write(data));
        });

        return new Promise((resolve, reject) => {
            ctx.input.on("end", () => {
                try {
                    const keyPem = inputs.join("");
                    const keySigned = ctx.gateway.ca.signSSHKey(keyPem, ctx.user);
                    ctx.output.write(keySigned);
                    ctx.channel.eof();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        })
    },
} satisfies Cmd;