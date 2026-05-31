import { Certificate, Key, PrivateKey, generatePrivateKey, parseKey, parsePrivateKey } from "sshpk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { dirname } from "path";
import { execFileSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export class CA {
    readonly privateKey: PrivateKey;
    readonly keyPath: string;

    constructor(keyPath: string) {
        this.keyPath = keyPath;
        if (!existsSync(keyPath)) {
            mkdirSync(dirname(keyPath), { recursive: true });
            const generated = generatePrivateKey("ed25519").toString("openssh");
            writeFileSync(keyPath, generated);
            chmodSync(keyPath, 0o400);
        }
        this.privateKey = parsePrivateKey(readFileSync(keyPath));
    }

    publicKey(): string {
        return this.privateKey.toPublic().toString("ssh");
    }

    parse(buf: Buffer) {
        let offset = 0;

        const algoLen = buf.readInt32BE(offset); offset += 4;
        const algo = buf.subarray(offset, offset + algoLen).toString("ascii"); offset += algoLen;

        switch (algo) {
            case "ssh-rsa-cert-v01@openssh.com":
                return Certificate.parse(algo + " " + buf.toString("base64"), "openssh");
            default:
                return parseKey(buf);
        }
    }

    getKey(key: Certificate | Key | Buffer): Key {
        if (key instanceof Buffer)
            key = this.parse(key);
        if (key instanceof Certificate)
            return key.subjectKey;
        if (key instanceof Key)
            return key;
        throw new Error("Unsupported key type");
    }

    validate(key: Certificate): boolean {
        return key.isSignedByKey(this.privateKey);
    }

    /**
     * Shells out to ssh-keygen -s. We need ssh-keygen rather than sshpk because
     * OpenSSH user certs need the standard extension set (permit-pty,
     * permit-port-forwarding, etc.) for sshd to allow -R/-L, and sshpk's
     * createCertificate doesn't emit those.
     *
     * `principals` is the SSH-cert principal list. We always include the username
     * as the first principal; additional entries (typically the user's mad group
     * memberships) let field devices accept the cert via AuthorizedPrincipalsFile.
     *
     * `serial` lets the caller pass the cert's serial number — required for KRL
     * revocation by serial. Defaults to 0 (no tracking).
     */
    signSSHKey(pubkey: string, username: string, principals: string[] = [], validity: string = "+52w", serial: number = 0): string {
        parseKey(pubkey);

        const allPrincipals = [username, ...principals.filter(p => p && p !== username)];

        const dir = mkdtempSync(join(tmpdir(), "mad-sign-"));
        const pubPath = join(dir, "key.pub");
        try {
            writeFileSync(pubPath, pubkey.endsWith("\n") ? pubkey : pubkey + "\n");
            const args = [
                "-s", this.keyPath,
                "-I", `user_${username}`,
                "-n", allPrincipals.join(","),
                "-V", validity,
            ];
            if (serial > 0) { args.push("-z", String(serial)); }
            args.push(pubPath);
            execFileSync("ssh-keygen", args, { stdio: ["ignore", "ignore", "pipe"] });
            return readFileSync(join(dir, "key-cert.pub"), "utf-8").trim();
        } finally {
            for (const f of ["key.pub", "key-cert.pub"]) {
                const p = join(dir, f);
                try { unlinkSync(p); } catch {}
            }
            try { require("fs").rmdirSync(dir); } catch {}
        }
    }

    /** SHA256:... fingerprint of a public key (matches `ssh-keygen -l`). */
    fingerprint(pubkey: string): string {
        const dir = mkdtempSync(join(tmpdir(), "mad-fp-"));
        const path = join(dir, "key.pub");
        try {
            writeFileSync(path, pubkey.endsWith("\n") ? pubkey : pubkey + "\n");
            const out = execFileSync("ssh-keygen", ["-lf", path], { encoding: "utf-8" });
            const m = out.match(/\bSHA256:[A-Za-z0-9+/=]+/);
            if (!m) throw new Error("could not parse fingerprint");
            return m[0];
        } finally {
            try { unlinkSync(path); } catch {}
            try { require("fs").rmdirSync(dir); } catch {}
        }
    }

    /**
     * Generate a signed KRL (key revocation list) listing the given serials.
     * OpenSSH sshd consumes this via the `RevokedKeys` directive. Returns the
     * binary KRL bytes.
     */
    generateKrl(revokedSerials: number[]): Buffer {
        const dir = mkdtempSync(join(tmpdir(), "mad-krl-"));
        const listPath = join(dir, "revoked.list");
        const outPath = join(dir, "krl");
        const pubPath = join(dir, "ca.pub");
        try {
            const lines = revokedSerials.map(s => `serial: ${s}`).join("\n") + "\n";
            writeFileSync(listPath, lines);
            writeFileSync(pubPath, this.publicKey() + "\n");
            execFileSync("ssh-keygen", [
                "-k", "-f", outPath, "-s", pubPath, listPath,
            ], { stdio: ["ignore", "ignore", "pipe"] });
            return readFileSync(outPath);
        } finally {
            for (const f of ["revoked.list", "krl", "ca.pub"]) {
                try { unlinkSync(join(dir, f)); } catch {}
            }
            try { require("fs").rmdirSync(dir); } catch {}
        }
    }
}
