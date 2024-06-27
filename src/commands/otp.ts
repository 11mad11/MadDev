import { cmd } from "./_helper";

export default cmd({
    execute(user, parts, channel) {
        if (!user.permission.canGenerateOTP()) {
            channel.stderr.write("You do not have the permission\n");
            channel.exit(-1);
            channel.end();
            return;
        }
        if (!parts[1]?.length) {
            channel.stderr.write("You must provide the username\n");
            channel.exit(-1);
            channel.end();
            return;
        }
        const otp = this.authsProvider.password.setOTPUser(parts[1]);

        channel.stdout.write("Here's the one time password: " + otp + "\n");
        channel.exit(0);
        channel.end();
    }
});