import { Connection, ClientInfo, AuthContext, PublicKey } from "ssh2";
import { AuthProvider } from "../gateway";

export class PublicKeyAuthProvider implements AuthProvider {
    method = "publickey" as const;
    acceptNextMap = new WeakMap<Connection, [ClientInfo, string]>();
    acceptNextAlreadyMap = new WeakMap<Connection, [ClientInfo, string, PublicKey]>();
    known = new Map<string, PublicKey>();

    auth(client: Connection, info: ClientInfo, ctx: AuthContext): void | Promise<void> {
        if (ctx.method !== "publickey")
            throw new Error("Method not publickey")

        if (this.acceptNextMap.has(client)) {
            const [aInfo, aUsername] = this.acceptNextMap.get(client)!;
            if (aInfo === info && aUsername === ctx.username) {
                this.known.set(aUsername, ctx.key);
            }
        }

        if (this.known.has(ctx.username)) {
            const key = this.known.get(ctx.username)!;
            if (key.algo === ctx.key.algo && ctx.key.data.equals(key.data))
                return;
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
                this.known.set(aUsername, aKey);
                return false;
            }
        }
        this.acceptNextMap.set(client, [info, username]);
        return true;
    }
}