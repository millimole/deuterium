// @ts-check
import { Duplex } from 'node:stream';
export class Multiplex extends Duplex{
    /** @param {import('node:stream').Readable} rx @param {import('node:stream').Writable} tx @param {string} id */
    constructor(rx, tx, id){
        super();
        let self = this;
        this.id = id; this.rx = rx; this.tx = tx;
        this.state = 'idle';
        // idle, open, txclose, rxclose, closed
        this.unbind = function unbind(){
            rx.off('close', unbind); tx.off('close', unbind);
            rx.off('data', processData);
            if(this.state !== 'closed') self.destroy(new Error((this == rx?'Readable':'Writable')+' closed'));
        };
        function processData(data){
            const buf = Buffer.from(data);
            const newline = buf.indexOf('\n');
            if(newline < 0) throw new Error('Protocol error: invalid packet recieved');
            const id = buf.subarray(0, newline).toString();
            console.debug('Recieved packet from stream', id);
            if(id === self.id) self.push(buf.subarray(newline+1));
            else if(id === ('BEGIN_'+id.toString())){ self.emit('begin', buf); this.status = 1;}
            else if(id === ('END_'+id.toString())) { self.closeSide('rx'); self.push(null);}
            else if(id === ('CLOSE_'+id.toString())) { self.closeSide(); self.destroy(); }
        }
        rx.on('close', this.unbind); tx.on('close', this.unbind);
        rx.on('data', processData);

    }
    _destroy(err, cb){
        if(this.state !== 'txclose' && this.state !== 'closed') // tell them to close
            try{
                if(!err) this.tx.write('CLOSE_'+this.id+'\n');
                else this.tx.write('ERR_'+this.id+'\n'+err?.toString?.());
            } catch(e){ /*Do nothing*/ }
        this.closeSide();
        this.unbind();
        cb();
    }
    _read(){}
    _write(chunk, enc, cb){ this.tx.write(Buffer.concat([Buffer.from(`${this.id}\n`), Buffer.from(chunk, enc)]), cb); }
    _final(cb){ this.tx.write(Buffer.from(`END_${this.id}\n`), cb); this.closeSide('tx'); }
    closeSide(side){
        if(side == 'tx'){
            if(this.state == 'rxclosed') this.state = 'closed';
            else if(this.state == 'open') this.state = 'txclosed';
        }else if(side=='rx'){
            if(this.state == 'txclosed') this.state = 'closed';
            else if(this.state == 'open') this.state = 'rxclosed';
        } else this.state = 'closed';
    }
}