import { spawn } from "child_process";
import { ServiceListing } from "./discover";
import { GatewayEntry } from "../utils/sshConfig";

export interface RemoteServiceListing extends ServiceListing {
    gateway: string;
}

export interface RemoteGatewayError {
    gateway: string;
    error: string;
}

export interface CrossGatewayResult {
    services: RemoteServiceListing[];
    errors: RemoteGatewayError[];
}

const PER_GATEWAY_TIMEOUT_MS = 5000;

/**
 * Fan-out `ssh <alias> service ls --json` across every gateway. Each
 * call gets its own ssh process with a hard timeout; failures end up in
 * `errors` rather than throwing. All gateways run in parallel.
 */
export async function listServicesAcross(
    gateways: GatewayEntry[],
    groupFilter?: string,
): Promise<CrossGatewayResult> {
    const settled = await Promise.allSettled(
        gateways.map((g) => fetchOne(g.alias, groupFilter)),
    );

    const services: RemoteServiceListing[] = [];
    const errors: RemoteGatewayError[] = [];
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        const alias = gateways[i].alias;
        if (r.status === "fulfilled") {
            for (const s of r.value) services.push({ ...s, gateway: alias });
        } else {
            errors.push({ gateway: alias, error: (r.reason as Error)?.message ?? String(r.reason) });
        }
    }
    return { services, errors };
}

function fetchOne(alias: string, groupFilter?: string): Promise<ServiceListing[]> {
    const args = ["-o", "BatchMode=yes", alias, "service", "ls", "--json"];
    if (groupFilter) args.push(groupFilter);
    return new Promise((resolve, reject) => {
        const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c) => { stdout += c.toString(); });
        proc.stderr.on("data", (c) => { stderr += c.toString(); });
        const t = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error("timeout"));
        }, PER_GATEWAY_TIMEOUT_MS);
        proc.on("close", (code) => {
            clearTimeout(t);
            if (code !== 0) {
                reject(new Error((stderr.trim() || `exit ${code}`).split("\n")[0]));
                return;
            }
            try {
                const arr = JSON.parse(stdout) as ServiceListing[];
                resolve(arr);
            } catch (e: any) {
                reject(new Error(`bad json from ${alias}: ${e?.message}`));
            }
        });
        proc.on("error", (e) => { clearTimeout(t); reject(e); });
    });
}
