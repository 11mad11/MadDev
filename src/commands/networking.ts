import { createCommand } from "@commander-js/extra-typings";
import { cmdDef, cmdMenu } from "../menu";
import { daemon } from "../daemon/client";

export const tapJoin = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("tap-join").summary("Join a group's L2 network").argument("<group>"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        return [[group] as const, {}];
    },
    async run(ctx, _opts, group) {
        const tap = await daemon.allocateTap(group);
        ctx.output.write(`joined ${group}: ${tap.ifname} ${tap.ip}\n`);
    },
});

export const tapLeave = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("tap-leave").summary("Leave a group's L2 network").argument("<group>"),
    async pty(ctx) {
        const group = await ctx.inquirer.input({ message: "Group name" });
        return [[group] as const, {}];
    },
    async run(ctx, _opts, group) {
        await daemon.releaseTap(group);
        ctx.output.write(`left ${group}\n`);
    },
});

export const tapList = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("tap-ls").summary("List my TAPs"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) {
        const taps = await daemon.listTaps();
        if (!taps.length) { ctx.output.write("(none)\n"); return; }
        for (const t of taps) ctx.output.write(`${t.group}\t${t.ifname}\t${t.ip}\n`);
    },
});

export default cmdMenu({
    text: "Networking",
    children: [tapJoin, tapLeave, tapList],
});
