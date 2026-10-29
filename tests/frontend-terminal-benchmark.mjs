// Same real xterm parser and output, baseline packet writes vs negotiated ACK batching.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web=fileURLToPath(new URL('../omicslab/web/',import.meta.url));
const server=createServer(async(req,res)=>{
  if(req.url==='/'){
    res.setHeader('content-type','text/html');
    res.end('<!doctype html><link rel="stylesheet" href="/vendor/xterm/xterm.css"><div id="terminal"></div><script src="/vendor/xterm/xterm.js"></script>');return;
  }
  const path=resolve(web,'.'+new URL(req.url,'http://localhost').pathname);
  if(!path.startsWith(web.endsWith(sep)?web:web+sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('content-type',extname(path)==='.js'?'text/javascript':'text/css');res.end(await readFile(path));}
  catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({channel:process.env.UI_BROWSER_CHANNEL||'msedge',headless:true});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await page.evaluate(async()=>{
    const {TerminalOutputBuffer,terminalPolicy}=await import('/js/terminal-policy.js');
    const count=4096,text='Eve measured terminal output '.repeat(8)+'\r\n';
    async function measure(batched){
      const terminal=new Terminal({cols:100,rows:30,scrollback:100});
      terminal.open(document.querySelector('#terminal'));
      let writes=0,acknowledged=0,sent=0,peakUnits=0;
      const start=performance.now();
      await new Promise((resolve,reject)=>{
        if(!batched){
          for(let index=0;index<count;index++){
            writes++;
            terminal.write(text,index===count-1?resolve:undefined);
          }
          return;
        }
        const windowUnits=131072;
        const output=new TerminalOutputBuffer({policy:terminalPolicy,
          write:(data,done)=>{writes++;terminal.write(data,done);},
          acknowledge:seq=>{
            acknowledged=seq;
            if(acknowledged===count*text.length){output.dispose();resolve();}
            else feed();
          },onError:message=>reject(Error(message))});
        output.negotiate({protocol:'ack-v1',unit:'utf16',window:windowUnits,frame:text.length});
        function feed(){
          while(sent<count&&((sent+1)*text.length-acknowledged)<=windowUnits){
            sent++;output.enqueue(text,sent*text.length);
            peakUnits=Math.max(peakUnits,output.bufferedUnits);
          }
        }
        feed();
      });
      const elapsedMs=performance.now()-start;
      const tail=terminal.buffer.active.getLine(terminal.buffer.active.length-2)?.translateToString(true);
      terminal.dispose();
      document.querySelector('#terminal').replaceChildren();
      return {writes,elapsedMs,peakUnits,tail};
    }
    // Warm both paths before recording a same-page sample.
    await measure(false);await measure(true);
    return {packets:count,utf16Units:count*text.length,before:await measure(false),after:await measure(true)};
  });
  assert.equal(result.before.tail,result.after.tail);
  assert.ok(result.after.writes<result.before.writes);
  assert.ok(result.after.peakUnits<=131072);
  console.log(JSON.stringify({browser:await browser.version(),...result,
    scope:'Loopback real xterm parser; fixed packet fixture, includes coalescing delay; not SSH/network throughput'},null,2));
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
