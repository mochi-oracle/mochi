import {test, expect} from 'bun:test';
import {loadWebDeployment, validateWebDeployment} from '../deployment-config.ts';

const addr = '0x' + '11'.repeat(20), hash = '0x' + '22'.repeat(32);
const config = {enabled: true, chainId: 4663, contracts: {queryEscrow:addr,jurorRegistry:addr,verdicts:addr,usdg:addr,receiptAnchor:addr}, intakeAddress:addr, intakeMeasurement:hash, receiptPublicKey:hash, jurySizes:[3]};
const upstreams = {MOCHI_GATEWAY_URL:'https://gateway.example', MOCHI_INDEXER_URL:'https://indexer.example', RPC_URL:'https://rpc.example/private-provider-key'};

test('inline activation and rollback require no deployed config file', () => {
  const read = () => { throw new Error('must not read a file'); };
  expect(loadWebDeployment({}, read)).toEqual({enabled:false});
  const enabled = loadWebDeployment({...upstreams,MOCHI_WEB_CONFIG_JSON:JSON.stringify(config)},read);
  expect(enabled.enabled).toBe(true);
  expect(JSON.stringify(enabled)).not.toContain('private-provider-key');
  expect(loadWebDeployment({MOCHI_WEB_CONFIG_JSON:'{"enabled":false}'},read)).toEqual({enabled:false});
});
test('enabled mode rejects incomplete or wrong-network configuration', () => {
  for (const input of [{}, {enabled:true}, {...config,chainId:31337}, {...config,intakeMeasurement:'0x'+'00'.repeat(32)}, {...config,jurySizes:[1]}, {...config,jurySizes:[3,3]}, {...config,contracts:{...config.contracts,usdg:'0x123'}}]) {
    expect(() => validateWebDeployment(input)).toThrow('Invalid paid-review configuration');
  }
});
test('file remains supported but ambiguous or malformed input fails without leaking values', () => {
  expect(loadWebDeployment({...upstreams,MOCHI_WEB_CONFIG:'/protected/config'},()=>JSON.stringify(config)).enabled).toBe(true);
  expect(()=>loadWebDeployment({MOCHI_WEB_CONFIG:'a',MOCHI_WEB_CONFIG_JSON:'{}'})).toThrow('Set only one');
  expect(()=>loadWebDeployment({MOCHI_WEB_CONFIG_JSON:'SECRET-invalid-json'})).toThrow('Cannot load paid-review configuration JSON.');
});
test('enabled deployment requires all secure upstreams; disabled deployment needs none', () => {
  const credentialUrl = new URL('https://upstream.example');
  credentialUrl.username = 'test'; credentialUrl.password = 'test';
  for (const key of Object.keys(upstreams)) {
    for (const value of ['', 'http://upstream.example', credentialUrl.toString(), 'https://upstream.example/#fragment']) {
      expect(()=>loadWebDeployment({...upstreams,[key]:value,MOCHI_WEB_CONFIG_JSON:JSON.stringify(config)})).toThrow(key);
    }
  }
  expect(loadWebDeployment({MOCHI_WEB_CONFIG_JSON:'{"enabled":false}'}).enabled).toBe(false);
});
