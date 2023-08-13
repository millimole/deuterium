// @ts-check
import { BlockList, connect } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:net';
import dns from 'node:dns';
import { genId, StreamManager } from '../streamManager.js';
import { ChunkedDecoder, ChunkedEncoder, request, parseResponsePacket } from '../http_polyfill.js';

// local address list
const localAddresses = new BlockList();

// ipv4 local blocks
localAddresses.addRange('10.0.0.0', '10.255.255.255', 'ipv4');
localAddresses.addRange('127.0.0.0', '127.255.255.255', 'ipv4');
localAddresses.addRange('192.168.0.0', '192.168.255.255', 'ipv4');
localAddresses.addRange('172.16.0.0', '172.16.255.255', 'ipv4');
// ipv6 local blocks
localAddresses.addAddress('::1', 'ipv6');
localAddresses.addSubnet('fe80::', 10, 'ipv6');
localAddresses.addSubnet('fc00::', 7, 'ipv6');

const url = 'localhost:8080',

    [_rx, response1] = await request(url, true, 'GET / HTTP/1.1\r\n\r\n'),
    sessionId = response1.headers['x-session-id'],
    [_tx] = await request(url, false, `POST / HTTP/1.1\r\nX-Session-ID: ${sessionId}\r\nTransfer-Encoding:chunked\r\n\r\n`),
    
    rx = ChunkedDecoder.from(_rx), tx=ChunkedEncoder.from(_tx),
    session = new StreamManager();

session.add(1, rx, response1.headers['x-stream-id']);
console.log('RX request sent, waiting for TX response');
session.add(0, tx, (await once(session, 'ack'))[0]);
await (add(0).then(()=>add(1))); // four tunnels
console.log('Successfully authorized to Pollux');

_tx.on('data', d=>console.error('Premature response of', parseResponsePacket(d)));
session.on('cleanup', ()=>{ throw new Error('Session destroyed'); });

// top-tier error handlers
const clientError = err => console.debug('Client error', err);
const foreignError = err => console.debug('Foreign error', err);

const server = createServer(async socket=>{
    const throwing = ()=>socket.emit('error', new Error('Premature close'));
    const rid = genId();
    socket.once('close', throwing).on('error', clientError);
    const [initPacket] = (/** @type {[Buffer|undefined]} */ (await (once(socket, 'data').catch(()=>[undefined]))));
    if(!initPacket) return;
    socket.off('close', throwing);
    if(initPacket.length == 0) return socket.destroy();
    const versionNumber = initPacket.readUInt8(0);

    if(versionNumber == 4){
        console.log('Incoming v4 request %s', rid);
        // recv VER(1) CMD(1) PORT(2) IP(4) ID(VAR)
        // send VER(1) REP(1) PORT(2) IP(4)
        if(initPacket.length < 9) return socket.end(Buffer.from([0x04, 0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        const cmd = initPacket.readUInt8(1);
        const ip = initPacket.subarray(4, 8),
            port = initPacket.readUInt16BE(2),
            usernameEnd = initPacket.findIndex((v, i)=> i>=8 && v == 0), // the userID field is null terminated
            domain = initPacket.subarray(usernameEnd+1); // do not include the null byte from before
        let host = '';
        if(cmd !== 1 || usernameEnd < 0) return socket.end(Buffer.concat([Buffer.from([0x04, 0x5b]), initPacket.subarray(2, 8)])); // no bind requests & some username must be given (just do with the blank one)
        if(ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] !== 0 && domain.length >= 1){ // socks4a: domain name was given after the initial packet
            if(domain.readUInt8(domain.length - 1) !== 0) return socket.end(Buffer.concat([Buffer.from([0x00, 0x5b]), initPacket.subarray(2, 8)])); // domain not null-terminated
            const domainStr = domain.subarray(0, -1).toString();
            try{ host = await resolve(domainStr); } catch(e){
                console.error('%s DNS lookup failed:', rid, e);
                return socket.end(Buffer.concat([Buffer.from([0x00, 0x5b]), initPacket.subarray(2, 8)]));
            }
            console.log('%s DNS lookup %s => %s', rid, domainStr, host);
        } else host = ip.join('.'); // ipv4 address
        if(socket.closed) return; // Request aborted
        if(localAddresses.check(host)){
            // direct connection
            console.log('%s local host detected', rid);
            pipeToSocket(
                host, port, socket,
                Buffer.concat([Buffer.from([0x00, 0x5a]), initPacket.subarray(2, 8)]),
                Buffer.concat([Buffer.from([0x00, 0x5b]), initPacket.subarray(2, 8)])
            );
        }
        console.log('%s Connecting to %s:%d', rid, host, port);
        return pipeToStream(
            host.includes(':')?`[${host}]`:host, port, socket,
            Buffer.concat([Buffer.from([0x00, 0x5a]), initPacket.subarray(2, 8)]),
            Buffer.concat([Buffer.from([0x00, 0x5b]), initPacket.subarray(2, 8)])
        );
    }else if(versionNumber === 5){
        console.log('Incoming v5 request %s', rid);
        // recv VER(1) LEN(1) METHODS(LEN)
        // send VER(1) METHOD(1)
        const protocols = initPacket.subarray(2);
        if(protocols.length !== initPacket.readUInt8(1)) return socket.end(Buffer.from([0x05, 0xff])); // Length does not match list of protocols provided
        if(protocols.indexOf(0) < 0) return socket.end(Buffer.from([0x05, 0xff])); // No acceptable protocol (only supports no authentication)
        await new Promise((res, rej)=>socket.write(Buffer.from([0x05, 0x00]), (err)=>err?rej(err):res(!0)));
        console.log('%s Chosen auth method: 0x00 NOAUTH', rid);
        // recv VER(1) CMD(1) RSV(1;0x00) TYPE(1;0x01|0x03|0x04) ADDR(VAR|4|16) PORT(2)
        // send VER(1) REP(1) RSV(1;0x00) TYPE(1;0x01|0x03|0x04) ADDR(VAR|4|16) PORT(2)
        socket.once('close', throwing);
        const [request] = (/** @type {[Buffer|undefined]} */ (await (once(socket, 'data').catch(()=>[undefined]))));
        socket.off('close', throwing);
        if(!request) return;
        if( request.readUInt8(0) !== 5 || // version wasn't v5
            request.readUInt8(1) !== 1 || // Only supports CONNECT
            request.readUInt8(2) !== 0 // RSV not set to 0
        ) return socket.end(Buffer.concat([Buffer.from([0x05, 0x07, 0x00]), request.subarray(3)]));
        let host = '', addrType = request.readUInt8(3), port = request.readUInt16BE(request.length - 2);

        if(addrType == 1){ // IPv4
            if(request.length !== 10) return socket.end(Buffer.concat([Buffer.from([0x05, 0x07, 0x00]), request.subarray(3)])); // tried overflowing me?
            host = request.subarray(4, 8).join('.');
        } else if(addrType == 3){ // domain name
            // LEN(1) DOMAIN(VAR)
            const domainLength = request.readUInt8(4);
            const domainBuf = request.subarray(5, -2);
            if(domainBuf.length !== domainLength) return socket.end(Buffer.concat([Buffer.from([0x05, 0x07, 0x00]), request.subarray(3)])); // too long
            const domainStr = domainBuf.toString();
            try{ host = await resolve(domainStr); }
            catch (e){ return socket.end(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), request.subarray(3)])); } // dns failed
            console.log('%s DNS lookup %s => %s', rid, domainStr, host);
        } else if(addrType === 4){
            if(request.length !== 22) return socket.end(Buffer.concat([Buffer.from([0x05, 0x07, 0x00]), request.subarray(3)])); // tried overflowing me?
            host = [4, 6, 8, 10, 12, 14, 16, 18].map(index=>request.readInt16BE(index).toString(16)).join(':'); // separate into 8 chunks of 2 octets, hexadecimal it, and join with colons
        } else return socket.end(Buffer.concat([Buffer.from([0x05, 0x07, 0x00]), request.subarray(3)])); // bad address info

        if(socket.closed) return; // Request aborted
        if(localAddresses.check(host)){
            // direct connection
            console.log('%s local host detected', rid);
            return pipeToSocket(
                host, port, socket,
                Buffer.concat([Buffer.from([0x05, 0x00, 0x00]), request.subarray(3)]),
                Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), request.subarray(3)])
            );
        }
        console.log('Connecting %s to %s:%d', rid, host, port);
        return pipeToStream(
            host.includes(':')?`[${host}]`:host, port, socket,
            Buffer.concat([Buffer.from([0x05, 0x00, 0x00]), request.subarray(3)]),
            Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), request.subarray(3)])
        );
    } else return socket.destroy();
});

