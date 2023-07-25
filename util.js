export function logErr(e){ console.error('Some error occured: ', e.message, e.trace); }
export function on(ees, ev, listener){ ees.forEach(ee=>ee.on(ev, listener)); }
export function off(ees, ev, listener){ ees.forEach(ee=>ee.off(ev, listener)); }
export function close(streams){ streams.forEach(stream=>{
    if(stream.close) stream.close();
    else if(stream.destroy) stream.destroy();
}); }
/** @typedef {import('node:http2')} http2*/
/**
 * @param {[import('node:http2').Http2Stream, import('node:http2').Http2Stream, string, string] | [import('node:http2').Http2Stream, string, string]} metadata 
 * @param {any} logs 
 */
export function debug(metadata, ...logs){
    if(metadata.length == 4){
        if(logs.length) console.debug('[%s-%s] (%d-%d)', metadata[2], metadata[3], metadata[0].id, metadata[1].id, ...logs);
        else console.debug('[%s] %s (%d-%d)', metadata[2], metadata[3], metadata[0].id, metadata[1].id);
    }else{
        if(logs.length) console.debug('[%s-%s] (%d)', metadata[1], metadata[2], metadata[0].id, ...logs);
        else console.debug('[%s] %s (%d)', metadata[1], metadata[2] ,  metadata[0].id);
    }
}