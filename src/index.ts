import { Server } from "ssh2";
import { generateKeyPairSync } from 'crypto';
import { SSHGateway } from "./gateway";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { Permissions } from "./permission";

const gateway = new SSHGateway();

gateway.services[2].addNetwork("test", "172.17.0.0/16");

gateway.users.setRole("admin", {
    canGenerateOTP() {
        return true
    },
    canRegisterService(type, name) {
        return true;
    },
    canUseService(type, name) {
        return true;
    },
    canDeleteUser() {
        return true;
    },
    canChangeRole() {
        return true;
    },
    canChangeAuth() {
        return true;
    },
})

{
    gateway.users.setUser("otp", {
        permissions: {},
        roles: ["admin"]
    })
const passAuth = gateway.authsProvider.password;
console.log(passAuth.setOTPUser("otp"));
}

const key = gateway.setting.getRaw("keys/host.key", () => {
    let keys = generateKeyPairSync('ed25519', {
    });
    return keys.privateKey.export().toString();
}).toString();

const server = new Server({
    hostKeys: [key],
    debug: (t) => console.log(t)
});
gateway.listenOn(server);

server.listen(2222, '127.0.0.1', function () {
    console.log('Listening on port ' + this.address().port);
});


