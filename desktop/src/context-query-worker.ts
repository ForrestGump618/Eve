import { parentPort, workerData } from 'node:worker_threads';
import { ContextManager, type ContextOptions, type SourceRef } from './context.js';

if (parentPort) {
  try {
    const {options,operation,source,query={}} = workerData as {options:ContextOptions;operation:string;source?:SourceRef;query?:{sequence?:number;offset?:number;limit?:number;text?:string}};
    const manager = new ContextManager(options);
    if (operation === 'source') {
      if (!source) throw new Error('Missing source');
      parentPort.postMessage({ok:true,value:manager.readSource(source)});
    } else if(operation==='requests'){
      parentPort.postMessage({ok:true,value:manager.inspectRequests(query.offset,query.limit)});
    } else if(operation==='request'){
      parentPort.postMessage({ok:true,value:manager.requestPage(Number(query.sequence),query.offset,query.limit)});
    } else if(operation==='search'){
      parentPort.postMessage({ok:true,value:manager.search(query.text||'',query.limit)});
    } else {
      const history = manager.history();
      const replay = manager.replay();
      const composition:Record<string,number> = {};
      for (const message of replay?.messages ?? []) composition[message.role]=(composition[message.role]??0)+Buffer.byteLength(message.content,'utf8');
      composition.tools=Buffer.byteLength(JSON.stringify(replay?.tools??[]),'utf8');
      const requests=manager.inspectRequests() as {total:number};
      parentPort.postMessage({ok:true,value:{
        model:options.model,contextWindow:options.contextWindow,outputTokens:options.outputTokens,
        estimated:true,compositionAccounting:'utf8-bytes-upper-bound',composition,messageCount:replay?.messages.length??0,
        requests,retainedRequests:requests.total,
        snapshots:history.slice(-20),historyCount:history.length,
      }});
    }
  } catch {
    parentPort.postMessage({ok:false});
  } finally { parentPort.close(); }
}
