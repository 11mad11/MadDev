import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { runSetup } from "./setup";

function detectInstallDir(): string {
    let dir = resolve(process.argv[1] ?? ".");
    for (let i = 0; i < 6; i++) {
        dir = dirname(dir);
        if (existsSync(join(dir, "package.json"))) return dir;
    }
    throw new Error("could not locate install dir");
}

function gitHead(dir: string): string {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
}

export async function runUpdate(): Promise<void> {
    if (process.getuid?.() !== 0)
        throw new Error("mad update must run as root");

    const installDir = detectInstallDir();
    if (!existsSync(join(installDir, ".git")))
        throw new Error(`install dir ${installDir} is not a git checkout — update via git only is supported`);

    const before = gitHead(installDir);
    process.stdout.write(`install dir: ${installDir}\nbefore: ${before}\n\n`);

    process.stdout.write("git pull --ff-only...\n");
    execFileSync("git", ["-C", installDir, "pull", "--ff-only"], { stdio: "inherit" });

    const after = gitHead(installDir);
    if (after === before) {
        process.stdout.write("\nalready at latest commit.\n");
    } else {
        process.stdout.write(`\nadvanced ${before} -> ${after}\n`);
        process.stdout.write("\nbun install...\n");
        execFileSync("bun", ["install", "--cwd", installDir, "--silent"], { stdio: "inherit" });
    }

    process.stdout.write("\nrunning setup (idempotent)...\n");
    await runSetup();

    process.stdout.write("\nrestarting mad-daemon...\n");
    spawnSync("systemctl", ["restart", "mad-daemon"], { stdio: "inherit" });

    process.stdout.write("\nupdate complete.\n");
}
