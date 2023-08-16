// @ts-check
import EventEmitter from 'node:events';
import { ChunkedDecoder, ChunkedEncoder } from './http_polyfill.js';
/** @typedef {import('node:stream').Readable} Readable */
/** @typedef {import('node:stream').Writable} Writable */

/** @type {<K,V>(map: Map<K, V>, value:V)=>K|undefined} */
function keyOf(map, value){
    return Array.from(map.entries())
        .find(e=>e[1] == value)?.[0];
}
export function genId(){
    const millisPerDay = 1000*3600*24;
    const antiCollisionCount = 1000;
    // << 1 in base antiCollisionCount and add a random digit to end
    return (Math.floor(Math.random()*antiCollisionCount)+(Date.now()%millisPerDay)*antiCollisionCount).toString(36);
}
export class StreamManager extends EventEmitter{
    static TIMEOUT = 90000;
    constructor(){
        super(); const self = this;
        
        // timeouts
        // this._onTimeout = ()=>this.emit('_error', new Error('No PING response, timed out'), true);
        // this._timeoutTimer = setTimeout(this._onTimeout, StreamManager.TIMEOUT);
        // this._pingTimer = setInterval(()=>{
        //     console.log('Sending pings...');
        //     console.log('Stream map:', this._streams);
        //     this._send({name:'P'});
        // }, StreamManager.TIMEOUT/2);

        // error management
        this.on('_error', (err, wasInternal)=>{
            if(wasInternal) this._send({name: 'E', data: err instanceof Error?err.message:err});
            this.emit('error', err);
            this.emit('cleanup');
        });

        this.alive = true;
        this.once('cleanup', ()=>this.alive = false);
        
        /** @type {Map<string, Writable>} */ this.txs = new Map();
        /** @type {Map<string, Readable>} */ this.rxs = new Map();
        /** @type {Map<string, [string, boolean, string, boolean]>} */ this._streams = new Map();

        // handler definitions

        this.once('cleanup', ()=>{
            this._streams.clear();
            this.txs.forEach(tx=>{
                tx.off('close', this._onClose).off('tx', this._onData).off('error', this._onError);
                tx.destroy();
            });
            this.txs.clear();
            this.rxs.forEach(rx=>{
                rx.off('close', this._onClose).off('tx', this._onData).off('error', this._onError)
                    .destroy();
            }); this.rxs.clear();
            // clearInterval(this._pingTimer); clearTimeout(this._timeoutTimer);
            console.log('StreamManager GC');
        });

        /** @this {Readable|Writable} */ this._onError = function(err){
            const rxId = keyOf(self.rxs, this);
            const txId = keyOf(self.txs, this);
            console.log('tunnel error: ids are tx=%s, rx=%s:', txId, rxId, err);
            self.emit('tunnel-err', this, err);
            this.emit('close', false);
        };

        /** @this {Readable|Writable} */ this._onClose = function(){ // remove tunnel from list of useables
            // if(!wasError) this.off('error', self._onError);
            this.off('data', self._onData);
            const rxId = keyOf(self.rxs, this);
            const txId = keyOf(self.txs, this);
            if(!txId && !rxId) return;
            self.txs.delete(txId||'');
            self.rxs.delete(rxId||'');
            if(!(self.txs.size && self.rxs.size)) self.emit('cleanup');
            console.log('tunnel died: ids are tx=%s, rx=%s', txId, rxId);
            self.emit('tunnel-died', this);
            // removing all relevant streams
            for(let entry of self._streams.entries()){
                const [key, value] = entry;
                if(value[0] == txId || value[2] == rxId) self._streams.delete(key);
            }
        };
        /** @this {Readable} @param {Buffer} _data*/ this._onData = function(_data){ try{
            const throwError = err=>self.emit('_error', new Error(err), true);
            const packet = Buffer.from(_data);
            const newline = packet.indexOf('\n'),
                data = packet.subarray(newline+1),
                header = packet.subarray(0, newline).toString(),
                [ev, id] = header.split('_'),
                stream = self._streams.get(id),
                tunnel = keyOf(self.rxs, this);
            // console.log('tunnelrecv---------', _data.length, header);
            // console.log('Frame metadata info:', {ev, data: data.toString(), id});
            if(!tunnel) throw throwError('Data read on a non-existent tunnel');

            // stream & tunnel inspecific
            if(ev == 'A') self.emit('ack', data.toString()); // ack
            else if(ev == 'E') self.emit('_error', new Error(data.toString()), false); // error
            // else if(ev == 'P') { // ping
            //     clearTimeout(this._timeoutTimer);
            //     console.log('PING recived, extending timeout...');
            //     this._timeoutTimer = setTimeout(this._onTimeout, StreamManager.TIMEOUT);
            // }
            else if(ev == 'O'){ // open
                console.debug('OPEN %s rx=%s', id, tunnel);
                if(stream){
                    if(stream[2]) throw throwError('Recieved OPEN frame on a ongoing stream');
                    stream[2] = tunnel;
                    stream[3] = true;
                }else self._streams.set(id, ['', true, tunnel, true]);
                self._emit('open', id, data);
            } else if(!stream) // stream specific
                throw console.error(`Frame ${_data.length} of type ${ev} recieved over a non-existent stream ${id}`);
            else if(stream[2] && stream[2] !== tunnel){
                console.debug('Preerror streams', self._streams);
                throw throwError(`CLOSE frame for ${id} sent over wrong tunnel ${tunnel}, alternate writable tunnel ${stream[2]} existed`);
            }else if(ev === 'C') {
                if(self._streams.delete(id)){
                    self._emit('close', id, data);
                    self._removeSessionListeners(id);
                }
            } else if(!stream[3]) // stream must be open
                throw throwError(`Frame ${_data.length} of type ${ev} sent over wrong tunnel`);
            else if(ev === 'D') self._emit('data', id, data);
            else if(ev === 'H'){ // half-close
                if(!stream[3]) return throwError('Stream already half closed');
                self._emit('end', id);
                stream[3] = false;
                if(!stream[1]){ // full close
                    self._emit('close', id);
                    self._streams.delete(id);
                }
            } else throw throwError(`Invalid frame ${_data.toString()} recieved`);
        }catch(e){ if(e) console.error('Caught error while parsing', e); }};
    }

