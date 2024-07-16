import { Connection, ClientInfo, AuthContext, PublicKey } from "ssh2";
import { AuthProvider, SSHGateway } from "../gateway";
import { Certificate, parseFingerprint } from "sshpk";

export class PublicKeyAuthProvider implements AuthProvider {
    method = "publickey" as const;
    acceptNextMap = new WeakMap<Connection, [ClientInfo, string]>();
    acceptNextAlreadyMap = new WeakMap<Connection, [ClientInfo, string, PublicKey]>();
    known = new Map<string, PublicKey>();

    constructor(
        public gateway: SSHGateway
    ) {

    }

    auth(client: Connection, info: ClientInfo, ctx: AuthContext): void | Promise<void> {
        if (ctx.method !== "publickey")
            throw new Error("Method not publickey")

        const cert = this.gateway.ca.parse(ctx.key.data);

        if (cert instanceof Certificate && this.gateway.ca.validate(cert) && cert.subjects[0] && cert.subjects[0].uid === ctx.username)
            return;

        if (this.acceptNextMap.has(client)) {
            const [aInfo, aUsername] = this.acceptNextMap.get(client)!;
            if (aInfo === info && aUsername === ctx.username) {
                const keys = this.gateway.users.getOrCreateUser(aUsername).publicKeys ??= [];
                keys.push(this.gateway.ca.getKey(cert).fingerprint().toString());
                this.gateway.users.usersConfig.save();
                return;
            }
        }

        const user = this.gateway.users.users[ctx.username];

        if (user && user.publicKeys?.length) {
            const key = this.gateway.ca.getKey(cert);
            for (const pk of user.publicKeys) {
                if (parseFingerprint(pk).matches(key))
                    return
            }
        }

        this.acceptNextAlreadyMap.set(client, [info, ctx.username, ctx.key]);

        throw new Error("Bad or unknown publickey.");
    }

    /**
     * 
     * @param client 
     * @param info 
     * @param username 
     * @returns false if already accepted
     */
    acceptNext(client: Connection, info: ClientInfo, username: string): boolean {
        if (this.acceptNextAlreadyMap.has(client)) {
            const [aInfo, aUsername, aKey] = this.acceptNextAlreadyMap.get(client)!;
            if (aInfo === info && aUsername === username) {
                const keys = this.gateway.users.getOrCreateUser(aUsername).publicKeys ??= [];
                keys.push(this.gateway.ca.getKey(aKey.data).fingerprint().toString());
                this.gateway.users.usersConfig.save();
                return false;
            }
        }
        this.acceptNextMap.set(client, [info, username]);
        return true;
    }
}