# @pipeworx/ga-medical-exclusions

Georgia Department of Community Health (DCH) Office of Inspector General
(OIG) List of Excluded Individuals and Entities screening — check a
provider by name or NPI against the ~1,377-row current-snapshot list of
individuals and entities excluded from Georgia's Medicaid program, the
state-level counterpart to the federal HHS OIG LEIE (`leie` pack) and the
sibling of `ny-omig-exclusions` (New York), `ca-medical-exclusions`
(California), `tx-medical-exclusions` (Texas), `fl-medical-exclusions`
(Florida) and `pa-medical-exclusions` (Pennsylvania).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1831+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ga_medical_check_exclusion(name?, npi?, limit?)` — screens a provider
  against the DCH OIG exclusions list. An NPI match is an
  **identification** (an exact, provider-specific identifier); a name
  match — even an exact one — is a **candidate lead only**, since the list
  carries no date of birth and most rows carry no business name to
  disambiguate same-named providers.
- `ga_medical_exclusion_coverage()` — total exclusions currently on the
  list, how many carry an NPI, how many distinct provider types appear, and
  the oldest/newest sanction effective date. Pass `year` or
  `start_date`/`end_date` to instead count exclusions whose sanction
  effective date falls in that range, over the whole list.

## Auth

Keyless.

## Data sources

- Georgia Department of Community Health (DCH), Office of Inspector
  General — List of Excluded Individuals and Entities, the state's
  published roster of individuals and businesses excluded from
  participating in Georgia's Medicaid program under O.C.G.A. §§ 49-4-140
  et seq., searchable/downloadable at
  <https://dch.georgia.gov/office-inspector-general/georgia-oig-exclusions-list>.

### The download link is NOT stable — resolved fresh every bake

DCH republishes a new document node roughly monthly, and its URL embeds
the publication date (e.g. a slug ending in `-october-5-2026`).
`scripts/bake-index.mjs` fetches the listing page first and extracts the
CURRENT download link from it — the same "resolve from the listing page,
never guess the filename" discipline `scripts/ingest-dmepos.mjs` uses for
CMS's unstable DMEPOS zip names. Never hardcode the dated URL.

### Why this is baked, not a live proxy

Per root CLAUDE.md's standing rule for a table this size, the full list
(1,377 rows at capture time) is baked by `scripts/bake-index.mjs` into
`src/ga-dch-oig-index-data.ts`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy,
and injected into every call as `args._bakedIndex` — never a static
module-scope import (fleet #2754). A missing or malformed injection throws
loudly rather than answering "not found" — see `src/index.test.ts`.

The resolved download is a plain, unauthenticated GET returning an Excel
2007+ (`.xlsx`) file — no VIEWSTATE, no session, no form replay, simpler
than `tx-medical-exclusions` and even `pa-medical-exclusions`.

### No external XLSX library — hand-rolled, same "no dependencies" discipline

An `.xlsx` is a zip of XML parts. `bake-index.mjs` reuses
`scripts/ingest-dmepos.mjs`'s minimal pure-Node zip reader (Node's built-in
`zlib.inflateRawSync` over a hand-walked central directory — no `unzip`
CLI, no npm package), resolves the workbook's first sheet dynamically via
`xl/workbook.xml` + `xl/_rels/workbook.xml.rels` (Excel reassigns
`sheetN.xml` numbers when tabs are reordered, so this is never assumed),
decodes `xl/sharedStrings.xml` for text cells, and walks `<row>`/`<c>`
elements for the 9 columns this file uses.

### SANCDATE is three different raw shapes in the same column

Verified directly against all 1,377 rows, not assumed: most rows (922)
carry the sanction date as an 8-digit STRING (`"19820415"`), 445 as an
8-digit NUMBER (same meaning, typed differently), and a handful of the
most recently added rows carry a genuine Excel date SERIAL (e.g.
`45828` = `2025-06-20`) because DCH typed a real date into the cell. The
baker tells the two numeric shapes apart by MAGNITUDE: an 8-digit YYYYMMDD
value is always ≥ 19,000,000, while an Excel date serial for any date in
this list's range (1982-2026) is always under 100,000 — no possible
collision, so reading `xl/styles.xml` for each cell's number format was
unnecessary. 6 of 1,377 rows carry no sanction date at all and are kept
with `sanction_date: null`.

### This is a current-snapshot list, not an ever-excluded file

Different from the five precedent packs. DCH's own page states exclusions
"remain in effect until they are removed from this list" — there is no
reinstated-date column; a reinstated provider simply disappears from the
next monthly publication. So every row returned here IS currently
excluded by construction, and this pack states plainly (via
`snapshot_caveat`) that it cannot answer anything about a past exclusion
already removed from the list.

### No license number, no FEIN — narrower matching model than the siblings

Checked directly, not assumed from the sibling packs' shape: DCH's columns
are LAST NAME, FIRST NAME, MIDDLE NAME, BUSINESS NAME, GENERAL (provider
type), STATE, SANCDATE, NPI — no license or FEIN column exists. Only an
NPI query (exact 10-digit numeric) is an identification; a `license` or
`fein` argument the sibling packs accept has no equivalent here.

### STATE is free text, often multiple states

Most rows carry a plain two-letter code (`"GA"`), but others carry comma-
or ampersand-joined lists of every state the entity is also excluded or
licensed in (e.g. `"GA,FL,IL,VA,SC,CT"`, `"GA & FL"`), and a handful carry
a trailing space (`"GA "`). Served verbatim, trimmed only — never parsed
into a single enum.

### DOB exists in the source file but is not carried into this pack

A handful of the most recently added rows include a date-of-birth column
DCH has started populating. This pack serves the same fields the five
precedent state packs serve and adds no new personal identifier beyond
them — none of those packs serve a date of birth (its absence is exactly
why a name match is only ever a candidate lead). `bake-index.mjs` reads the
DOB column only to confirm its date decoder handles it correctly, then
discards it.

### Reachability

Verified live 2026-10-17: the listing page resolves a current download
link, and that link returns `200` with an Excel 2007+ file, 1,377 data
rows.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ga-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/ga-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ga-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1831+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ga_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"Diamond"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ga_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ga-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ga-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ga-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ga Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
