#!/usr/bin/env node
// Live tclk swarm worker for technocore-did - 0 cost via GitHub Actions + OpenRouter minimax-m3:free
// Polls tclk-offers, auto-accepts x post Chinese jobs via Minimax, handles lock before reveal (tatthang fix)
import { makeAccept, generateHashLock, encodeFrame, dealRoom } from "@flop-labs/tclk";
import { signerFromSeed, canonicalMessage, nextNonce, sweep } from "@flop-labs/tclk-mcp/dist/signing.js";

const BASE = process.env.TECHNOCORE_URL || "https://technocore.chat";
const SEED_HEX = process.env.TECHNOCORE_SIGNING_KEY; // 64 hex from identity.pem
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

if (!SEED_HEX || !/^[0-9a-f]{64}$/i.test(SEED_HEX)) {
  console.error("TECHNOCORE_SIGNING_KEY missing or not 64 hex");
  process.exit(1);
}
const signer = signerFromSeed(Buffer.from(SEED_HEX, "hex"));
console.log(`worker DID: ${signer.did} venue: ${BASE}`);

async function req(url, init, what) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429) return r;
    const wait = Number(r.headers.get("retry-after")) || 5;
    console.log(`429 wait ${wait}s for ${what}`);
    await new Promise(res => setTimeout(res, wait * 1000));
  }
}
async function post(signer, room, frame) {
  const text = sweep(encodeFrame(frame));
  const nonce = nextNonce();
  const sig = signer.sign(canonicalMessage(room, nonce, text));
  const res = await req(`${BASE}/r/${room}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text }) }, `post ${room}`);
  if (!res.ok) throw new Error(`post ${room} ${res.status} ${await res.text()}`);
  return text;
}
async function readOffers(since) {
  const res = await req(`${BASE}/r/tclk-offers?format=json&limit=200&since=${since}`, undefined, "read tclk-offers");
  const j = await res.json();
  return j;
}

// Minimax via OpenRouter - language detected from job, not hardcoded
function detectLanguage(jobText) {
  const t = jobText.toLowerCase();
  if (t.includes("spanish") || t.includes("español")) return "Spanish";
  if (t.includes("yoruba")) return "Yoruba";
  if (t.includes("hausa")) return "Hausa";
  if (t.includes("chinese") || t.includes("中文")) return "Chinese";
  if (t.includes("french")) return "French";
  return "Spanish"; // default for your offers
}
async function minimaxChinese(jobText) {
  const lang = detectLanguage(jobText);
  if (!OPENROUTER_KEY) return lang==="Spanish" ? "FLOP es la red de agentes IA en Technocore con pagos tclk verificables." : "FLOP is Technocore agent network with verifiable tclk payments.";
  const prompt = `Job: ${jobText}\nWrite the deliverable in ${lang} <=100 characters, must contain "FLOP" and "Technocore". Output only ${lang}, no other language.`;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "minimax/minimax-m3:free", messages: [{ role: "user", content: prompt }], max_tokens: 200 })
  });
  if (!res.ok) throw new Error(`minimax ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content?.trim() || (lang==="Spanish" ? "FLOP es la red Technocore." : "FLOP is Technocore network.");
}

let lastSeen = 0;
// one poll cycle (GitHub Actions runs every 5m, so one cycle per invocation)
const board = await readOffers(lastSeen);
console.log(`tclk-offers last_seq ${board.last_seq} count ${board.messages.length}`);

// payer: keep one live Spanish offer from our DID (auto-post if none in window, hourly cadence)
const myOfferIds = new Set();
const myOffersById = new Map();
for (const m of board.messages) if (m.text.startsWith("tclk1 ")) try { const f=JSON.parse(m.text.slice(6)); if (f.type==="offer" && f.from===signer.did) { myOfferIds.add(f.id); myOffersById.set(f.id, f); } } catch {}
if (myOfferIds.size === 0) {
  console.log("no live offer from our DID in window, posting fresh Spanish offer");
  const taskId = `x-${Math.random().toString(16).slice(2,10)}`;
  const specNs = `tclk-job-${taskId.slice(-2)}`;
  const specKey = taskId.slice(0,14);
  const spec = "x post | explain FLOP network in English <=100 chars, checkable: contains FLOP and Technocore";
  await req(`${BASE}/kv/${specNs}/${specKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: spec }) }, "job spec");
  const now = Date.now();
  const { makeOffer } = await import("@flop-labs/tclk");
  const offer = makeOffer({ from: signer.did, role: "payer", lock: "hash", amount: "1000000", asset: "PAPER", rails: ["paper"], claimByMs: now+30*60*1000, refundAfterMs: now+60*60*1000, expiresMs: now+120*60*1000, job: { id: taskId, proto: "a2a", context: `/${specNs}/${specKey}` } });
  await post(signer, "tclk-offers", offer);
  console.log(`POSTED offer ${offer.id} task ${taskId}`);
}
// payer auto-lock: stranger accepted our offer -> write rail BEFORE lock (tatthang fix)
const { paperNote } = await import("@flop-labs/tclk");
for (const m of board.messages) if (m.text.startsWith("tclk1 ")) try {
  const f=JSON.parse(m.text.slice(6));
  if (f.type==="accept" && myOfferIds.has(f.offer_id || f.ref || f.offer)) {
    const contract = f.contract;
    const alreadyLock = board.messages.some(x=>{ try{ const g=JSON.parse(x.text.slice(6)); return g.type==="lock" && g.contract===contract; }catch{return false; }});
    if (alreadyLock) continue;
    const offer = myOffersById.get(f.offer_id || f.ref || f.offer);
    const statement = f.statement;
    const refundAfterMs = offer?.refundAfterMs || Date.now()+60*60*1000;
    const note = paperNote(contract);
    const railValue = `tclkpaper1 locked hash ${statement} ${refundAfterMs}`;
    const get = await req(`${BASE}/kv/${note.ns}/${note.key}`, undefined, `rail get ${note.ns}/${note.key}`);
    const existing = get.status===404 ? null : await get.text().then(t=>t.split("\n").filter(l=>!l.startsWith("!!")&&l.trim()).join(""));
    if (!existing || !existing.includes(statement)) {
      await req(`${BASE}/kv/${note.ns}/${note.key}/set/${encodeURIComponent(railValue)}`, undefined, `rail set ${note.ns}/${note.key}`);
      console.log(`rail record written ${note.ns}/${note.key} ${railValue.slice(0,60)}`);
    }
    const lockFrame = { type:"lock", from: signer.did, contract, rail:"paper", ref: contract };
    const deal = (await import("@flop-labs/tclk")).dealRoom(contract);
    try { await post(signer, deal, lockFrame); console.log(`LOCKED ${contract} in ${deal} ref ${contract}`); } catch(e){ console.log(`lock post failed (venue cap) ${e.message.slice(0,120)}`); }
  }
} catch {}
for (const m of board.messages) {
  if (!m.text.startsWith("tclk1 ")) continue;
  try {
    const f = JSON.parse(m.text.slice(6));
    if (f.type === "offer" && f.from !== signer.did) {
      const jobText = f.job?.context ? f.job.context : f.job?.id || "";
      // take any job with a job field (broad) to get interaction fast
      if (f.job) {
        console.log(`found offer ${f.id} from ${f.from} job ${f.job?.id}`);
        // skip if already accepted (check later msgs)
        const already = board.messages.some(x => x.text.includes(f.id) && x.text.includes('"type":"accept"'));
        if (already) { console.log("already accepted"); continue; }
        const chinese = await minimaxChinese(JSON.stringify(f.job));
        console.log(`minimax output: ${chinese.slice(0,80)}`);
        const lock = generateHashLock();
        const accept = makeAccept(f, { from: signer.did, statement: lock.hash });
        await post(signer, "tclk-offers", accept);
        console.log(`ACCEPTED ${f.id} -> contract ${accept.contract} hash ${lock.hash} preimage ${lock.preimage.slice(0,16)}...`);
        // Note: lock step needs rail record before lock - payer will lock after accept. As payee we wait for lock then reveal.
        // For offers where we are payer and stranger accepted us, we would lock here (not in this simple worker for brevity)
      }
    }
  } catch {}
}
console.log("poll done");
