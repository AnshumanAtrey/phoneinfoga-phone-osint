#!/usr/bin/env node
/**
 * Print this Actor's MCP Registry entry (server.json) to stdout.
 *
 * Apify already serves every Store Actor as an MCP tool at
 * https://mcp.apify.com?tools=<user>/<actor>. The caller authenticates with
 * their own Apify token, so every call bills through the Actor's normal
 * pay-per-event pricing. This entry only lists that endpoint in the official
 * registry (registry.modelcontextprotocol.io), which GitHub's MCP registry and
 * other directories read from. The header block mirrors Apify's own entry,
 * com.apify/apify-mcp-server.
 *
 * Reads .actor/actor.json (name, title, version) and, when present,
 * .actor/store.json (seoTitle, the <=100-char description). Namespace is
 * io.github.<repo owner>/*, which the CI job proves via GitHub OIDC.
 *
 * Usage: node scripts/mcp-server-json.mjs > server.json
 *   GITHUB_REPOSITORY_OWNER  namespace owner (set by Actions)
 *   GITHUB_RUN_NUMBER        patch version; the registry rejects a repeated version
 */
import { existsSync, readFileSync } from 'node:fs';

const APIFY_USER = 'anshumanatrey';
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'AnshumanAtrey';
const run = process.env.GITHUB_RUN_NUMBER || '0';

const actor = JSON.parse(readFileSync('.actor/actor.json', 'utf8'));
const store = existsSync('.actor/store.json') ? JSON.parse(readFileSync('.actor/store.json', 'utf8')) : {};

const description = store.seoTitle || actor.title;
if (!description || description.length > 100) {
  console.error(`description must be 1-100 chars (registry limit), got ${description?.length}: ${description}`);
  process.exit(1);
}

const server = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: `io.github.${owner}/${actor.name}`,
  title: actor.title,
  description,
  version: `${actor.version}.${run}`,
  websiteUrl: `https://apify.com/${APIFY_USER}/${actor.name}`,
  repository: { url: `https://github.com/${owner}/${actor.name}`, source: 'github' },
  remotes: [{
    type: 'streamable-http',
    url: `https://mcp.apify.com/?tools=${APIFY_USER}/${actor.name}`,
    headers: [{
      name: 'Authorization',
      description: "Apify API token, as 'Bearer <apify-api-token>'. Runs bill to this account.",
      isRequired: true,
      isSecret: true,
    }],
  }],
};

console.log(JSON.stringify(server, null, 2));
