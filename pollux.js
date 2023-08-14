// @ts-check
import { createServer, connect } from 'node:net';
import { StreamManager, genId } from './streamManager.js';
import { once } from 'node:events';
import { ChunkedDecoder, ChunkedEncoder, parseRequestPacket } from './http_polyfill.js';

/** @type {Map<string, StreamManager>} */
const sessions = new Map();
const port = +(process.env.PORT || 8080);

const server = createServer({allowHalfOpen: true}, async socket=>{
    const err = ()=>{ throw new Error('Stream died before request completion'); };
    socket.once('close', err);
    const [packet] = await once(socket, 'data');
    socket.off('close', err);
    const reqData = parseRequestPacket(packet);
    if(reqData.httpVersion !== '1.1') return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    if(reqData.method == 'GET' && !reqData.headers['x-session-id']){
        if(reqData.url !== '/') return socket.end('HTTP/1.1 204 No Content\r\n\r\n');

        const session = new StreamManager(), sessionId = genId(), res = ChunkedEncoder.from(socket);
        socket.write(
            'HTTP/1.1 200 OK\r\n'+
            `X-Stream-ID: ${session.add(0, res)}\r\n`+
            `X-Session-ID: ${sessionId}\r\n`+
            'Transfer-Encoding: chunked\r\n\r\n'
        );
        session.once('cleanup', ()=>{ sessions.delete(sessionId); });
        session.once('error', err=>console.error('Session error: ', err));
        sessions.set(sessionId, session);
        // more setup
        session.on('open', async (id, data)=>{
            /** @type {import('node:net').Socket} */
            let socket, closed = false;
            const close = function close(){
                if(closed) return; closed = true;
                session.close(id); socket?.destroy();
            };
            try{
                const target = new URL('tcp://'+data.toString());
                if(target.pathname || target.hash || target.search || target.password || target.username) throw new Error('Invalid URL');
                // @ts-ignore ??? why doesnt it work
                socket = connect({host: target.hostname, port: target.port || '80', allowHalfOpen: true});


                session.once('close-'+id, close);
                socket.on('error', err=>console.error('Pollux socket error:', err)).once('close', close);
                
                socket.on('data', data=>session.data(id, data));
                session.on('data-'+id, data=>!closed && socket.write(data));
                session.once('end-'+id, ()=>!closed&&socket.end());
                socket.once('end', ()=>!socket.errored&&session.end(id));
                await once(socket, 'connect'); session.open(id);
            }catch(e){ close(); console.error('Pollux connection error', e); }
        });
        session.once('close', id=>console.log('Stream %s close', id));
        session.once('error', err=>console.error('Session %s error:', sessionId, err));
    } else if(reqData.headers['x-session-id']){
        const session = sessions.get(reqData.headers['x-session-id']+'');
        if(!session) return socket.end('HTTP/1.1 401 Unauthorised\r\n\r\n');
        if(reqData.method == 'GET')
            socket.write(
                'HTTP/1.1 200 OK\r\n'+
                'Transfer-Encoding: chunked\r\n'+
                `X-Session-ID: ${reqData.headers['x-session-id']}\r\n`+
                `X-Stream-ID: ${session.add(0, ChunkedEncoder.from(socket))}\r\n\r\n`
            );
        else if(reqData.method == 'POST') session.add(1, ChunkedDecoder.from(socket));
    } else return socket.end('HTTP/1.1 204 No Content\r\n\r\n');
});
server.listen(port, '0.0.0.0', ()=>console.log('Pollux up on port %d', port));