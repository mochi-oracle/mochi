import { runRevenueWorkerManifest } from '../services/claims/src/revenue-worker-runtime.ts';

const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));
if(import.meta.main){
  const [manifest,...args]=process.argv.slice(2);
  if(!manifest||args.length>4){console.error('Usage: bun scripts/revenue-worker.ts MANIFEST.json [--watch-seconds N --cycles N]');process.exitCode=2;}
  else try{
    let interval=0,cycles=1;
    if(args.length){if(args.length!==4||args[0]!=='--watch-seconds'||args[2]!=='--cycles'||!/^\d+$/u.test(args[1]!)||!/^\d+$/u.test(args[3]!))throw new Error('invalid bounded watch arguments');interval=Number(args[1]);cycles=Number(args[3]);if(interval<60||cycles<1||cycles>1000)throw new Error('watch interval must be >=60 seconds and cycles 1..1000');}
    for(let i=0;i<cycles;i++){
      const result=await runRevenueWorkerManifest(manifest);
      console.log(JSON.stringify(result,(_k,v)=>typeof v==='bigint'?v.toString():v,2));
      if('cycle' in result&&result.cycle?.report.status!=='complete')process.exitCode=1;
      if(i+1<cycles)await sleep(interval*1000);
    }
  }catch{console.error('Revenue worker cycle failed; check private config, approved route, finalized RPC data, and local accounting state. Error details and secrets are not printed.');process.exitCode=1;}
}
