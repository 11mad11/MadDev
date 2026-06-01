import { createCommand } from "@commander-js/extra-typings";
import { spawnSync } from "child_process";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("ping")
        .summary("Check the registered socket is bound; hold while it is. Use with ssh -L instead of -N.")
        .argument("<groupname>", "group/name")
        .option("--interval <s>", "Re-check interval in seconds", "5"),
    async pty() { return false; },
    async run(_ctx, opts, groupname) {
        const [g, n] = groupname.split("/");
        if (!g || !n) throw new Error("expected <group>/<name>");
        const path = `/run/mad/groups/${g}/${n}.sock`;
        const isLive = () => {
            const r = spawnSync("ss", ["-xlH"], { encoding: "utf-8" });
            return (r.stdout ?? "").split("\n").some(l => l.includes(path));
        };
        if (!isLive()) {
            process.stderr.write(`mad service ping: ${path} is not bound by any process\n`);
            process.exit(1);
        }
        const intervalMs = Math.max(1, parseInt((opts as any).interval as string, 10)) * 1000;
        const originalPpid = process.ppid;
        const t = setInterval(() => {
            if (process.ppid !== originalPpid) { clearInterval(t); process.exit(0); }
            if (!isLive()) {
                process.stderr.write(`mad service ping: ${path} disappeared, exiting\n`);
                clearInterval(t);
                process.exit(1);
            }
        }, intervalMs);
    },
});
