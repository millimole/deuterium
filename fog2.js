import { once } from 'node:events';
import http2 from 'node:http2';
import { createServer } from 'node:http';
import { logErr, on, off, close, debug } from './util.js';

const url = 'http://localhost:1080',
    session = http2.connect(url, {settings:{enablePush: true}});
await once(session, 'connect');
console.log('Connected to Deuterium server at', url);

session.on('close', ()=>{ throw new Error('Connection interrupted'); });
const auth = session.request({ ':method': 'GET', ':path': '/authenticate', 'Proxy-Authorization': '' });
auth.once('response', headers=>{
    if(headers[':status'] !== 200) throw new Error('Authentication failed');
});
console.log('Successfully authenticated with Deuterium server');

const proxy = createServer((req, res)=>res.writeHead(405).end('Please use the CONNECT method.'));
proxy.on('connect', async (req, socket)=>{
    try{
        let status = 0; // 0 = not yet connected, 1 = failed, 2 = success
        const ac = new AbortController(),
            {url} = req,
            tx = session.request({ ':method': 'POST', 'X-Target': url }),
            /*Wait for RX to be established*//** @type {http2.ClientHttp2Stream} */
            rx = await new Promise((resolve, reject)=>{ // If socket closes here kill TX & end the whole thing
                const abort = ()=>{
                    off([socket, tx], 'close', abort);
                    session.off('stream', onStream);
                    tx.close();
                    reject(new Error(`[${tx.id}-${url}] TX stream aborted before RX recieved`));
                };
                const onStream = (rx, headers)=>{
                    if(headers['x-original-request'] == tx.id){
                        debug([tx, rx, 'duplexed', url]);
                        off([socket, tx], 'close', abort);
                        session.off('stream', onStream);
                        resolve(rx);
                    }
                };
                debug([tx, 'init', url]);
                on([socket, tx], 'close', abort);
                session.on('stream', onStream);
            }),
            streams = [socket, tx, rx],
            closeAll = function(){ // if any streams to server close, all close (operation aborted)
                ac.abort();
                off(streams, 'close', closeAll);
                off(streams, 'error', logErr);
                close(streams);
                debug([tx, rx, 'conn-gc', url]);
                if(status == 0) debug([tx, rx, 'conn-cancelled', url]);
                if(status == 1) debug([tx, rx, 'conn-fail', url]);
            };
        on(streams, 'close', closeAll);
        on(streams, 'error', logErr);
        const response = (await once(rx, 'push', ac))[0]; // wait for proxy to establish connection or fail
        if(response[':status'] !== 200) {
            debug([tx,rx, url], 'Response packet headers:', response);
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            status = 1;
            return closeAll();
        }
        status = 2; debug([tx, rx, 'conn-ok', url]);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(tx); rx.pipe(socket);
    }catch(e){
        console.error('Error occured while connecting to target:', e);
        if(socket.writable) socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    }
});
proxy.listen(5775, ()=>console.log('fog2 client listening on port 5775'));