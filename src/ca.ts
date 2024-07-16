import { Certificate, Identity, Key, PrivateKey, createCertificate, generatePrivateKey, identityFromDN, parseKey, parsePrivateKey } from "sshpk";
import { SSHGateway, User } from "./gateway";



export class CA {
    readonly privateKey: PrivateKey

    constructor(gateway: SSHGateway) {
        this.privateKey = parsePrivateKey(gateway.setting.getRaw("keys/ca.key", () => {
            return generatePrivateKey("ed25519").toString("openssh");
        }))
    }

    parse(buf: Buffer) {
        let offset = 0;

        const algoLen = buf.readInt32BE(offset); offset += 4;
        const algo = buf.subarray(offset, offset + algoLen).toString("ascii"); offset += algoLen;

        switch (algo) {
            case "ssh-rsa-cert-v01@openssh.com":
                return Certificate.parse(algo + " " + buf.toString("base64"), "openssh");
            default:
                return parseKey(buf)
        }
    }

    getKey(key: Certificate | Key | Buffer): Key {
        if (key instanceof Buffer)
            key = this.parse(key);
        if (key instanceof Certificate)
            return key.subjectKey
        if (key instanceof Key)
            return key;
        throw new Error();
    }

    validate(key: Certificate) {
        return key.isSignedByKey(this.privateKey);
    }

    signSSHKey(key: string, user: User): string {
        const parsed = parseKey(key);

        const id = new Identity({
            components: [],
            uid: user.username,
            type: "user"
        });

        const cert = createCertificate(
            id,
            parsed,
            identityFromDN("CN=foo, C=US"),
            this.privateKey,
            {}
        );

        return cert.toString("openssh");
    }

}