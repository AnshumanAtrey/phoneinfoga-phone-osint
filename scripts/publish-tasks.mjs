#!/usr/bin/env node
/**
 * Publish this Actor's example tasks from .actor/tasks.json. Runs in CI after the deploy and the
 * listing sync (deploys and Apify API writes happen only in CI, owner rule).
 *
 * Each task becomes a public landing page on the Store with its own Google-indexed page and .md
 * (https://docs.apify.com/actors/publishing/publish-task.md). API used (verified 2026-10-01):
 *   POST /v2/actor-tasks                   create {actId, name, title, description, input, options, publicConfig}
 *   PUT  /v2/actor-tasks/:id               update the same fields; {isPublic: true} publishes
 * publicConfig = {seoTitle <= 60, seoDescription <= 160, inputSchemaFields, datasetView}. Publishing needs a
 * public Actor, both inputSchemaFields and datasetView, and at most 10 published tasks per Actor. A page stays
 * up only while publicConfig validates against the current build, so the checks below refuse a field or view
 * this build does not have.
 *
 * Tasks are matched by name: missing ones are created, existing ones updated, unpublished ones published.
 * Nothing is ever deleted; tasks of this Actor that are not in the file are listed and left alone.
 *
 * Usage: APIFY_TOKEN=... node scripts/publish-tasks.mjs [--dry-run]
 */
import { existsSync, readFileSync } from 'node:fs';

const API = 'https://api.apify.com/v2';
const LIMITS = { title: 63, description: 400, seoTitle: 60, seoDescription: 160 };
const dryRun = process.argv.includes('--dry-run');
const token = process.env.APIFY_TOKEN;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

if (!existsSync('.actor/tasks.json')) { console.log('no .actor/tasks.json: nothing to publish'); process.exit(0); }
const spec = read('.actor/tasks.json');
const store = read('.actor/store.json');
const fields = new Set(Object.keys(read('.actor/INPUT_SCHEMA.json').properties || {}));
// The dataset schema sits inline in actor.json or in its own file, a path relative to .actor/.
const dataset = read('.actor/actor.json').storages?.dataset;
const views = new Set(Object.keys((typeof dataset === 'string' ? read(`.actor/${dataset}`) : dataset)?.views || {}));

/* ---------------------------------------------------------------- checks -- */
const errors = [];
if (spec.tasks.length > 10) errors.push(`${spec.tasks.length} tasks; an Actor can publish 10`);
const names = new Set();
for (const t of spec.tasks) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(t.name || '')) errors.push(`task name "${t.name}": lowercase letters, digits and hyphens, 3-63`);
  if (names.has(t.name)) errors.push(`task name "${t.name}" is used twice`);
  names.add(t.name);
  for (const [key, max] of Object.entries(LIMITS)) {
    if (!t[key]) errors.push(`${t.name}: ${key} missing`);
    else if (t[key].length > max) errors.push(`${t.name}: ${key} is ${t[key].length} chars, max ${max}`);
  }
  for (const f of t.inputSchemaFields || []) if (!fields.has(f)) errors.push(`${t.name}: inputSchemaFields "${f}" is not in the input schema`);
  for (const f of Object.keys(t.input || {})) if (!fields.has(f)) errors.push(`${t.name}: input key "${f}" is not in the input schema`);
  if (!(t.inputSchemaFields || []).length) errors.push(`${t.name}: inputSchemaFields is empty (needed to publish)`);
  if (!views.has(t.datasetView)) errors.push(`${t.name}: datasetView "${t.datasetView}" is not a dataset view (${[...views].join(', ')})`);
}
if (errors.length) { errors.forEach((e) => console.error(`ERROR ${e}`)); process.exit(1); }
console.log(`${spec.tasks.length} tasks pass the checks`);
if (dryRun) process.exit(0);
if (!token) { console.error('APIFY_TOKEN is not set'); process.exit(1); }
if (!store.actorId) { console.log('no actorId in store.json yet (first deploy): tasks are published on the next push'); process.exit(0); }
if (!store.isPublic) { console.log('the Actor is private: tasks can be published only for a public Actor'); process.exit(0); }

/* ------------------------------------------------------------------- API -- */
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  const json = text ? JSON.parse(text) : {};
  return json.data ?? json;
}

const mine = [];
for (let offset = 0; ; ) {
  const page = await api('GET', `/actor-tasks?limit=1000&offset=${offset}`);
  mine.push(...page.items.filter((t) => t.actId === store.actorId));
  offset += page.items.length;
  if (!page.items.length || offset >= page.total) break;
}

let failed = 0;
for (const t of spec.tasks) {
  const body = {
    name: t.name, title: t.title, description: t.description, input: t.input, options: spec.options,
    publicConfig: { seoTitle: t.seoTitle, seoDescription: t.seoDescription, inputSchemaFields: t.inputSchemaFields, datasetView: t.datasetView },
  };
  try {
    const have = mine.find((m) => m.name === t.name);
    const saved = have ? await api('PUT', `/actor-tasks/${have.id}`, body) : await api('POST', '/actor-tasks', { actId: store.actorId, ...body });
    const now = await api('GET', `/actor-tasks/${saved.id}`);
    if (now.publishedAt || now.isPublic === true) {
      console.log(`${have ? 'updated' : 'created'} ${t.name} (${saved.id}), already published`);
    } else {
      await api('PUT', `/actor-tasks/${saved.id}`, { isPublic: true });
      console.log(`${have ? 'updated' : 'created'} ${t.name} (${saved.id}), published`);
    }
  } catch (e) {
    failed += 1;
    console.error(`FAILED ${t.name}: ${e.message}`);
  }
}
const extra = mine.filter((m) => !spec.tasks.some((t) => t.name === m.name)).map((m) => m.name);
if (extra.length) console.log(`tasks of this Actor not in tasks.json, left as they are: ${extra.join(', ')}`);
process.exit(failed ? 1 : 0);
