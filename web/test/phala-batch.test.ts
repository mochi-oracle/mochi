import {test,expect} from 'bun:test';
import {buildPhalaBatch} from '../../scripts/phala-batch.ts';
import {parseAbi,decodeFunctionData} from 'viem';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
const m=`0x${'12'.repeat(32)}` as `0x${string}`;
const identity=(n:number)=>({address:a(n),operator:a(100),measurement:m});
const deployment={contracts:{timelock:a(101),jurorRegistry:a(102),queryEscrow:a(103),receiptAnchor:a(104),panel:a(106)},privacy:{entrypoint:a(105)}};
const input={salt:m,intake:identity(1),consensus:identity(2),jurors:[0,0,1,1,2,2,3,4,4].map((cls,i)=>({...identity(i+3),class:cls})),attestor:a(110),feedRunner:a(111),orchestrator:a(112),indexer:a(113),postman:a(114)};
test('configuration cannot unpause; activation is a separate delayed operation',()=>{
 const setup=buildPhalaBatch(deployment,input,'schedule');const live=buildPhalaBatch(deployment,input,'schedule','activate');
 const signature=live.payloads[0];expect(setup.payloads).not.toContain(signature!);expect(live.callCount).toBe(1);expect(live.delaySeconds).toBe(86400);expect(setup.operationId).not.toBe(live.operationId);
 expect(decodeFunctionData({abi:parseAbi(['function unpause()']),data:signature!}).functionName).toBe('unpause');
});
test('rejects incomplete juries and duplicated enclave keys',()=>{
 expect(()=>buildPhalaBatch(deployment,{...input,jurors:input.jurors.slice(0,5)},'schedule')).toThrow('nine jurors');
 expect(()=>buildPhalaBatch(deployment,{...input,consensus:input.intake},'schedule')).toThrow('unique key');
});
test('mainnet batches always schedule one day; a testnet rehearsal uses its deployed delay',()=>{
 const schedule=parseAbi(['function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)']);
 const mainnet=buildPhalaBatch({...deployment,chainId:4663,timelockDelay:'86400'},input,'schedule');
 expect(mainnet.delaySeconds).toBe(86400);expect(decodeFunctionData({abi:schedule,data:mainnet.calldata}).args[5]).toBe(86400n);
 expect(()=>buildPhalaBatch({...deployment,chainId:4663,timelockDelay:'60'},input,'schedule')).toThrow('86400-second');
 const rehearsal=buildPhalaBatch({...deployment,chainId:46630,rehearsal:true,timelockDelay:'120'},input,'schedule');
 expect(rehearsal.delaySeconds).toBe(120);expect(decodeFunctionData({abi:schedule,data:rehearsal.calldata}).args[5]).toBe(120n);
 expect(()=>buildPhalaBatch({...deployment,chainId:46630,rehearsal:true,timelockDelay:'30'},input,'schedule')).toThrow('at least 60');
 expect(buildPhalaBatch({...deployment,chainId:46630,timelockDelay:'120'},input,'schedule').delaySeconds).toBe(86400);
});
