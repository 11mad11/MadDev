import { cmd } from "./_helper";

export default cmd(({ channel, user, prog, gateway }) => {
    if (!user.permission.canGenerateOTP())
        return;
    prog.command("otp <username>").action((username) => {
        const otp = gateway.authsProvider.password.setOTPUser(username);
        channel.stdout.write("Here's the one time password: " + otp + "\n");
    })
});