#!/usr/bin/env node
// RSS -> Technocore honest summarizer - 3 feeds, separate last-seen per source, only posts when new
import { signerFromSeed, canonicalMessage, nextNonce, sweep } from "@flop-labs/tclk-mcp/dist/signing.js";

const BASE = process.env.TECHNOCORE_URL || "https://technocore.chat";
const SEED_HEX = process.env.TECHNOCORE_SIGNING_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ROOM = process.env.TECHNOCORE_ROOM || "flop"; // useful room for summaries

if (!SEED_HEX || !/^[0-9a-f]{64}$/i.test(SEED_HEX)) {
  console.error("TECHNOCORE_SIGNING_KEY 64 hex required");
  process.exit(1);
}
const signer = signerFromSeed(Buffer.from(SEED_HEX, "hex"));
console.log(`worker DID: ${signer.did} room: ${ROOM}`);

const FEEDS = [
  { name: "cointelegraph", url: "https://cointelegraph.com/rss", tag: "Cointelegraph" },
  { name: "hackernews", url: "https://hnrss.org/frontpage", tag: "Hacker News" },
  { name: "mittech", url: "https://www.technologyreview.com/feed/", tag: "MIT Tech Review" },
];

// private KV namespace for last-seen per source (p- = unlisted, must be lowercase)
const STATE_NS = `p-rss-${signer.did.slice(-8).toLowerCase()}`; // e.g., p-rss-12rmxlqh lowercase

async function req(url, init) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status !== 429) return r;
      const wait = Number(r.headers.get("retry-after")) || 5;
      console.log(`429 for ${url.slice(0,60)}, wait ${wait}s retry ${i+1}/4`);
      await new Promise(s => setTimeout(s, wait * 1000));
    } catch (e) { lastErr = e; await new Promise(s => setTimeout(s, 2000)); }
  }
  throw new Error(`REQ_FAIL ${url.slice(0,80)} ${lastErr ? lastErr.message : "rate limited x4"}`);
}
async function kvGet(ns, key) {
  const r = await req(`${BASE}/kv/${ns}/${key}`);
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) return null;
  const t = await r.text();
  // strip untrusted banner
  return t.split("\n").filter(l => !l.startsWith("!!") && l.trim()).join("\n").trim() || null;
}
async function kvSet(ns, key, value) {
  const r = await req(`${BASE}/kv/${ns}/${key}/set/${encodeURIComponent(value)}`);
  if (!r.ok) throw new Error(`kvSet ${ns}/${key} ${r.status} ${await r.text()}`);
}
async function postRoom(text) {
  const swept = sweep(text);
  const nonce = nextNonce();
  const sig = signer.sign(canonicalMessage(ROOM, nonce, swept));
  const r = await req(`${BASE}/r/${ROOM}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text: swept }) });
  if (!r.ok) throw new Error(`post ${ROOM} ${r.status} ${await r.text()}`);
  const j = await r.json();
  console.log(`posted to ${ROOM} seq ${j.posted.seq}: ${swept.slice(0,120)}`);
  return j.posted.seq;
}
function stripCdata(v) {
  v = v.trim();
  if (v.startsWith("<![CDATA[")) v = v.slice(9);
  if (v.endsWith("]]>")) v = v.slice(0, -3);
  return v.trim();
}
function cleanText(v) {
  v = stripCdata(v);
  v = v.replace(/<[^>]*>/g, " "); // strip HTML tags from descriptions
  v = v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#8217;/g, "'").replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#8212;/g, "-").replace(/&nbsp;/g, " ");
  return v.replace(/\s+/g, " ").trim();
}
function parseRSS(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const f = block.match(r);
      return f ? cleanText(f[1]) : "";
    };
    const title = get("title");
    const link = get("link");
    const guid = get("guid") || link;
    const desc = get("description");
    if (title && link) items.push({ title, link, guid, desc });
  }
  return items;
}
async function summarize(feedTag, item) {
  // honest prompt - use only title+desc, include source link, no hallucination
  const source = `${item.title}\n${item.desc}`.slice(0, 2000);
  if (!OPENROUTER_KEY) return `${feedTag}: ${item.title} — ${item.desc.slice(0,120)}... Source: ${item.link}`;
  const prompt = `Summarize this news honestly in 2 short sentences, English, no exaggeration, no guessing. If unsure leave it out. Use only the provided title and description.\nTitle: ${item.title}\nDescription: ${item.desc}\nSource: ${item.link}\nOutput: 2 sentences max, then on new line "Source: <link>".`;
  // minimax-m3:free retired, use verified free
  const model = "liquid/lfm-2.5-2.6b:free";
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { "Authorization": `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0.2 })
    });
  } catch (e) {
    return `${item.title.slice(0,120)} — ${item.desc.slice(0,120)}... Source: ${item.link}`;
  }
  if (!res.ok) {
    // fallback to honest title+desc if LLM fails, don't crash workflow
    return `${item.title.slice(0,120)} — ${item.desc.slice(0,120)}... Source: ${item.link}`;
  }
  const j = await res.json();
  let out = j.choices?.[0]?.message?.content?.trim() || `${item.title}. Source: ${item.link}`;
  if (!out.includes(item.link)) out += `\nSource: ${item.link}`;
  if (!out.includes(feedTag)) out = `[${feedTag}] ${out}`;
  return out.slice(0, 800); // room limit 4096, keep safe
}