    /** @param {string} ev @param {string} id @param {...any} data */
    _emit(ev, id, ...data){
        this.emit(ev+'-'+id, ...data);
        this.emit(ev, id, ...data);
    }

    /** @param {{id?: string, name: string, data?: Buffer|string}} packet @param {(error?: Error|null)=>void} [cb] */
    _send({id='', name, data=''}, cb){
        if(!this.alive) return;
        if(typeof name !== 'string') throw new Error('Event name must be a string');
        let header = (name+(id?'_'+id:''))+'\n',
            frame = Buffer.concat([Buffer.from(header), Buffer.from(data??'')]),
            tunnelInfo = this._streams.get(id);
        if(tunnelInfo?.[1] && !tunnelInfo[0]) tunnelInfo[0] = this._randomTunnel(0);
        let tx = id? this.txs.get(tunnelInfo?.[0] || '') : this.txs.get(this._randomTunnel(0));
        if(id && !tunnelInfo) throw new Error(`Stream to write on (${id}) does not exist`);
        if(!tx || (id && !tunnelInfo?.[1])) throw new Error('Tunnel corrupted or stream not writable');
        tx.write(frame, cb);
    }

    /** @param {string} id */
    _removeSessionListeners(id){
        return this.removeAllListeners('close-'+id)
            .removeAllListeners('open-'+id)
            .removeAllListeners('data-'+id)
            .removeAllListeners('end-'+id);
    }
    
    /** @param {0|1} type  */
    _randomTunnel(type){
        const keys = Array.from((type==0?this.txs:this.rxs).keys());
        const ret = keys[Math.floor(Math.random()*keys.length)];
        if(ret == undefined) throw new Error('Tunnel pool is empty');
        return ret;
    }

    /** @overload @param {0} type @param {Writable} tunnel @param {string} [name] */
    /** @overload @param {1} type @param {Readable} tunnel @param {string} [name] */
    /** @param {0|1} type @param {Writable|Readable} tunnel @param {string} [name] */
    add(type, tunnel, name=genId()){
        if(type == 0 && 'writable' in tunnel){
            let tunnel2 = ChunkedEncoder.fromStream(tunnel);
            this.txs.set(name,  tunnel = tunnel2);
        }
        else if(type == 1 && 'readable' in tunnel) {
            let tunnel2 = ChunkedDecoder.fromStream(tunnel);
            this.rxs.set(name, tunnel = tunnel2.on('data', this._onData));
            try{ this._send({name:'A', data: name}); } catch(e){/*Ignore*/}
        }
        else throw new Error('Either an invalid type (should be 0 or 1) or invalid tunnel (type 0 = writable, type 1 = readable) provided');
        tunnel.on('close', this._onClose).on('error', this._onError);
        return name;
    }

    /** @param {string} id @param {string|Error|Buffer} [error] */
    close(id, error){
        if(!this.alive) return;
        const trace = new Error(id); trace.name = 'Stream closing';
        const stream = this._streams.get(id);
        if(!stream){ console.debug(trace); throw new Error('Stream to be closed does not exist'); }
        if(!stream[1]) return this.once('open-'+id, ()=>this.close(id, error)); // prevent the "closing before open ack recv" race condition
        const onrecv = ()=>{
            console.debug('Stream %s closed', id, this._streams);
            this._emit('close', id);
            this._removeSessionListeners(id)._streams.delete(id);
        };
        this._send({id, name: 'C', data: error instanceof Error?error.message:error}, onrecv);
    }
    
    /** Send data over a stream
     * @param {string} id @param {string|Buffer} data */
    data(id, data){ if(this.alive) this._send({id, name:'D', data}); }

    /** @param {string} id */
    end(id){
        if(!this.alive) return;
        const stream = this._streams.get(id);
        if(stream){
            this._send({id, name:'H'}, ()=>{
                stream[1] = false;
                if(!stream[3]){
                    this._emit('close', id);
                    this._removeSessionListeners(id)._streams.delete(id);
                }
            });
        }
    }

    /** Select a random tunnel & start stream @param {string} id @param {string|Buffer} data */
    open(id, data=''){
        if(!this.alive) return;
        const stream = this._streams.get(id);
        if(!stream) this._streams.set(id, [this._randomTunnel(0), true, '', false]);
        else if(stream[0]) throw new Error('Attempted to open an already existing stream');
        this._send({id, name:'O', data});
    }
}