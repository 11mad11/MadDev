import { TcpipBindInfo, AcceptConnection, ServerChannel, TcpipRequestInfo } from "ssh2";
import { Service, User } from "../gateway";
import { TCPService } from "./tcp";
import { md, pki } from "node-forge";

const attrs = [
    { name: 'commonName', value: 'example.org' },
    { name: 'countryName', value: 'US' },
    { shortName: 'ST', value: 'California' },
    { name: 'localityName', value: 'San Francisco' },
    { name: 'organizationName', value: 'Example Inc.' },
    { shortName: 'OU', value: 'Test' }
];

export class SSHService implements Service {
    tcpService = new TCPService();
    private cert = pki.createCertificate()

    constructor() {
        var keys = pki.rsa.generateKeyPair(2048);

        this.cert.publicKey = keys.publicKey;
        this.cert.serialNumber = '01';
        this.cert.validity.notBefore = new Date();
        this.cert.validity.notAfter = new Date();
        this.cert.validity.notAfter.setFullYear(this.cert.validity.notBefore.getFullYear() + 10);
        this.cert.setSubject(attrs);
        this.cert.setIssuer(attrs);
        this.cert.sign(keys.privateKey, md.sha256.create());
    }

    async register(ctx: { user: User; info: TcpipBindInfo; }) {
        await this.tcpService.register(ctx);
    }

    async use(ctx: { user: User; accept: AcceptConnection<ServerChannel>; refuse: () => void; info: TcpipRequestInfo; }) {
        await this.tcpService.use(ctx);
    }

    signSSHKey(key: string): string {
        const parsed = pki.publicKeyFromPem(key);
        const sshCert = pki.createCertificate();

        sshCert.publicKey = parsed;
        sshCert.serialNumber = '01';
        sshCert.validity.notBefore = new Date();
        sshCert.validity.notAfter = new Date();
        sshCert.validity.notAfter.setFullYear(this.cert.validity.notBefore.getFullYear() + 10);

        sshCert.sign(this.cert.privateKey);

        return pki.certificateToPem(sshCert);
    }
}