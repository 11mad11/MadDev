import { createConnection } from "net";
import { createInterface } from "readline";
import { CertRecord, DAEMON_ROOT_SOCKET, DAEMON_SOCKET, Request, Response, RevocationRecord, TapRecord } from "./protocol";

function call(req: Request, asRoot = false): Promise<any> {
    const path = asRoot ? DAEMON_ROOT_SOCKET : DAEMON_SOCKET;
    return new Promise((resolve, reject) => {
        const sock = createConnection(path);
        const rl = createInterface({ input: sock });
        let answered = false;
        rl.once("line", (line) => {
            answered = true;
            sock.end();
            try {
                const resp = JSON.parse(line) as Response;
                if (resp.ok === true) resolve((resp as any).data);
                else reject(new Error((resp as any).error ?? "unknown error"));
            } catch (e) {
                reject(e);
            }
        });
        sock.on("connect", () => {
            sock.write(JSON.stringify(req) + "\n");
        });
        sock.on("error", (e) => {
            if (!answered) reject(e);
        });
        sock.on("close", () => {
            if (!answered) reject(new Error("daemon closed connection without response"));
        });
    });
}

export const daemon = {
    createGroupNetns(group: string, subnet: string) {
        return call({ op: "create-group-netns", group, subnet }, true);
    },
    deleteGroupNetns(group: string) {
        return call({ op: "delete-group-netns", group }, true);
    },
    allocateTap(group: string): Promise<TapRecord> {
        return call({ op: "allocate-tap", group });
    },
    releaseTap(group: string): Promise<{}> {
        return call({ op: "release-tap", group });
    },
    listTaps(): Promise<TapRecord[]> {
        return call({ op: "list-taps" });
    },
    createOtp(username: string): Promise<{ otp: string; expiresAt: number }> {
        return call({ op: "create-otp", username }, true);
    },
    enrollSelf(pubkey: string): Promise<{ username: string; cert: string; serial: number }> {
        return call({ op: "enroll-self", pubkey });
    },
    caSign(pubkey: string, username: string): Promise<{ cert: string }> {
        return call({ op: "ca-sign", pubkey, username }, true);
    },
    caPubkey(): Promise<{ pubkey: string }> {
        return call({ op: "ca-pubkey" });
    },
    refreshCert(pubkey: string): Promise<{ username: string; cert: string; serial: number }> {
        return call({ op: "refresh-cert", pubkey });
    },
    caKrl(): Promise<{ krl: string }> {
        return call({ op: "ca-krl" });
    },
    listCerts(username?: string): Promise<CertRecord[]> {
        return call({ op: "list-certs", username });
    },
    listRevoked(): Promise<RevocationRecord[]> {
        return call({ op: "list-revoked" });
    },
    revokeCert(args: { serial?: number; username?: string; reason?: string }): Promise<{ revoked: RevocationRecord[] }> {
        return call({ op: "revoke-cert", ...args }, true);
    },
    unrevokeCert(serial: number): Promise<{ serial: number }> {
        return call({ op: "unrevoke-cert", serial }, true);
    },
};
