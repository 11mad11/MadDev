import { Server } from "ssh2";
import { SSHGateway } from "./gateway";
import { generatePrivateKey } from "sshpk";
import "./utils/NetNS";

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
    canUpdateServer() {
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
    return generatePrivateKey("ed25519").toString("openssh");
}).toString();

const server = new Server({
    hostKeys: [key],
    debug: (t) => console.log(t)
});
gateway.listenOn(server);

server.listen(2222, '0.0.0.0', function () {
    console.log('Listening on port ' + this.address().port);
});

process.on('SIGINT', function () {
    console.log("\nGracefully shutting down from SIGINT (Ctrl-C)");
    process.exit(0);
});
