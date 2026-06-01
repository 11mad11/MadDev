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
    | { op: "tap-allocate"; group: string; mode: "l2" | "l3" }
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
    | { op: "unrevoke-cert"; serial: number }
    | { op: "usage-record"; events: UsageEvent[] }
    | { op: "usage-query"; filter?: UsageFilter };

export type Response =
    | { ok: true; data?: any }
    | { ok: false; error: string };

export interface TunRecord {
    group: string;
    uid: number;
    username: string;
    ifname: string;        // The kernel ifname the gateway end is bridged into (tap-stress-2, tun-…)
    mode: "l2" | "l3";
    ip: string;            // CIDR assigned to the gateway end ("(bridged)" in L2)
    peerIp: string;        // CIDR the client end will assign locally (e.g. "10.42.0.43/24")
    socketPath: string;    // /run/mad/groups/<group>/<ifname>.sock — frames flow here
    socatPid: number;      // pid of the socat that bridges <socketPath> ↔ <ifname>
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

export type UsageKind = "tap" | "tun" | "svc-publish" | "svc-consume";

export interface UsageEvent {
    kind: UsageKind;
    uid: number;
    username: string;
    group: string;
    ifname?: string;
    mode?: "l2" | "l3";
    service?: string;
    windowStart: number;
    windowEnd: number;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
}

export interface UsageFilter {
    since?: number;
    until?: number;
    uid?: number;
    group?: string;
    kind?: UsageKind;
}

export interface UsageAggregate {
    kind: UsageKind;
    uid: number;
    username: string;
    group: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    firstSeen: number;
    lastSeen: number;
}
