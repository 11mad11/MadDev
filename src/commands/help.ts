import { createCommand } from "@commander-js/extra-typings";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import chalk from "chalk";
import { Cmd, MenuNodeParent, cmdDef, cmdMenu } from "../menu";
import { renderMarkdown } from "../utils/markdown";

/**
 * Walk up from this file until we find a package.json, then resolve docs/
 * relative to that. Works both under `bun run /opt/mad/src/cli.ts` and
 * under `tsx`/development.
 */
function docsDir(): string {
    let dir = resolve(import.meta.dir ?? dirname(process.argv[1] ?? "."));
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "docs"))) return join(dir, "docs");
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return "/opt/mad/docs";
}

function topicPath(topic: string): string {
    const safe = topic.replace(/[^a-z0-9-]/gi, "");
    return join(docsDir(), `${safe}.md`);
}

function listTopics(): string[] {
    try {
        return readdirSync(docsDir())
            .filter(f => f.endsWith(".md") && f !== "README.md")
            .map(f => f.replace(/\.md$/, ""))
            .sort();
    } catch { return []; }
}

function renderTopic(topic: string | undefined, output: NodeJS.WritableStream): void {
    const path = topic ? topicPath(topic) : join(docsDir(), "README.md");
    if (!existsSync(path)) {
        output.write(chalk.red(`No help topic '${topic}'.`) + "\n\nAvailable:\n");
        for (const t of listTopics()) output.write("  - " + t + "\n");
        return;
    }
    output.write("\n" + renderMarkdown(readFileSync(path, "utf-8")) + "\n");
}

// Top-level menu entry — Overview / index page.
const helpIndex: Cmd = cmdDef({
    perm() { return true; },
    cmd: () => createCommand("overview").summary("Overview (index)"),
    async pty() { return [[] as const, {}]; },
    async run(ctx) { renderTopic(undefined, ctx.output); },
});

// Friendly menu titles per topic file (falls back to the bare filename).
const TOPIC_TITLES: Record<string, string> = {
    install: "Installing the gateway",
    enrollment: "Enrolling a user",
    groups: "Managing groups and users",
    forwarding: "TCP service forwarding",
    "field-devices": "Sharing field devices",
    vpn: "L2 VPN per group",
    ca: "The mad CA",
    revocation: "Revocation",
    "cli-reference": "CLI reference",
};

function topicCmd(topic: string): Cmd {
    return cmdDef({
        perm() { return true; },
        cmd: () => createCommand(topic).summary(TOPIC_TITLES[topic] ?? topic),
        async pty() { return [[] as const, {}]; },
        async run(ctx) { renderTopic(topic, ctx.output); },
    });
}

const helpMenu: MenuNodeParent = cmdMenu({
    text: "Help",
    // cliName: "help" — topics nest under `mad help` instead of bleeding
    // out to the root as `mad overview`, `mad install`, etc. The plain
    // `mad help` invocation (no subcommand) still falls through to
    // runHelpCli(undefined) registered in cli.ts, which prints the index.
    cliName: "help",
    children: [helpIndex, ...Object.keys(TOPIC_TITLES).map(topicCmd)],
});

export default helpMenu;

/**
 * Exported for cli.ts so `mad help [topic]` works programmatically (the
 * menu's runExec doesn't currently surface sub-menu children as
 * sub-subcommands, so this is a flat wrapper for CLI use).
 */
export function runHelpCli(topic: string | undefined): void {
    renderTopic(topic, process.stdout);
}

export function helpTopics(): string[] { return listTopics(); }
