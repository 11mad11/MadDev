import { createCommand } from "@commander-js/extra-typings";
import { existsSync, readdirSync, unlinkSync } from "fs";
import { spawnSync } from "child_process";
import { cmdDef } from "../../menu";

export default cmdDef({
    perm() { return true; },
    cmd: () => createCommand("hold")
        .summary("Hold an ssh -R session; on boot, sweep any orphan sockets in the same group dir")
        .argument("<groupname>", "group/name (the path = /run/mad/groups/<group>/<name>.sock)"),
    async pty() { return false; },
    async run(_ctx, _opts, groupname) {
        const [g, n] = groupname.split("/");
        if (!g || !n) throw new Error("expected <group>/<name>");
        const dir = `/run/mad/groups/${g}`;
        const path = `${dir}/${n}.sock`;
        // sshd reaps the entire session cgroup on disconnect — even
        // detached/setsid children get killed — so we can't reliably
        // clean up THIS socket at our own death. Instead, cleanup
        // happens at the *next* hold: sweep dead siblings in the same
        // group dir on startup.
        try {
            const ssOut = (spawnSync("ss", ["-xlH"], { encoding: "utf-8" }).stdout ?? "");
            let swept = 0;
            if (existsSync(dir)) {
                for (const entry of readdirSync(dir)) {
                    if (!entry.endsWith(".sock")) continue;
                    const p = `${dir}/${entry}`;
                    if (p === path) continue;
                    if (!ssOut.includes(p)) {
                        try { unlinkSync(p); swept++; } catch {}
                    }
                }
            }
            if (swept > 0) process.stderr.write(`mad service hold: swept ${swept} orphan socket(s) in ${dir}\n`);
        } catch {}
        setInterval(() => { }, 60_000);
    },
});
