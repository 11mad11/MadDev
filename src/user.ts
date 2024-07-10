import * as v from 'valibot';
import { SSHGateway } from "./gateway";
import { Permissions } from "./permission";

type Perm = {
    role?: string,
    permissions: Partial<MappedPerm>
};

type MappedPerm = {
    [key in keyof Permissions]: MapType<Parameters<Permissions[key]>, ReturnType<Permissions[key]>>
}

type MapType<P extends any[], R> = P extends [infer K, ...infer L] ? Record<string, MapType<L, R>> : R

export class Users {

    users: Record<string, Perm> = {};
    roles = new Map<string | undefined, Partial<Permissions>>();

    constructor(
        public gateway: SSHGateway
    ) {
        this.reload()
    }

    resolvePermission(username: string): Partial<Permissions> | undefined {
        const user = this.users[username];
        if (!user)
            return Permissions.default;

        const role = this.roles.get(user.role);

        function check<K extends keyof Permissions>(n: K, vals: Parameters<Permissions[K]>) {
            let cur: any = user?.permissions[n];
            let stack = [...vals].reverse();
            while (cur && stack.length) {
                const k = String(stack.pop());
                if (k in cur)
                    cur = cur[k];
                else if ("*" in cur)
                    cur = cur["*"]
                else
                    cur = undefined
            }
            if (cur !== undefined)
                return cur;

            if (role && n in role)
                return role[n]?.call(undefined, ...vals);

            return Permissions.default[n].call(undefined, ...vals);
        }

        return Object.fromEntries(Object.keys(Permissions.default).map(k => {
            return [k, (...args) => check(k as any, args)]
        }));
    }

    setUser(username: string, perm: Perm) {
        this.users[username] = perm;
        this.save();
    }

    removeUser(username: string) {
        delete this.users[username];
        this.save();
    }

    setRole(role: string, perm: Partial<Permissions>) {
        this.roles.set(role, perm);
    }

    removeRole(role: string) {
        this.roles.delete(role);
    }

    save() {
        this.gateway.setting.setJSON("users.json", { users: this.users });
    }

    reload() {

        const users = this.gateway.setting.getJSON("users.json", v.object({
            users: v.record(v.string(), v.strictObject({
                permissions: v.partial(v.strictObject(Permissions.schema)),
                role: v.optional(v.string())
            }))
        }), () => {
            return { users: {} };
        });
        this.users = users.users;
    }

}