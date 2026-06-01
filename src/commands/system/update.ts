import { createCommand } from "@commander-js/extra-typings";
import { cmdDef } from "../../menu";
import { requireLinuxRoot } from "../../utils/platform";
import { runUpdate } from "../update";

export default cmdDef({
    perm() { return process.getuid?.() === 0; },
    cmd: () => createCommand("update")
        .summary("git pull + bun install + setup + restart daemon (root)"),
    async pty() { return [[] as const, {}]; },
    async run() {
        requireLinuxRoot("mad system update");
        await runUpdate();
    },
});
