import { Duplex } from "stream";
import { cmd } from "./_helper";
import { StringDecoder } from "string_decoder";

export default cmd({
    execute(user, parts, channel) {
        const decoder = new StringDecoder("utf-8");
        const inputs: string[] = [];

        (channel as Duplex).on("data", (data) => {
            inputs.push(decoder.write(data));
        });
        channel.on("end", () => {
            try {
                const keyPem = inputs.join("");
                console.log(keyPem);
                const keySigned = this.ca.signSSHKey(keyPem, user);
                channel.write(keySigned);
                channel.eof();
                channel.exit(0);
                channel.end();
            } catch (err) {
                console.error(err);
                channel.stderr.write("message" in err ? err.message : err);
                channel.stderr.write("\n");
                channel.exit(0);
                channel.end();
            }
        });
    }
});