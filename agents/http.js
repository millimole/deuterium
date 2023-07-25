// @ts-check
import http from 'node:http';
import { connect, targetToString } from '../util.js';
import { once } from 'node:events';
/**
 * @typedef {import('node:stream').Duplex} Duplex
 * @param {import('../types.js').Proxy} proxy
 * @param {import('../types.js').Target} next
 * @param {AbortSignal} signal
 * @param {Duplex} [socket]
 * @returns {Promise<Duplex>}
 * */
export async function createConnection(proxy, next, signal, socket){
    let _socket = await connect(proxy, signal, socket);
    let request = http.request({
        hostname: proxy.hostname, signal,
        port: proxy.port, method:'CONNECT', 
        path: next.hostname+':'+next.port, // @ts-ignore createConnection() can return any value as long as it is a Duplex.
        createConnection: ()=>_socket,
        headers:{ Host: next.hostname+':'+next.port, 'User-Agent': 'fog/2' }
    });
    if(proxy.authorization) request.setHeader('Proxy-Authorization', proxy.authorization);
    request.end();
    const [response, res_socket] = await once(request, 'connect', {signal});
    if(response.statusCode !== 200){
        request.destroy();
        console.debug('Headers: %o', response.headers);
        throw new Error('Status code during handshake with '+targetToString(proxy) + ': '+response.statusCode);
    }
    console.debug('%s via %s', targetToString(next), targetToString(proxy));
    function cleanup(wasError){
        if(!wasError) res_socket.off('error', onError);
        _socket.destroy(); // clean up other underlying sockets etc
    }
    function onError(err){ console.debug(err.code||err.message); }
    res_socket.once('error', onError);
    res_socket.once('close', cleanup);
    return res_socket;
}