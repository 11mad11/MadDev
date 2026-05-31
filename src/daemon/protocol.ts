export const DAEMON_SOCKET = "/run/mad/daemon.sock";
export const DAEMON_ROOT_SOCKET = "/run/mad/daemon-root.sock";

export interface PeerCred {
    pid: number;
    uid: number;
    gid: number;
}

export type Request =
    | { op: "create-group-netns"; group: string; subnet: string }
    | { op: "delete-group-netns"; group: string }
    | { op: "tun-allocate-ip"; group: string; ifname: string }
    | { op: "tun-release"; ifname: string }
    | { op: "list-tuns" }
    | { op: "create-otp"; username: string }
    | { op: "enroll-self"; pubkey: string }
    | { op: "ca-sign"; pubkey: string; username: string }
    | { op: "ca-pubkey" }
    | { op: "ca-krl" }
    | { op: "refresh-cert"; pubkey: string }
    | { op: "list-certs"; username?: string }
    | { op: "list-revoked" }
    | { op: "revoke-cert"; serial?: number; username?: string; reason?: string }
    | { op: "unrevoke-cert"; serial: number };

export type Response =
    | { ok: true; data?: any }
    | { ok: false; error: string };

export interface TunRecord {
    group: string;
    uid: number;
    username: string;
    ifname: string;       // The kernel ifname the gateway end attached to (tun0, tun1, …)
    ip: string;           // CIDR assigned to the gateway end (e.g. "10.42.0.42/24")
    peerIp: string;       // The client end's address (gateway uses this for the point-to-point)
    sshPid: number;       // pid of the ssh session that owns the tun device; used for liveness sweeps
    createdAt: number;
}

export interface OtpRecord {
    otp: string;
    username: string;
    expiresAt: number;
}

export interface GroupNetns {
    group: string;
    subnet: string;
    nextHost: number;
}

export interface CertRecord {
    serial: number;
    username: string;
    keyId: string;
    fingerprint: string;
    principals: string[];
    issuedAt: number;
    expiresAt: number;
}

export interface RevocationRecord {
    serial: number;
    username: string;
    revokedAt: number;
    reason?: string;
}

export interface DaemonState {
    tuns: TunRecord[];
    otps: OtpRecord[];
    netns: GroupNetns[];
    nextSerial: number;
    certs: CertRecord[];
    revoked: RevocationRecord[];
}
