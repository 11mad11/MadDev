const { timingSafeEqual } = require('crypto');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { inspect } = require('util');

const { utils: { parseKey }, Server } = require('ssh2');
const { utils: { generateKeyPair, generateKeyPairSync } } = require('ssh2');

const allowedUser = Buffer.from('foo');
const allowedPassword = Buffer.from('bar');

function checkValue(input, allowed) {
    const autoReject = (input.length !== allowed.length);
    if (autoReject) {
        // Prevent leaking length information by always making a comparison with the
        // same input when lengths don't match what we expect ...
        allowed = input;
    }
    const isMatch = timingSafeEqual(input, allowed);
    return (!autoReject && isMatch);
}

if (!existsSync("host.key")) {
    let keys = generateKeyPairSync('ed25519', {

    });
    writeFileSync("host.key", keys.private);
}
const key = readFileSync("host.key");

new Server({
    hostKeys: [key],
    debug: (s) => console.log(s)
}, (client) => {
    console.log('Client connected!');

    client.on('authentication', (ctx) => {
        let allowed = true;
        if (!checkValue(Buffer.from(ctx.username), allowedUser))
            allowed = false;

        switch (ctx.method) {
            case 'password':
                if (!checkValue(Buffer.from(ctx.password), allowedPassword))
                    return ctx.reject();
                break;
            default:
                return ctx.reject();
        }

        if (allowed)
            ctx.accept();
        else
            ctx.reject();
    }).on('ready', () => {
        console.log('Client authenticated!');

        client.on("tcpip",(...args)=>{
            console.log(args);
        });

        /*client.forwardOut("127.0.0.1","7070","localhost","7070",(s)=>{
            console.log("s",s);
        });*/

        client.once('session', (accept, reject) => {
            const session = accept();
            session.once('exec', (accept, reject, info) => {
                console.log('Client wants to execute: ' + inspect(info.command));
                const stream = accept();
                stream.stderr.write('Oh no, the dreaded errors!\n');
                stream.write('Just kidding about the errors!\n');
                stream.exit(0);
                stream.end();
            });
        });
    }).on('close', () => {
        console.log('Client disconnected');
    });
}).listen(2222, '127.0.0.1', function () {
    console.log('Listening on port ' + this.address().port);
});