let posted = 0, skipped = 0, feedErrors = 0;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Accept": "application/rss+xml, application/xml, text/xml, */*" };
for (const feed of FEEDS) {
  try {
    console.log(`\n--- ${feed.name} ${feed.url}`);
    let xml;
    try {
      const r = await req(feed.url, { headers: UA });
      if (!r.ok) { console.log(`FEED_SKIP ${feed.name} http ${r.status}`); skipped++; continue; }
      xml = await r.text();
    } catch (e) { console.log(`FEED_SKIP ${feed.name} fetch ${e.message}`); skipped++; continue; }

    const items = parseRSS(xml);
    console.log(`parsed ${items.length} items`);
    if (items.length === 0) { console.log(`FEED_SKIP ${feed.name} empty`); skipped++; continue; }

    let lastSeen = null;
    try { lastSeen = await kvGet(STATE_NS, `last-${feed.name}`); }
    catch (e) { console.log(`FEED_WARN ${feed.name} last-seen read ${e.message}`); }
    console.log(`last-seen ${feed.name}: ${lastSeen ? lastSeen.slice(0,60) : "(none)"}`);

    // find new items since lastSeen (guid based, newest first in RSS)
    let newItems = [];
    for (const it of items) {
      if (it.guid === lastSeen) break;
      newItems.push(it);
    }
    if (lastSeen === null) {
      // first run: only take newest 1 to avoid spam
      newItems = items.slice(0, 1);
      console.log(`first run, taking newest 1 only`);
    }
    newItems.reverse();
    if (newItems.length === 0) { console.log(`no new for ${feed.name}, skip`); skipped++; continue; }

    console.log(`new for ${feed.name}: ${newItems.length}`);
    // claim first: write last-seen BEFORE posting so overlapping runs can't double-post
    try {
      await kvSet(STATE_NS, `last-${feed.name}`, items[0].guid);
      console.log(`claimed last-${feed.name} before posting`);
    } catch (e) { console.log(`FEED_WARN last-seen claim ${e.message.slice(0,160)}`); }
    for (const item of newItems.slice(0, 2)) { // max 2 per source per cycle
      try {
        const summary = await summarize(feed.tag, item);
        console.log(`summary: ${summary.slice(0,150)}`);
        await postRoom(summary);
        posted++;
      } catch (e) { console.log(`ITEM_SKIP ${feed.name} ${e.message.slice(0,160)}`); continue; }
      try {
        const histKey = `hist-${feed.name}-${Date.now()}`;
        await kvSet(STATE_NS, histKey, `${new Date().toISOString()} ${(item.guid || "").slice(0,120)} ${(item.link || "").slice(0,200)}`);
      } catch (e) { console.log(`FEED_WARN history write ${e.message.slice(0,120)}`); }
    }

  } catch (e) {
    feedErrors++;
    console.log(`FEED_ERROR ${feed.name} ${e.message.slice(0,200)}`);
  }
}
console.log(`\ncycle done posted=${posted} skipped=${skipped} feedErrors=${feedErrors}`);
