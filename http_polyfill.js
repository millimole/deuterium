// @ts-check
import net from 'node:net';
// import http from 'node:http';
import { Transform } from 'node:stream';
import { once } from 'node:events';

const empty = Buffer.allocUnsafeSlow(0);
const crlf = Buffer.from('\r\n');
// const incompleteChunkError = new Error('Chunked encoding error: intial packet did not contain CRLF');
const trailerDataWarning = 'Data recieved after stream ended. This is presumably trailer data, which will be ignored.';

export class ChunkedEncoder extends Transform{
    /** @param {import('net').Socket} socket */
    static from(socket){
        const res = new ChunkedEncoder();
        res.pipe(socket);
        socket.on('error', err=>!res.errored && res.emit('error', err));
        res.on('error', err=>!socket.errored && socket.emit('error', err));
        return res;
    }
    _transform(_chunk, enc, cb){
        const chunk = Buffer.from(_chunk, enc);
        this.push(Buffer.concat([Buffer.from(chunk.length.toString(16)), crlf, chunk, crlf]));
        cb(null);
    }
    _flush(cb){ cb(null, Buffer.from('0\r\n\r\n')); }
}
export class ChunkedDecoder extends Transform{
    buffer = empty;
    remainingLength = NaN;
    ended = false;
    leftover = empty;

    /** @param {import('net').Socket} socket */
    static from(socket){
        const req = new ChunkedDecoder();
        socket.pipe(req);
        socket.on('error', err=>!req.errored && req.emit('error', err));
        req.on('error', err=>!socket.errored && socket.emit('error', err));
        return req;
    }

    _transform(_chunk, enc, cb){
        if(this.ended) return console.debug(trailerDataWarning);
        const chunk = Buffer.from(_chunk, enc);
        if(this.buffer.length == 0) this.initialPacket(chunk);
        else this.addToBuffer(chunk);
        while (this.remainingLength == 0){
            if(!this.buffer.subarray(-2).equals(crlf)){
                console.debug({errorPacket: this.buffer.toString()});
                throw new Error('Chunked encoding error: chunk did not end with CRLF');
            }
            if(this.buffer.length == 2){ 
                if(this.leftover.length) console.debug(trailerDataWarning);
                this.leftover = this.buffer = empty;
                this.ended = true;
                this.push(null);
                break;
            }
            this.push(this.buffer.subarray(0, -2));
            if(this.leftover.length) this.initialPacket(empty);
            else {this.remainingLength = NaN; this.buffer = empty;}
        }
        cb(null);
    }

    addToBuffer(/** @type {Buffer} */ chunk){
        const copiedLength = Math.min(chunk.length, this.remainingLength);
        this.buffer.set(chunk.subarray(0, copiedLength), this.buffer.length-this.remainingLength);
        this.leftover = Buffer.concat([this.leftover, chunk.subarray(copiedLength)]);
        this.remainingLength -= copiedLength;
    }

    initialPacket(/** @type {Buffer} */ chunk){
        this.leftover = Buffer.concat([this.leftover, chunk]);
        const headerEnd = this.leftover.indexOf(crlf),
            header = this.leftover.subarray(0, headerEnd),
            length = Number('0x'+header.toString('ascii'))+2;
        if(headerEnd == -1) return;
        else if(isNaN(length)){
            console.debug({errorPacket: this.leftover.toString()});
            throw new Error('Length should not be NaN');
        }
        this.buffer = Buffer.alloc(length);
        this.remainingLength = length;
        const buf = this.leftover.subarray(headerEnd+2);
        this.leftover = empty;
        this.addToBuffer(buf);
    }
    _destroy(cb){
        this.buffer = this.leftover = empty;
        cb(null);
    }
}

/** @param {Buffer} data */
export function parseRequestPacket(data){
    const [requestHeader] = data.toString('ascii').split('\r\n\r\n');

    const [firstLine, ...otherLines] = requestHeader.split('\n');
    const [method, url, httpVersion] = firstLine.trim().split(' ');
    const headers = Object.fromEntries(otherLines.filter(_=>_)
        .map(line=>line.split(':').map(part=>part.trim()))
        .map(([name, ...rest]) => [name.toLowerCase(), rest.join(' ')]));

    return {
        method, 
        url,
        httpVersion: httpVersion.replace('HTTP/', ''),
        headers
    };
}

/** @param {Buffer} data */
export function parseResponsePacket(data){
    const [requestHeader] = data.toString('ascii').split('\r\n\r\n');

    const [firstLine, ...otherLines] = requestHeader.split('\n');
    const [httpVersion, statusCode, statusText] = firstLine.trim().split(' ');
    const headers = Object.fromEntries(otherLines.filter(_=>_)
        .map(line=>line.split(':').map(part=>part.trim()))
        .map(([name, ...rest]) => [name.toLowerCase(), rest.join(' ')]));

    return {
        statusCode, 
        statusText,
        httpVersion: httpVersion.replace('HTTP/', ''),
        headers
    };
}
const proxyURL = process.argv[2];
let proxyData = undefined;
try{
    const url =  new URL(proxyURL);
    const cred = url.username+':'+url.password;
    const auth = 'Basic '+ Buffer.from(cred).toString('base64');
    proxyData = {
        method: 'CONNECT',
        hostname: url.hostname,
        port: url.port,
        _auth: auth,
        _host: url.host,
        headers: auth? { 'Proxy-Authorization': auth } : {}
    };
} catch(e){ /* Do nothing */ }

/**
 * @template {boolean} T
 * @param {string} url
 * @param {T} wait
 * @param {string|Buffer} initPacket
 * @returns {Promise<T extends true?[net.Socket, { statusCode: string, statusText: string, httpVersion: string, headers: {[k: string]: string} }]:[net.Socket]>}
*/
export async function request(url, wait, initPacket='', skip=false){
    const urlData = new URL(url);
    let socket; // support for HTTP proxies
    if(proxyData && !skip) {
        const [sock, res] = await request(
            proxyData._host, true,
            `CONNECT ${urlData.hostname}:${urlData.port} HTTP/1.1 \r\n`+
            proxyData._auth? `Proxy-Authorization: ${proxyData._auth}` : '' +
            `Host: ${urlData.hostname}:${urlData.port}\r\n\r\n`,
            true
        );
        if(res.statusCode !== '200') throw new Error(`Unexpected proxy status code ${res.statusCode} headers ${JSON.stringify(res.headers)}`);
        socket = sock;
        // const [res, sock] = await once(http.request({...proxyData, headers:{...proxyData.headers, Host: url}, path: url}).end(), 'connect');
        // if(res.statusCode !== 200) throw new Error(`Unexpected proxy status code ${res.statusCode} headers ${JSON.stringify(res.headers)}`);
        // socket = sock;
    } else {
        socket = net.connect(+(urlData.port || 80), urlData.hostname);
        await once(socket, 'connect');
    }
    socket.write(initPacket); // @ts-ignore
    if(wait) return [socket, parseResponsePacket((await once(socket, 'data'))[0])]; // @ts-ignore
    else return [socket];
}