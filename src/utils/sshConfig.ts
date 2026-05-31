import { hostname } from "os";

/**
 * Best-effort lookup of the gateway hostname so generated ssh_config
 * snippets point at something the user can actually connect to.
 *
 * Order of preference:
 * 1. Explicit override
 * 2. $SSH_CONNECTION's server-side IP (the address the user just dialed)
 * 3. Local hostname (works on the gateway box itself)
 */
export function gatewayHost(override?: string): string {
    if (override) return override;
    const conn = process.env.SSH_CONNECTION;
    if (conn) {
        const parts = conn.split(" ");
        if (parts.length >= 3 && parts[2]) return parts[2];
    }
    return hostname();
}

export function sshConfigBlock(alias: string, host: string, user: string): string {
    return `Host ${alias}
    HostName ${host}
    User ${user}
    IdentityFile ~/.ssh/id_ed25519
    # CertificateFile ~/.ssh/id_ed25519-cert.pub   # uncomment after \`mad cert refresh\`
    ServerAliveInterval 30
    ExitOnForwardFailure yes
`;
}
