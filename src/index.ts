interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * Georgia Department of Community Health (DCH) Office of Inspector General
 * (OIG) List of Excluded Individuals and Entities screening — fleet #3279,
 * the sixth state exclusion pack after ny-omig-exclusions,
 * ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions and
 * pa-medical-exclusions.
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, Georgia runs its own Medicaid exclusion list through DCH
 * OIG, authorized under O.C.G.A. §§ 49-4-140 et seq. to exclude individuals
 * and entities from participating in Georgia's Medicaid program. This is
 * that list, for Georgia only — one pack per jurisdiction (root CLAUDE.md
 * rule 5).
 *
 * SOURCE AND SHAPE. DCH publishes the list itself, on its own OIG page
 * (https://dch.georgia.gov/office-inspector-general/georgia-oig-exclusions-list),
 * as a plain unauthenticated download. The download URL embeds the
 * publication date and is NOT stable — DCH republishes a new document node
 * roughly monthly — so mcps/ga-medical-exclusions/scripts/bake-index.mjs
 * always resolves the CURRENT link from the listing page rather than
 * hardcoding it. Verified live 2026-10-17: 200, Excel 2007+ (.xlsx),
 * 1,377 data rows.
 *
 * Root CLAUDE.md's standing rule 3 still applies regardless of
 * reachability: a baked table this size never sits in gateway module
 * scope. It is baked into src/ga-dch-oig-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy,
 * and injected here as `args._bakedIndex` — same pattern as the five
 * precedent packs (fleet #2754).
 *
 * This is an official Georgia State public enforcement record that DCH OIG
 * publishes specifically so providers, payers and the public can screen
 * against it — baking a copy needs no reuse grant, same footing as the
 * federal LEIE and the five precedent state packs.
 *
 * THIS IS A CURRENT-SNAPSHOT LIST, NOT AN EVER-EXCLUDED FILE — different
 * from the five precedent packs. DCH's own page states exclusions "remain
 * in effect until they are removed from this list" — there is no
 * reinstated-date column; a reinstated provider simply disappears from the
 * next monthly publication. So every row here IS currently excluded by
 * construction, and this pack carries no currently_excluded/
 * ever-vs-current distinction — instead it states plainly that it cannot
 * answer anything about a PAST exclusion already removed from the list.
 *
 * NO LICENSE NUMBER, NO FEIN IN THIS DATA — checked directly, not assumed
 * from the sibling packs' shape. DCH's columns are LAST NAME, FIRST NAME,
 * MIDDLE NAME, BUSINESS NAME, GENERAL (provider type), STATE, SANCDATE,
 * NPI — narrower than tx/pa-medical-exclusions. Only an NPI match is an
 * identification here.
 *
 * STATE IS FREE TEXT, OFTEN MULTIPLE STATES — most rows carry a plain
 * two-letter code, but others carry comma- or ampersand-joined lists of
 * every state the entity is also excluded/licensed in (e.g.
 * "GA,FL,IL,VA,SC,CT"). Served verbatim, trimmed only.
 *
 * MATCHING MODEL, same discipline as the five precedent packs: an NPI
 * match identifies a specific provider (exact, provider-specific
 * identifier). A name match — even an exact one — is a CANDIDATE, never an
 * identification: this list has no date of birth (DCH has started
 * recording one on a handful of the newest rows, but this pack does not
 * carry it — see bake-index.mjs), and common surnames repeat across 1,377
 * rows spanning 1982-2026.
 *
 * Keyless.
 */
import type { GaDchOigRow } from './ga-dch-oig-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table is injected by the
// gateway as `args._bakedIndex`, loaded from KV once per isolate. NEVER
// value-import ./ga-dch-oig-index-data.js here — only the type-only import
// above, which is erased at compile time. A value import puts the whole
// table back in the bundle and into every isolate's heap;
// scripts/check-gateway-bundle-size.mjs fails the deploy if that happens.
let ROWS: GaDchOigRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.GA_DCH_OIG_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no match found"
    // from an empty table would be a silent wrong answer, indistinguishable
    // from a real clean screening result.
    throw new Error(
      `ga-medical-exclusions: the baked GA DCH OIG exclusions index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as GaDchOigRow[];
  DATA_AS_OF = String(idx?.GA_DCH_OIG_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.GA_DCH_OIG_SOURCE_URL ?? 'https://dch.georgia.gov/office-inspector-general/georgia-oig-exclusions-list');
  CAPTURED_AT = String(idx?.GA_DCH_OIG_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.GA_DCH_OIG_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'Georgia Department of Community Health (DCH), Office of Inspector General — List of Excluded Individuals and Entities';

const SNAPSHOT_CAVEAT =
  'This is a current-snapshot list, not an ever-excluded file — DCH removes a provider from this list once reinstated rather than tracking a reinstatement date. Every row returned here is currently excluded; this pack cannot tell you about a past exclusion that has since been removed from the list.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — this list has no date of birth to tell same-named providers apart, and most rows carry no business name. Only an NPI match identifies a specific provider. Confirm a name match against the provider\'s NPI before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function fullName(r: GaDchOigRow): string {
  const parts = [r.first_name, r.middle_name, r.last_name].filter((p): p is string => Boolean(p));
  return parts.join(' ');
}

function displayName(r: GaDchOigRow): string {
  return fullName(r) || r.business_name || 'Unknown';
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

type MatchType = 'npi_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against this provider\'s listed NPI. An NPI identifies one provider, so this is an identification.',
  name_candidate_exact: 'The name matched exactly (individual name or business name), but this list has no date of birth to confirm it is the same person or entity — several excluded providers can share a name. Confirm with NPI before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact, checked against the provider\'s individual name and business name. Treat as a lead to check, not a finding. Confirm with NPI.',
};

function shape(r: GaDchOigRow, matchType: MatchType) {
  return {
    provider_name: displayName(r),
    business_name: r.business_name,
    provider_type: r.provider_type,
    state: r.state,
    npi: r.npi,
    sanction_date: r.sanction_date,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';

  if (!nameRaw && !npiRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen) and/or npi. An NPI match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];

  const identitySeen = new Set<GaDchOigRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const fullNorm = normalize(fullName(r));
      const businessNorm = r.business_name ? normalize(r.business_name) : '';
      if ((fullNorm && qNorm === fullNorm) || (businessNorm && qNorm === businessNorm)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (qTokens.length > 0 && qTokens.every((t) => fullNorm.includes(t) || businessNorm.includes(t))) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the Georgia DCH OIG List of Excluded Individuals and Entities for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null },
      caveat: `This checks the Georgia DCH OIG exclusions list only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, or any other state's Medicaid exclusion list (see ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions, pa-medical-exclusions). ${SNAPSHOT_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    snapshot_caveat: SNAPSHOT_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const dates = ROWS.map((r) => r.sanction_date).filter((d): d is string => Boolean(d)).sort();
  const providerTypes = new Set(ROWS.map((r) => r.provider_type).filter(Boolean));

  // fleet #3170: count-by-date-range mode, same as the five precedent state
  // packs. Counted field is sanction_date (DCH's SANCDATE / sanction
  // effective date) — the only date field this list carries.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const count = ROWS.filter((r) => inRange(r.sanction_date, range)).length;
    return {
      found: true,
      mode: 'date_range_count',
      count,
      date_field_counted: 'sanction_date — DCH\'s SANCDATE (sanction effective date), the only date field this list publishes.',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list (1,300+ rows), not a page',
      total_exclusions_all_time: TOTAL_ROWS,
      oldest_sanction_date: dates[0] ?? null,
      newest_sanction_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      snapshot_caveat: SNAPSHOT_CAVEAT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

  return {
    found: true,
    total_exclusions: TOTAL_ROWS,
    with_npi: withNpi,
    distinct_provider_types: providerTypes.size,
    oldest_sanction_date: dates[0] ?? null,
    newest_sanction_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    snapshot_caveat: SNAPSHOT_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ga_medical_check_exclusion',
    description:
      'Is this healthcare provider excluded from the Georgia Medicaid program? Screens a person or business name and/or an NPI against the Georgia Department of Community Health (DCH) Office of Inspector General (OIG) List of Excluded Individuals and Entities — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for Georgia specifically, and the sibling of ny_omig_check_exclusion (New York), ca_medical_check_exclusion (California), tx_medical_check_exclusion (Texas), fl_medical_check_exclusion (Florida) and pa_medical_check_exclusion (Pennsylvania). Answers "is this provider excluded from Georgia Medicaid", "check this NPI against the Georgia DCH OIG exclusions list", or pre-payment/credentialing screening for a Georgia Medicaid provider. '
      + 'An NPI match is an IDENTIFICATION (an exact, provider-specific identifier); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth to tell same-named providers apart. Unlike the Texas/California/New York/Pennsylvania lists, this is a CURRENT-SNAPSHOT list, not an ever-excluded file — DCH removes a provider once reinstated rather than tracking a reinstatement date, so every match here is currently excluded. Pass npi to turn a name lead into an identification. Sourced from the Georgia DCH OIG List of Excluded Individuals and Entities, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "John Smith" or "Acme Pharmacy Inc". Matched against the provider\'s individual name and business name, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'ga_medical_exclusion_coverage',
    description:
      'What the Georgia DCH OIG exclusions data covers and how current it is: total exclusions currently on the list, how many carry an NPI, how many distinct provider types appear, and the oldest/newest sanction effective date. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line note that this is a current-snapshot list (DCH removes reinstated providers rather than flagging them). '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many exclusions have a sanction effective date in that year or range, counted over the whole 1,300+ row list, not a page — answers "how many Georgia DCH OIG exclusions had a 2025 effective date". The response names the date field counted (sanction_date / DCH\'s SANCDATE, the only date field this list publishes). Sourced from the Georgia DCH OIG List of Excluded Individuals and Entities, keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'ga_medical_check_exclusion':
      return checkExclusion(args);
    case 'ga_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
