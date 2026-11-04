/**
 * LIVE end-to-end run: Torrent-api (HTTP) -> Soroban RPC -> deployed torrent-escrow -> Torrent-indexer -> back into the API.
 * Needs the indexer (port 4002) and the API (port 4001) running with the contract id set, and the Testnet identities
 * created by Torrent-contracts/scripts/smoke-testnet.sh (stellar-cli aliases). Testnet and synthetic data only.
 *
 *   node --env-file=.env --import tsx scripts/testnet-e2e.ts
 *
 * Secrets: the secret seeds are read in memory through `stellar keys show` and never printed, logged or written. The
 * evidence file (../Torrent-contracts/deployments/testnet-api-e2e.json) holds public ids and hashes only.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Account, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc, Address } from '@stellar/stellar-sdk';

const API = process.env.API_URL ?? 'http://127.0.0.1:4001';
const RPC = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const CONTRACT = process.env.TORRENT_ESCROW_CONTRACT_ID!;
const OUT = process.env.E2E_OUT ?? '../Torrent-contracts/deployments/testnet-api-e2e.json';
const server = new rpc.Server(RPC);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const steps: { name: string; ok: boolean; txHash?: string; detail?: string }[] = [];
const note = (name: string, ok: boolean, txHash?: string, detail?: string): void => {
  steps.push({ name, ok, ...(txHash ? { txHash } : {}), ...(detail ? { detail } : {}) });
  writeFileSync(OUT, JSON.stringify({ network: 'testnet', contract: CONTRACT, steps }, null, 2) + '\n');
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${txHash ? ' ' + txHash : ''}${detail ? ` (${detail})` : ''}`);
};
function need(cond: unknown, msg: string, ctx?: unknown): asserts cond {
  if (!cond) throw new Error(`E2E FAILED: ${msg}${ctx !== undefined ? '\n' + JSON.stringify(ctx, null, 2).slice(0, 1500) : ''}`);
}

function secretOf(alias: string): Keypair {
  const r = spawnSync('stellar', ['keys', 'show', alias], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`no stellar-cli key named ${alias}`);
  return Keypair.fromSecret(r.stdout.trim());
}
function cli(args: string[]): string {
  const r = spawnSync('stellar', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`stellar ${args.slice(0, 3).join(' ')} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}
async function call(method: string, path: string, o: { token?: string; body?: unknown; key?: string } = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { 'idempotency-key': o.key } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Json };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function login(kp: Keypair): Promise<string> {
  const ch = await call('POST', '/v1/auth/challenge', { body: { address: kp.publicKey() } });
  need(ch.status === 200 || ch.status === 201, 'auth challenge', ch.json);
  const signature = Buffer.from(kp.signMessage(ch.json.message as string)).toString('base64');
  const l = await call('POST', '/v1/auth/login', { body: { challengeId: ch.json.challengeId, signature } });
  need(l.status === 200 && l.json.token, 'auth login', l.json);
  return l.json.token as string;
}

type Arg = { name: string; type: 'u64' | 'i128' | 'address' | 'bytes32'; value: string };
const scVal = (a: Arg) =>
  a.type === 'u64' ? nativeToScVal(BigInt(a.value), { type: 'u64' })
  : a.type === 'i128' ? nativeToScVal(BigInt(a.value), { type: 'i128' })
  : a.type === 'address' ? new Address(a.value).toScVal()
  : nativeToScVal(Buffer.from(a.value, 'hex'), { type: 'bytes' });

/** What a real wallet does with an unsigned intent: build the invocation, let the network fill footprint, fee and auth, sign. */
async function signIntent(d: Json, kp: Keypair): Promise<string> {
  const acct = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(new Account(kp.publicKey(), acct.sequenceNumber()), { fee: '1000000', networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(d.contractId).call(d.function, ...(d.args as Arg[]).map(scVal)))
    .setTimeout(300)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  return prepared.toXDR();
}

async function main(): Promise<void> {
  need(CONTRACT, 'TORRENT_ESCROW_CONTRACT_ID is required');
  const organizer = secretOf('torrent-controller');
  const token = cli(['contract', 'id', 'asset', '--asset', 'native', '--network', 'testnet']);
  const otoken = await login(organizer);
  note('organizer logs in by signing the wallet challenge (SEP-53)', true);

  const ruleSet = { tokenContractId: token, maxMembers: 4, rounds: 2, roundLengthDays: 7, contributionAmount: String(1_000_000 + (Date.now() % 1_000_000)), transferPolicy: 'MEMBERS_ONLY' }; // unique per run so the policy hash binds exactly one pool
  const c = await call('POST', '/v1/circles', { token: otoken, body: { name: `API live run ${new Date().toISOString()}`, ruleSet } });
  need(c.status === 201 || c.status === 200, 'create circle', c.json);
  const circle = c.json as Json;
  note('circle created (off-chain agreement + policy hash)', true, undefined, `policyHash ${circle.policyHash}`);

  // The API has no create_pool signing request yet (Phase 4 item); the organizer creates the pool with stellar-cli, bound by policy hash.
  const poolId = cli(['contract', 'invoke', '--id', CONTRACT, '--source-account', 'torrent-controller', '--network', 'testnet', '--', 'create_pool', '--controller', organizer.publicKey(), '--token', token, '--membership_policy_hash', circle.policyHash]).replace(/"/g, '');
  note('organizer creates the on-chain pool with the circle policy hash (stellar-cli)', true, undefined, `pool ${poolId}`);

  let bound = '';
  for (let i = 0; i < 40 && !bound; i++) {
    await sleep(5000);
    const g = await call('GET', `/v1/circles/${circle.id}`, { token: otoken });
    bound = g.json.poolId ?? '';
  }
  need(bound === poolId, 'circle is bound to the pool the indexer saw', { bound, poolId });
  note('API binds the circle to the pool from indexed pool_created (by policy hash)', true, undefined, `poolId ${bound}`);

  const f = await call('POST', `/v1/circles/${circle.id}/funding-intents`, { token: otoken, key: `live-fund-${Date.now()}`, body: { amount: '2500000' } });
  need(f.status === 201 || f.status === 200, 'create funding intent', f.json);
  const intent = f.json.intent ?? f.json;
  need(intent.state === 'AWAITING_SIGNATURE', 'intent awaits a signature', intent);
  const signedXdr = await signIntent(intent.descriptor, organizer);
  const s = await call('POST', `/v1/intents/${intent.id}/submit`, { token: otoken, body: { signedXdr } });
  need(s.status < 300, 'submit signed intent', s.json);
  const sub = s.json.intent ?? s.json;
  note('deposit intent signed with a real prepared Soroban tx and submitted through the API', true, sub.txHash, `state ${sub.state}`);

  let cur = sub;
  for (let i = 0; i < 40 && cur.state !== 'CONFIRMED' && cur.state !== 'FAILED'; i++) {
    await sleep(5000);
    const g = (await call('GET', `/v1/intents/${intent.id}`, { token: otoken })).json;
    cur = (g.intent ?? g) as Json;
  }
  need(cur.state === 'CONFIRMED', 'intent confirmed only after the indexer shows the event for this tx', cur);
  note('intent CONFIRMED after the indexer ingested the funded event for that tx hash', true, cur.txHash);

  const cov = await call('GET', `/v1/circles/${circle.id}/coverage`, { token: otoken });
  need(cov.json.bound === true && String(cov.json.totals?.funded) === '2500000', 'coverage shows the deposit', cov.json);
  note('coverage endpoint shows funded 2500000 (ledger-derived)', true);
}

/** Second flow: everything the organizer does goes through the API's own signing requests (create pool, issue right, close pool). */
async function organizerFlow(): Promise<void> {
  const organizer = secretOf('torrent-controller');
  const member = secretOf('torrent-alice');
  const token = cli(['contract', 'id', 'asset', '--asset', 'native', '--network', 'testnet']);
  const otoken = await login(organizer);
  const ruleSet = { tokenContractId: token, maxMembers: 4, rounds: 2, roundLengthDays: 7, contributionAmount: String(2_000_000 + (Date.now() % 1_000_000)), transferPolicy: 'MEMBERS_ONLY' };
  const c = await call('POST', '/v1/circles', { token: otoken, body: { name: `Organizer intents ${new Date().toISOString()}`, ruleSet } });
  need(c.status < 300, 'create circle (organizer flow)', c.json);
  const circle = c.json as Json;

  const run = async (label: string, path: string, body: unknown): Promise<Json> => {
    const r = await call('POST', path, { token: otoken, key: `live-${label}-${Date.now()}`, body });
    need(r.status === 201, `${label}: signing request created`, r.json);
    const intent = (r.json.intent ?? r.json) as Json;
    const signed = await signIntent(intent.descriptor, organizer);
    const s = await call('POST', `/v1/intents/${intent.id}/submit`, { token: otoken, body: { signedXdr: signed } });
    need(s.status < 300, `${label}: submit`, s.json);
    let cur = (s.json.intent ?? s.json) as Json;
    const txHash = cur.txHash as string;
    for (let i = 0; i < 40 && cur.state !== 'CONFIRMED' && cur.state !== 'FAILED'; i++) {
      await sleep(5000);
      const g = (await call('GET', `/v1/intents/${intent.id}`, { token: otoken })).json;
      cur = (g.intent ?? g) as Json;
    }
    need(cur.state === 'CONFIRMED', `${label}: confirmed by the indexed event`, cur);
    note(`${label}: API signing request -> real prepared tx -> CONFIRMED by the indexed event`, true, txHash);
    return cur;
  };

  await run('create_pool', `/v1/circles/${circle.id}/pool-intent`, {});
  let poolId = '';
  for (let i = 0; i < 20 && !poolId; i++) { poolId = ((await call('GET', `/v1/circles/${circle.id}`, { token: otoken })).json.poolId as string) ?? ''; if (!poolId) await sleep(3000); }
  need(poolId, 'circle bound to the pool created through the API');
  note('circle bound to the pool created through the API', true, undefined, `poolId ${poolId}`);

  cli(['contract', 'invoke', '--id', CONTRACT, '--source-account', 'torrent-controller', '--network', 'testnet', '--', 'allow_member', '--pool_id', poolId, '--member', member.publicKey()]);
  cli(['contract', 'invoke', '--id', CONTRACT, '--source-account', 'torrent-alice', '--network', 'testnet', '--', 'join_pool', '--pool_id', poolId, '--member', member.publicKey(), '--signed_policy_hash', circle.policyHash]);
  note('member allowed and joined on-chain (stellar-cli; the API has no join request)', true);
  await sleep(10000);

  await run('deposit', `/v1/circles/${circle.id}/funding-intents`, { amount: '3000000' });
  const early = await call('POST', `/v1/circles/${circle.id}/rights-intent`, { token: otoken, key: `live-unbacked-${Date.now()}`, body: { owner: member.publicKey(), amount: '3000001', maturity: Math.floor(Date.now() / 1000) + 3600 } });
  need(early.status === 422 && early.json.error?.code === 'INSUFFICIENT_BACKING', 'an unbacked right is refused before anyone signs', early.json);
  note('unbacked issue_right is refused by the API before signing (INSUFFICIENT_BACKING)', true);
  await run('issue_right', `/v1/circles/${circle.id}/rights-intent`, { owner: member.publicKey(), amount: '2000000', maturity: Math.floor(Date.now() / 1000) + 3600 });
  await run('close_pool', `/v1/circles/${circle.id}/close-intent`, {});
  const cov = await call('GET', `/v1/circles/${circle.id}/coverage`, { token: otoken });
  note('coverage after the organizer flow', cov.json.bound === true, undefined, JSON.stringify(cov.json.totals));
}

const flow = process.argv[2] === 'organizer' ? organizerFlow : main;
flow().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  note('RUN ABORTED', false, undefined, e instanceof Error ? e.message.split('\n')[0] : String(e));
  process.exit(1);
});
