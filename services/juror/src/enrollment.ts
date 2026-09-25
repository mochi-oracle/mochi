import { encodeAbiParameters, keccak256, type Address } from 'viem';
import type { TeeProvider } from '@mochi/tee';

/** Public proof of possession for one configured operator; never a caller-selected signing oracle. */
export async function enrollmentProof(tee: TeeProvider, chainId: number, registry: Address, operator: Address, jurorClass: number) {
  const key=tee.signer().address;
  const measurement=tee.measurement();
  const digest=keccak256(encodeAbiParameters(
    [{type:'string'},{type:'uint256'},{type:'address'},{type:'address'},{type:'address'},{type:'bytes32'},{type:'uint8'}],
    ['mochi.enroll.v1',BigInt(chainId),registry,operator,key,measurement,jurorClass],
  ));
  const signature=await tee.signer().signMessage({message:{raw:digest}});
  return {chainId,registry,operator,key,measurement,jurorClass,digest,signature};
}
