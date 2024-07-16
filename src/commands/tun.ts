import { readFileSync } from "fs";
import { cmd } from "./_helper";

export default cmd(({ channel, user, prog, gateway }) => {
    const cmd = prog.command("tun");

    cmd.command("getSubnet <service>").action((service)=>{
        const s = gateway.services[2].services.get(service);
        if (!s)
            throw new Error("No service by name: " + service)

        channel.write(s.getSubnet(user.client));
    })

    cmd.command("open <service>").action((service) => {
        const s = gateway.services[2].services.get(service);
        if (!s)
            throw new Error("No service by name: " + service)

        return new Promise((resolve, reject) => {
            s.connect(user.username, channel);
            channel.on("close", () => {
                resolve();
            })
        })
    })
});