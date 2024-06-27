import { Server } from "ssh2";
import { generateKeyPairSync } from 'crypto';
import { SSHGateway } from "./gateway";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { Permissions } from "./permission";

const permByUser: Record<string, Partial<Permissions>> = {
    foo: {
        canRegisterService: (type, name) => type === 22 && name === "test"
    },
    mad: {
        canGenerateOTP: () => true,
        canUseService: () => true
    }
}
const gateway = new SSHGateway(name => {
    return permByUser[name]
});

const passAuth = gateway.authsProvider.password;
passAuth.setUser("foo", 'bar');
passAuth.setUser("mad", 'mad');
console.log(passAuth.setOTPUser("otp"));


if (!existsSync("keys/host.key")) {
    let keys = generateKeyPairSync('ed25519', {

    });
    writeFileSync("keys/host.key", keys.privateKey.export().toString());
}
const key = readFileSync("keys/host.key");
const server = new Server({
    hostKeys: [key],
    debug: (t) => console.log(t)
});
gateway.listenOn(server);

server.listen(2222, '127.0.0.1', function () {
    console.log('Listening on port ' + this.address().port);
});


