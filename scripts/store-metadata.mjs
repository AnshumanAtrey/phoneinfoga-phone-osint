#!/usr/bin/env node
/**
 * Push the Store listing metadata from this repo to Apify.
 *
 * `apify push` deploys code but never updates title, description, SEO fields,
 * categories, permissions or the example input on an existing Actor - so those
 * drift the moment anyone edits them in Console. This script makes GitHub the
 * source of truth for the LISTING too: it runs after every deploy in CI, reads
 *   .actor/actor.json  -> title, description, categories
 *   .actor/store.json  -> seoTitle, seoDescription, exampleRunInput,
 *                         actorPermissionLevel, (optional, first-time) pricing
 * validates them against the portfolio shipping rules, and PUTs only when
 * something differs from what is live.
 *
 * Pricing is special: Apify allows one pricing change per 30 days, so it is
 * applied ONLY when `pricing.apply` is true AND the Actor has no pricing yet.
 * After that first set, change pricing in Console; this script leaves it alone.
 *
 * Usage: APIFY_TOKEN=... node scripts/store-metadata.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';

const API = 'https://api.apify.com/v2';
const token = process.env.APIFY_TOKEN;
const dryRun = process.argv.includes('--dry-run');
if (!token) { console.error('APIFY_TOKEN is not set'); process.exit(1); }

// Apify's schema validation rejects unknown keys anywhere in the body, and one bad
// value rejects the whole PUT. Strip every "$comment" (at any depth) before sending.
const stripComments = (v) => (Array.isArray(v) ? v.map(stripComments)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.includes('$comment')).map(([k, x]) => [k, stripComments(x)]))
    : v);
const actor = stripComments(JSON.parse(readFileSync('.actor/actor.json', 'utf8')));
const store = stripComments(JSON.parse(readFileSync('.actor/store.json', 'utf8')));

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json.error || json).slice(0, 400)}`);
  return json.data;
}

/* ------------------------------------------------ portfolio shipping rules -- */
const LIMITS = { title: 63, description: 300, seoTitle: 60, seoDescription: 200 };
const BANNED_CHARS = /[—–]/;                       // em dash, en dash
const BANNED_WORDS = /\b(leverage|robust|seamlessly|effortlessly|cutting-edge|streamline|empower|unleash)\b/i;

const SLUG = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;
const desired = {
  // name is only managed when the actor is pinned by ID (store.actorId); then a new
  // name in actor.json renames the same actor instead of creating another one.
  name: store.actorId ? actor.name : undefined,
  title: actor.title,
  description: actor.description,
  categories: actor.categories || [],
  seoTitle: store.seoTitle,
  seoDescription: store.seoDescription,
  actorPermissionLevel: store.actorPermissionLevel,
  isPublic: store.isPublic,
  exampleRunInput: store.exampleRunInput
    ? { body: JSON.stringify(store.exampleRunInput), contentType: 'application/json; charset=utf-8' }
    : undefined,
  // Memory and timeout defaults are a pricing lever: the start event bills per GB
  // and the compute ceiling is memory x timeout. Not a pricing change, so no lock.
  defaultRunOptions: store.defaultRunOptions,
};

