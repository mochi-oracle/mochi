import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadDeployment, chainFor, PanelEscalationAbi, QueryEscrowAbi } from "@mochi/chain";
import { assertPublicPayload, bindKey, commitment, evaluatorSalt, generateEvaluatorKey, materialsFailureAdvice, payloadSig } from "../src/evaluator.ts";

const args = process.argv.slice(2);
const command = args[0];
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const required = (name: string) => { const v = option(name); if (!v) throw new Error(`missing --${name}`); return v; };
const rpcUrl = process.env.RPC_URL;
const evaluatorKey = process.env.EVALUATOR_KEY as Hex | undefined;
const baseUrl = (process.env.PANEL_DESK_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const deploymentPath = process.env.MOCHI_DEPLOYMENT;
const loadClients = () => {
  if (!rpcUrl || !evaluatorKey) throw new Error("RPC_URL and EVALUATOR_KEY are required");
  const dep = loadDeployment(deploymentPath);
  const chain = chainFor({ ...dep, rpcUrl });
  const account = privateKeyToAccount(evaluatorKey);
  const transport = http(rpcUrl);
  return { dep, account, publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ chain, transport, account }) };
};
const writePanel = async (functionName: string, callArgs: readonly unknown[]) => {
  const { dep, account, publicClient, walletClient } = loadClients();
  const { request } = await publicClient.simulateContract({ account, address: dep.contracts.panel, abi: PanelEscalationAbi, functionName: functionName as never, args: callArgs as never });
  const hash = await walletClient.writeContract(request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error("transaction reverted");
  return hash;
};

if (command === "stake") {
  const amount = BigInt(required("amount"));
  const { dep, account, publicClient, walletClient } = loadClients();
  const erc20 = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
  const { request } = await publicClient.simulateContract({ account, address: dep.contracts.usdg, abi: erc20, functionName: "approve", args: [dep.contracts.panel, amount] });
  const hash = await walletClient.writeContract(request as never);
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  console.log(await writePanel("stake", [amount]));
} else if (command === "materials") {
  const { account } = loadClients();
  const caseId = required("case-id") as Hex;
  const panelIndex = Number(required("panel-index"));
  const generated = generateEvaluatorKey();
  const queryId = caseId;
  const keySig = await bindKey(account, queryId, panelIndex, generated.pubKey);
  const caseResponse = await fetch(`${baseUrl}/v1/panel/${caseId}`, { signal: AbortSignal.timeout(15_000) });
  if (!caseResponse.ok) throw new Error("panel case lookup failed");
  const current = await caseResponse.json() as { panelIndex: number };
  if (current.panelIndex !== panelIndex) throw new Error("panel index is no longer current");
  const response = await fetch(`${baseUrl}/v1/panel/${caseId}/materials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: account.address.toLowerCase(), encryptionPubKey: generated.pubKey, keySig }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const code = ((await response.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;
    // Materials that can never be served: tell the evaluator to abstain and print the command.
    const advice = materialsFailureAdvice(code, caseId);
    if (advice) { console.error(advice); process.exit(2); }
    throw new Error(`materials request failed: ${code ?? response.status}`);
  }
  console.log(JSON.stringify({ ...(await response.json()), evaluatorPrivateKey: generated.privKey }, null, 2));
} else if (command === "commit") {
  const caseId = required("case-id") as Hex;
  const panelIndex = Number(required("panel-index"));
  const answerHash = required("answer-hash") as Hex;
  const payloadHash = required("payload-hash") as Hex;
  const salt = (option("salt") ?? evaluatorSalt()) as Hex;
  const { account } = loadClients();
  const value = commitment(caseId, panelIndex, account.address, answerHash, payloadHash, salt);
  console.log(JSON.stringify({ commitment: value, salt }));
  console.log(await writePanel("commit", [caseId, value]));
} else if (command === "abstain") {
  // Instead of committing, before the commit deadline, when the case cannot be evaluated (MATERIALS_UNAVAILABLE).
  const caseId = required("case-id") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(caseId)) throw new Error("invalid --case-id");
  console.log(await writePanel("abstain", [caseId]));
} else if (command === "claim") {
  // Only needed when a payout transfer to this evaluator failed and was kept as an owed balance.
  console.log(await writePanel("claim", []));
} else if (command === "reveal") {
  console.log(await writePanel("reveal", [required("case-id"), required("answer-hash"), required("payload-hash"), required("salt")]));
} else if (command === "submit-payload") {
  const { account, dep, publicClient } = loadClients();
  const caseId = required("case-id") as Hex;
  // A private query's payload carries private field values: it must never leave this machine. (caseId = queryId)
  const query = await publicClient.readContract({ address: dep.contracts.queryEscrow, abi: QueryEscrowAbi, functionName: "getQuery", args: [caseId] }) as { isPublic: boolean };
  assertPublicPayload(query.isPublic);
  const panelIndex = Number(required("panel-index")) as 0 | 1;
  const payload = required("payload") as Hex;
  const answerJson = await Bun.file(required("answer-json")).text();
  const response = await fetch(`${baseUrl}/v1/panel/${caseId}/payload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluator: account.address.toLowerCase(), panelIndex, payload, answerJson, sig: await payloadSig(account, caseId, panelIndex, payload) }), signal: AbortSignal.timeout(15_000) });
  // The desk keeps a payload only after this evaluator's on-chain reveal, and only the revealed one.
  if (!response.ok) throw new Error(`payload submission failed: ${((await response.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code ?? response.status}`);
  console.log(await response.text());
} else {
  throw new Error("usage: evaluator <stake|materials|commit|abstain|reveal|submit-payload|claim> [--flags]");
}
