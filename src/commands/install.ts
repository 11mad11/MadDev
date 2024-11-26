import chalk from 'chalk';
import { Cmd, cmdDef } from "../shell";
import { createCommand } from "@commander-js/extra-typings";
import { prettyTerm } from '../utils/term';
import { readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

export default cmdDef({
    cmd: () => createCommand("install").option('-b', "Print only the raw binary").summary("Installation script"),
    perm: (ctx) => ctx.mode === "exec",
    async pty() {
        return false;
    },
    async run({ channel }, opts) {
        //File is bigger than what a string can hold, so I use streams
        //https://bun.sh/blog/bun-v1.1.23#fixed-fs-readfile-memory-size-limits

        const rs = createReadStream("./build/mad-linux");
        if (opts.b) {
            await pipeline(
                rs,
                channel
            );
        } else {
            channel.write((await readFile("./src/bash/mad/install.sh")).toString());
            await pipeline(
                rs,
                new Base64Encode(),
                channel
            );
        }

        channel.eof();
    },
});

//taken from https://github.com/mazira/base64-stream#readme
class Base64Encode extends Transform {

    extra

    constructor(options?: ConstructorParameters<typeof Transform>[0]) {
        super(options);
    }

    _transform(chunk, encoding, cb) {
        // Add any previous extra bytes to the chunk
        if (this.extra) {
            chunk = Buffer.concat([this.extra, chunk]);
            this.extra = null;
        }

        // 3 bytes are represented by 4 characters, so we can only encode in groups of 3 bytes
        const remaining = chunk.length % 3;

        if (remaining !== 0) {
            // Store the extra bytes for later
            this.extra = chunk.slice(chunk.length - remaining);
            chunk = chunk.slice(0, chunk.length - remaining);
        }

        // Convert chunk to a base 64 string
        chunk = chunk.toString('base64');

        // Push the chunk
        this.push(Buffer.from(chunk));
        cb();
    }

    /**
     * Emits 0 or 4 extra characters of Base64 data.
     * @param cb
     * @private
     */
    _flush(cb) {
        if (this.extra) {
            this.push(Buffer.from(this.extra.toString('base64')));
        }

        cb();
    }

};