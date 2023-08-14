// @ts-check
import { once } from 'node:events';
import http from 'node:http';
import { StreamManager, genId } from '../streamManager.js';
import { ChunkedDecoder, ChunkedEncoder, parseResponsePacket, request } from '../http_polyfill.js';

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

const url = process.argv[2] || 'localhost:8080',

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

const server = http.createServer((req, res)=>res.writeHead(405).end('Please use the CONNECT method instead.'))
    .on('connect', (req, socket)=>{
        const id = genId();
        let closed = false;
        session.open(id, req.url);
        function onerror(reason){
            if(closed) return;
            if(this !== session) session.close(id, reason||''); // if the session emitted the event the stream was already closed
            closed = true;
            if(!socket.writable) return;
            socket.write(`HTTP/1.1 500 Internal Server Error\r\nContent-Length: ${reason?.length??0}\r\n\r\n`);
            socket.end(reason);
        }
        function onopen(){
            session.off('close-'+id, onerror);
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n');

            socket.on('data', data=>session.data(id, data));
            session.on('data-'+id, data=>!closed && socket.write(data));
            
            session.on('end-'+id, ()=>!closed && socket.end());
            socket.on('end', ()=>!socket.closed&&session.end(id));
        }
        session.once('open-'+id, onopen);
        session.once('close-'+id, onerror);
        socket.once('error', onerror).once('close', onerror);
        socket.on('error', err=>console.error('Castor socket error: ', err));
    });
server.listen(5775, '0.0.0.0', ()=>console.log('Castor HTTP server on port 5775'));