server.listen(5775, ()=>console.log('SOX server up at port 5775'));


// function declarations

function resolve(domain){
    return dns.promises.resolve4(domain).then(([ipv4])=>ipv4)
        .catch(reason=>reason == dns.NOTFOUND?dns.promises.resolve6(domain).then(([ipv6])=>ipv6):Promise.reject(reason));
}

/** @param {string} host @param {number} port @param {import('node:net').Socket} socket @param {Buffer} success @param {Buffer} fail @return {import('node:net').Socket}*/
function pipeToSocket(host, port, socket, success, fail){
    const foreign = connect(port, host);
    socket.once('close', ()=>foreign.unpipe().destroy());
    once(foreign, 'connect').then(()=>
        socket.pipe(
            foreign.once('close', ()=>socket.unpipe().destroy()).on('error', foreignError)
        ).pipe(socket).write(success)
    ).catch(()=>socket.writable?socket.end(fail).destroy():socket.destroy());
    return foreign;
}

// quickly add a new stream
async function add(type){
    if(type == 1) {
        const [rx, response] = await request(url, true, 'GET / HTTP/1.1\r\nX-Session-ID: '+sessionId+'\r\n\r\n');
        if(response.statusCode === '200') session.add(1, ChunkedDecoder.from(rx), response.headers['x-stream-id']);
    }
    else if (type == 0){
        const [tx] = await request(url, false, 'POST / HTTP/1.1\r\nX-Session-ID: '+sessionId+'\r\n\r\n');
        session.add(0, ChunkedEncoder.from(tx), (await once(session, 'ack'))[0]);
    }
}

/** @param {string} host @param {number} port @param {import('node:net').Socket} socket @param {Buffer} success @param {Buffer} fail */
function pipeToStream(host, port, socket, success, fail){
    const id = genId();
    let closed = false, opened = false;
    session.open(id, `${host}:${port}`);
    socket.once('close', ()=>{
        if(closed) return; closed = true;
        socket.removeAllListeners('data').removeAllListeners('end');
        session.close(id);
    });
    session.once('close-'+id, err=>{
        closed = true; if(err?.length) foreignError(err.toString());
        if(opened == false && socket.writable) socket.end(fail);
        else if(!socket.closed) socket.destroy();
    }).once('open-'+id, onopen);
    function onopen(){
        opened = true;
        socket.on('data', data=>session.data(id, data)).write(success);
        session.on('data-'+id, data=>socket.write(data));
        session.on('end-'+id, ()=>!socket.writable && socket.end());
        socket.on('end', ()=>(!closed) && session.end(id));
    }

}