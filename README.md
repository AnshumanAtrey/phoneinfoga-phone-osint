# PhoneInfoga — International Phone Number OSINT

Cloud-hosted wrapper around [PhoneInfoga](https://github.com/sundowndev/phoneinfoga) (16K+ stars), the most popular OSINT tool for international phone numbers. Feed a list of numbers in E.164 format, get structured OSINT records back.

## What you get per number

- **Local validation** (offline, always works) — country, raw + formatted local, E164, international
- **Google search dorks** — pre-built URLs targeting Facebook, Twitter, LinkedIn, Instagram, VK, reputation sites, disposable-number databases, paste sites, and document searches
- **OVH carrier lookup** — when the number falls inside an OVH-supported range
- **Numverify** — carrier, line type (mobile / landline / VoIP), validity (requires your free Numverify API key as a secret input)
- **Google CSE** — web footprint search (requires your CSE API key + cx)

## Input

```json
{
  "numbers": ["+14155552671", "+919876543210"],
  "disableScanners": [],
  "numverifyApiKey": "",
  "googleCseApiKey": "",
  "googleCseCx": ""
}
```

Numbers must be in **E.164 international format** (`+` + country code + national number, no spaces or dashes).

## Output

One dataset record per number plus a final summary record. Each per-number record includes the local scanner data, OVH results, numverify results (if configured), and all Google search URLs grouped by category.

## Use cases

- Sales lead validation before cold-calling
- Fraud investigation
- Recruiter / OSINT investigator workflows
- DPDP-compliant lead enrichment (use only on numbers you already have lawful basis to process)

## Notes

- PhoneInfoga upstream is in maintenance mode; this wrapper pins a stable version and exposes graceful per-scanner failure handling.
- Numverify free tier = 100 lookups/month; bring your own key.
- For bulk Instagram/email lookups, pair with [Holehe Email OSINT](https://apify.com/anshumanatrey/holehe-email-osint) and [Social Analyzer](https://apify.com/anshumanatrey/social-analyzer).
