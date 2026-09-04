import { describe, expect, test } from "bun:test";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { generateNote, parseNote, serializeNote, precommitment, commitment, nullifierHash, SNARK_FIELD, StateTreeSync, AspTree, context, openShieldedPaymentFor } from "../src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Address, Hex } from "viem";

describe("vendored Privacy Pools formulas", () => {
  test("Poseidon helpers match the actual commitment circuit witness outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(),"mochi-privacy-"));
    try {
      const snarkjs = await import("snarkjs") as any;
      const wasm = new URL("../../../contracts/vendor/privacy-pools-core/packages/circuits/build/commitment/commitment_js/commitment.wasm", import.meta.url).pathname;
      const witnessPath = join(dir,"fixed.wtns");
      const input = { value:"7", label:"8", nullifier:"9", secret:"10" };
      await snarkjs.wtns.calculate(input,wasm,witnessPath);
      const witness = await snarkjs.wtns.exportJson(witnessPath) as bigint[];
      expect(witness[1]).toBe(commitment(7n,8n,precommitment(9n,10n)));
      expect(witness[2]).toBe(nullifierHash(9n));
      expect(precommitment(9n,10n)).toBe(poseidon2([9n,10n]));
      expect(commitment(7n,8n,precommitment(9n,10n))).toBe(poseidon3([7n,8n,poseidon2([9n,10n])]));
      expect(nullifierHash(9n)).toBe(poseidon1([9n]));
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  test("notes roundtrip without converting field scalars to numbers", () => {
    const note=generateNote(); expect(note.nullifier).toBeLessThan(SNARK_FIELD); expect(note.secret).toBeLessThan(SNARK_FIELD); expect(parseNote(serializeNote(note))).toEqual(note);
  });
  test("state and ASP LeanIMTs share Poseidon(2); change leaves append in sequence", () => {
    const state=new StateTreeSync(); state.tree.insert(11n); state.tree.insert(12n); state.assertRoot(state.tree.root); const asp=new AspTree(); asp.add(4n); asp.add(4n); asp.add(5n); asp.assertRoot(asp.tree.root); expect(state.tree.size).toBe(2); expect(asp.tree.size).toBe(2);
  });
  test("withdrawal context and escrow binding include exact ABI values", () => {
    const address="0x0000000000000000000000000000000000000001" as Address;
    const w={processooor:address,data:"0x1234" as const}; expect(context(w,123n)).toBeGreaterThanOrEqual(0n);
    const p={pA:[1n,2n],pB:[[3n,4n],[5n,6n]],pC:[7n,8n],pubSignals:[0n,9n,10n,11n,12n,13n,14n,15n]};
    const encoded=openShieldedPaymentFor(address,"0x0000000000000000000000000000000000000002" as Address,(`0x${"ab".repeat(32)}` as Hex),p);
    expect(encoded.nullifier).toBe(`0x${9n.toString(16).padStart(64,"0")}`); expect(encoded.withdrawal.processooor).toBe(address);
  });
});

let LOOPBACK_TEST_PORT=0;
const LOOPBACK_BIND_ALLOWED = await new Promise<boolean>((resolve) => {
  const probe=createServer(); probe.once("error",()=>resolve(false)); probe.listen(0,"127.0.0.1",()=>{ LOOPBACK_TEST_PORT=(probe.address() as {port:number}).port; probe.close(()=>resolve(true)); });
});
test.skipIf(!LOOPBACK_BIND_ALLOWED)("anvil privacy-pools deployment and link smoke", async () => {
  const root=new URL("../../../",import.meta.url).pathname; const out=join(await mkdtemp(join(tmpdir(),"mochi-anvil-")),"local.json");
  const port=LOOPBACK_TEST_PORT; const anvil=Bun.spawn(["anvil","--host","127.0.0.1","--hardfork","prague","--port",String(port)],{cwd:root,stdout:"ignore",stderr:"ignore"});
  try {
    let ready=false; for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]})});if(r.ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
    if(!ready) throw new Error("anvil did not become ready on loopback");
    const deploy=Bun.spawn(["bun","scripts/deploy-local.ts","--rpc",`http://127.0.0.1:${port}`,"--out",out,"--shielded","privacy-pools"],{cwd:root,stdout:"pipe",stderr:"pipe"});
    // Drain both pipes while the child runs. Linux pipes fill much sooner than macOS pipes;
    // waiting for exit first deadlocks a successful deployment once its progress output fills stdout.
    const [code, stdout, stderr] = await Promise.all([
      deploy.exited, new Response(deploy.stdout).text(), new Response(deploy.stderr).text(),
    ]);
    if(code!==0) throw new Error(`privacy deployment failed (${code}): ${stdout.slice(-1200)} ${stderr.slice(-1200)}`);
    const deployed=JSON.parse(await Bun.file(out).text()); expect(deployed.privacy.adapter).toMatch(/^0x[0-9a-fA-F]{40}$/); expect(BigInt(deployed.privacy.scope)).toBeGreaterThan(0n);
  } finally { anvil.kill(); }
}, 180_000);
if(!LOOPBACK_BIND_ALLOWED) console.log("ANVIL E2E SKIPPED: sandbox denied binding 127.0.0.1 during the loopback probe.");
