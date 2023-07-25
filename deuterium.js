import { once } from 'node:events';
import net from 'node:net';
import http2 from 'node:http2';
import { logErr, on, off, close } from './util.js';
const server = http2.createServer();
server.on('session', async session=>{
    // wait for auth
    await new Promise((res, rej)=>{
        const onStream = (auth, headers)=>{
            if(headers[':path'] !== '/authenticate' || (headers['proxy-authorization'] || '') !== (process.env.AUTH || '')){
                console.log('Client failed authentication, headers attached were: ', headers);
                console.debug('Expected Proxy-Authorization header: %s', JSON.stringify(process.env.AUTH || ''));
                auth.respond({ ':status': 407, 'Proxy-Authenticate': 'Basic realm="Access to Deuterium"' });
                auth.end();
            } else {
                auth.respond({ ':status': 200 });
                session.off('close', fail);
                session.off('stream', onStream);
                res(session);
                // TODO: limit bandwidth
            }
        };
        const fail = ()=>{ rej(new Error('Aborted')); };
        session.on('stream', onStream);
        session.on('close', fail);
    }).catch(err=>{
        console.error('Error during auth phase: ', err);
        session.close();
    });

    session.on('error', err=>console.log('Session destroyed', err));
    // handle requests
    session.on('stream', (rx, header)=>{
        // rx.resume();
        // establish PUSH_PROMISE writable stream
        rx.pushStream({ 'X-Original-Request': rx.id }, async (err, tx)=>{
            if(err) {
                rx.close(); tx.close();
                return console.log('(%d) Failed to establish server push stream', rx.id);
            }else if(!rx.readable || !tx.writable){
                tx.close(); rx.close();
                return console.log('(%d-%d) RX closed before TX established', tx.id, rx.id);
            }
            const url = header['x-target'];
            let parsed;
            try{ parsed = new URL(`http://${url}`); }
            catch(e) {
                tx.respond({':status': 400});
                tx.end('Invalid URL');
                return console.log('(%d-%d) Invalid URL %s provided by client', tx.id, rx.id, JSON.stringify(url));
            }
            const socket = net.connect({
                host: parsed.hostname,
                port: +(parsed.port || '80')
            });
            try{
                await once(socket, 'connect');
                tx.respond({ ':status': 200 });
                socket.pipe(tx);
                rx.pipe(socket);
                const sockets = [tx, rx, socket], onError = (err)=>{
                    logErr(err);
                    close(sockets);
                    off(sockets, 'error', onError);
                };
                on(sockets, 'error', onError);
            } catch(err){
                console.error('[%s] (%d-%d) Error while connecting to server:',tx.id, rx.id, url, err);
                if(!tx.writable) return;
                tx.respond({ ':status': 500 });
                tx.end('Error occured while connecting to server');
            }
        });
    });
});
server.listen(1080, '0.0.0.0', ()=>console.log('Deuterium server listening on port 1080'));