const problems = [];
for (const [k, max] of Object.entries(LIMITS)) {
  const v = desired[k];
  if (typeof v !== 'string' || !v.trim()) problems.push(`${k} is missing`);
  else if (v.length > max) problems.push(`${k} is ${v.length} chars, limit ${max}`);
}
for (const k of ['title', 'description', 'seoTitle', 'seoDescription']) {
  const v = desired[k] || '';
  if (BANNED_CHARS.test(v)) problems.push(`${k} contains an em/en dash - use "-" or "|"`);
  const w = v.match(BANNED_WORDS); if (w) problems.push(`${k} uses banned word "${w[0]}"`);
}
if (desired.name !== undefined && (!SLUG.test(desired.name) || desired.name.length < 3 || desired.name.length > 63)) problems.push(`name "${desired.name}" is not a valid slug (3-63 chars, letters, digits, hyphens)`);
if (desired.categories.length > 3) problems.push(`categories has ${desired.categories.length} entries, limit 3`);
// An event is priced flat (eventPriceUsd) or per discount tier (eventTieredPricingUsd: Store discounts).
const TIERS = ['FREE', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
const tierPrices = (ev) => TIERS.map((t) => (ev.eventTieredPricingUsd ? ev.eventTieredPricingUsd[t]?.tieredEventPriceUsd : ev.eventPriceUsd));
const showPrice = (ev) => (ev.eventTieredPricingUsd ? TIERS.map((t, i) => `${t}:$${tierPrices(ev)[i]}`).join('/') : `$${ev.eventPriceUsd}`);
if (store.pricing?.apply) {
  for (const [name, ev] of Object.entries(store.pricing.pricingInfos.at(-1).pricingPerEvent.actorChargeEvents)) {
    if (tierPrices(ev).some((p) => typeof p !== 'number')) problems.push(`pricing event ${name} needs a price for every tier (${TIERS.join(', ')})`);
  }
}
if (problems.length) { console.error('Listing rules violated:\n  - ' + problems.join('\n  - ')); process.exit(1); }

/* ------------------------------------------------------------ diff + apply -- */
const me = await api('GET', '/users/me');
const actorId = store.actorId || `${me.username}~${actor.name}`;
const live = await api('GET', `/acts/${actorId}`);

const changes = {};
for (const [k, v] of Object.entries(desired)) {
  if (v === undefined) continue;
  const liveV = k === 'exampleRunInput' ? live.exampleRunInput : live[k];
  // defaultRunOptions comes back with its keys in a different order; compare by key.
  const differs = k === 'defaultRunOptions'
    ? Object.entries(v).some(([kk, vv]) => liveV?.[kk] !== vv)
    : JSON.stringify(v) !== JSON.stringify(liveV);
  if (differs) changes[k] = v;
}

/* ------------------------------------------------------------------ pricing -- */
// Platform rules, learned the hard way (all enforced by the API):
//  - pricingInfos is append-only in time; records are never removed or edited;
//  - at most ONE future-dated record may exist at a time;
//  - increases, new paid events and model changes need 14 days' notice and are
//    limited to once a month; decreases take effect immediately.
// So the repo is the source of truth for the FIRST set and for DECREASES. An
// increase is never automated: it is announced to users, so a human does it.
if (store.pricing?.apply) {
  const livePricing = live.pricingInfos || [];
  const nowMs = Date.now();
  const desiredEvents = store.pricing.pricingInfos.at(-1).pricingPerEvent.actorChargeEvents;
  if (!livePricing.length) {
    const now = new Date().toISOString();
    changes.pricingInfos = store.pricing.pricingInfos.map((p) => ({ createdAt: now, startedAt: now, ...p }));
  } else {
    const future = livePricing.find((p) => new Date(p.startedAt).getTime() > nowMs);
    const current = [...livePricing].filter((p) => new Date(p.startedAt).getTime() <= nowMs).at(-1);
    const liveEvents = current?.pricingPerEvent?.actorChargeEvents || {};
    const lower = []; const higher = []; const added = [];
    for (const [name, ev] of Object.entries(desiredEvents)) {
      if (!(name in liveEvents)) { added.push(name); continue; }
      // Compared tier by tier, so flat -> tiered with no tier above the old price is a decrease.
      const want = tierPrices(ev); const have = tierPrices(liveEvents[name]);
      if (want.some((p, i) => p > have[i])) higher.push(name);
      else if (want.some((p, i) => p < have[i])) lower.push(name);
    }
    if (!lower.length && !higher.length && !added.length) console.log('pricing: live prices match the repo');
    else if (future) console.log(`pricing: a future record starts ${future.startedAt.slice(0, 19)}Z; the API allows only one, so nothing can be appended until then (will reconcile on the next run after it starts)`);
    else if (higher.length || added.length) console.log(`pricing: repo asks for an increase or a new paid event (${[...higher, ...added].join(', ')}); that needs 14 days' notice and is once a month, so it is not automated - do it in Console`);
    else {
      const now = new Date().toISOString();
      const rec = JSON.parse(JSON.stringify(current));
      for (const name of lower) {
        const ev = rec.pricingPerEvent.actorChargeEvents[name];
        const want = desiredEvents[name];
        delete ev.eventPriceUsd; delete ev.eventTieredPricingUsd;
        if (want.eventTieredPricingUsd) ev.eventTieredPricingUsd = want.eventTieredPricingUsd;
        else ev.eventPriceUsd = want.eventPriceUsd;
      }
      // The repo's reason is used only when it is new, so a stale one is never re-sent.
      const repoReason = store.pricing.pricingInfos.at(-1).reasonForChange;
      rec.createdAt = now; rec.startedAt = now;
      rec.reasonForChange = repoReason && repoReason !== current.reasonForChange ? repoReason : `Price decrease to match the repo: ${lower.join(', ')}`;
      changes.pricingInfos = [...livePricing, rec];
      console.log(`pricing: appending a decrease for ${lower.join(', ')} (effective immediately)`);
    }
  }
}

console.log(`actor: ${actorId} (${live.id}) | live title: "${live.title}"`);
if (!Object.keys(changes).length) { console.log('listing metadata already matches the repo - nothing to do'); process.exit(0); }
for (const [k, v] of Object.entries(changes)) {
  const show = (x) => (typeof x === 'string' ? `"${x}"` : JSON.stringify(x));
  console.log(`  ${k}: ${show(live[k])} -> ${show(v)}`);
}
if (dryRun) { console.log('dry run - no PUT sent'); process.exit(0); }

await api('PUT', `/acts/${actorId}`, changes);
const after = await api('GET', `/acts/${actorId}`);
if (changes.pricingInfos) {
  const ev = after.pricingInfos?.at(-1)?.pricingPerEvent?.actorChargeEvents || {};
  console.log(`pricing applied: ${Object.entries(ev).map(([k, v]) => `${k}=${showPrice(v)}`).join(', ') || 'NOT VISIBLE - check Console'}`);
}
// defaultRunOptions comes back with extra server-side keys; compare only what we sent.
const same = (k) => (k === 'defaultRunOptions'
  ? Object.entries(changes[k]).every(([kk, vv]) => after[k]?.[kk] === vv)
  : JSON.stringify(after[k]) === JSON.stringify(changes[k]));
const failed = Object.keys(changes).filter((k) => k !== 'pricingInfos' && !same(k));
if (failed.length) { console.error(`PUT accepted but these fields did not stick: ${failed.join(', ')}`); process.exit(1); }
console.log(`updated ${Object.keys(changes).length} field(s): ${Object.keys(changes).join(', ')}`);
console.log(`store: https://apify.com/${me.username}/${actor.name}`);
