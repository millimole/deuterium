import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createWriteStream } from 'node:fs';

const path = fileURLToPath(dirname(import.meta.url)+'/logging/log.log');
const output = createWriteStream(path, {flags:'a+'});

const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (buf, cb)=>{
    stdoutWrite(buf, cb);
    output.write(buf);
};

const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (buf, cb)=>{
    stderrWrite(buf, cb);
    output.write(buf);
};
console.log('\r\n\r\n\r\n--------Logs reset %s--------\r\n\r\n\r\n', new Date());
export const setup = true;