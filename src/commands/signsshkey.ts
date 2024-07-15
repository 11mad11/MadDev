import { Duplex } from "stream";
import { cmd } from "./_helper";
import { StringDecoder } from "string_decoder";

export default cmd(({ channel, user, prog, gateway }) => {
    prog.command("signsshkey").action((a) => {
        const decoder = new StringDecoder("utf-8");
        const inputs: string[] = [];

        (channel as Duplex).on("data", (data) => {
            inputs.push(decoder.write(data));
        });

        return new Promise((resolve, reject) => {
            channel.on("end", () => {
                try {
                    const keyPem = inputs.join("");
                    const keySigned = gateway.ca.signSSHKey(keyPem, user);
                    channel.write(keySigned);
                    channel.eof();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        })
    })
});