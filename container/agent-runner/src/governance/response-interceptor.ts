/**
 * Response Quality Interceptor
 *
 * Think of this like a copy editor between Atlas and the CEO.
 * Atlas writes a response, the editor reviews it for quality
 * (plain language, no jargon without analogies, decisions clearly
 * marked as confirmed vs open). If it fails, the editor sends it
 * back for one rewrite. Then it goes out regardless.
 *
 * Only runs for CEO-facing responses (not scheduled tasks).
 * Uses Haiku for fast, cheap quality evaluation.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';

// Tri-state quality-check contract (codex consult 2026-04-25, 5 rounds).
// Replaces the prior `pass: boolean + checkerUnavailable?: boolean + score` shape,
// which conflated "host returned a judgment of fail" with "host couldn't render
// a judgment" and silently routed both to ship-the-response when violations was
// empty. Discriminated union forces the routing decision in index.ts to be made
// on `status` rather than guessed from `criticals.length`.
export type UnavailableReason =
  | 'billing'        // credit/quota exhausted; not retryable; operator alert.
  | 'timeout'        // request timeout; retryable; soft-window alert.
  | 'network'        // 5xx/URLError/transport; retryable; soft-window alert.
  | 'auth'           // 401/unauthorized; not retryable; operator alert.
  | 'parse'          // Haiku returned unparseable text; not retryable; loud-log only.
  | 'token_missing'  // ANTHROPIC_API_KEY absent on host; not retryable; operator alert.
  | 'api_error'      // unclassified upstream/handler fault; not retryable.
  | 'busy'           // host in-flight cap reached; retryable.
  | 'prompt_missing' // bundled prompt asset missing in image; not retryable.
  | 'host_unreachable' // container couldn't reach host endpoint at all (network).
  | 'host_unauthorized'; // bearer token rejected by host (auth fail at endpoint).

export type QualityCheckResult =
  | { status: 'pass'; score: number; violations: QualityViolation[] }
  | { status: 'fail'; score: number; violations: QualityViolation[] }
  | { status: 'unavailable'; reason: UnavailableReason; retryable: boolean; detail?: string };

export interface QualityViolation {
  rule: string;
  severity: 'critical' | 'warning';
  description: string;
}

// Audit log shape v2. Sink-split (R5): the JSONL audit emits a coarse
// reason='infra_unavailable' so non-operator readers don't see exact billing/
// auth/token state. Exact reason still goes to container stderr (operator log)
// and host-side Telegram alert. Old fields preserved for back-compat with any
// directory-level digest readers.
export interface InterceptionLog {
  timestamp: string;
  entity: string;
  originalScore: number;
  retried: boolean;
  finalScore: number;
  violations: string[];
  responseLength: number;
  // v2 additions
  schemaVersion?: 2;
  status?: 'pass' | 'fail' | 'unavailable';
  reasonCoarse?: 'infra_unavailable' | null;  // coarsened — see comment above
  lintTriggered?: 'rewrite' | 'warn' | 'none';
  lintFired?: string[];
  promptSha?: string;
}

// Bundled prompt path (Dockerfile COPY → /opt/nanoclaw/quality-check-prompt.md).
// Source-of-truth file lives at container/agent-runner/src/governance/quality-check-prompt.md
// in the repo. Host-executor reads the SAME file from the repo at startup so
// host and container are guaranteed to use byte-identical prompt text. If the
// COPY step is missing from a future Dockerfile rewrite, this module fails fast
// at load — there is no silent fallback prompt anymore (codex R4: silent
// fallback was a hidden contract change waiting to happen).
const QUALITY_CHECK_PROMPT_PATH = '/opt/nanoclaw/quality-check-prompt.md';
const QUALITY_CHECK_PROMPT = ((): string => {
  let body: string;
  try {
    body = fs.readFileSync(QUALITY_CHECK_PROMPT_PATH, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[response-interceptor] FATAL: quality-check prompt not found at ${QUALITY_CHECK_PROMPT_PATH}. ` +
      `Container image is missing the Dockerfile COPY step or the source file was deleted. ` +
      `Refusing to start. Underlying error: ${msg}`,
    );
  }
  if (!body.trim()) {
    throw new Error(
      `[response-interceptor] FATAL: quality-check prompt at ${QUALITY_CHECK_PROMPT_PATH} is empty.`,
    );
  }
  if (!body.includes('{RESPONSE}')) {
    throw new Error(
      `[response-interceptor] FATAL: quality-check prompt missing {RESPONSE} placeholder.`,
    );
  }
  return body;
})();
// 12-char SHA-256 of the loaded prompt text. Emitted on quality-check audit
// log lines so a host-vs-container drift (host updated, image not rebuilt) is
// visible. Compute once at module load to avoid hashing per request.
const QUALITY_CHECK_PROMPT_SHA = crypto
  .createHash('sha256')
  .update(QUALITY_CHECK_PROMPT, 'utf-8')
  .digest('hex')
  .slice(0, 12);

/**
 * Call Haiku to evaluate response quality.
 * Routes through the host-executor's /quality-check endpoint, which has
 * the real API key and calls Haiku directly. Containers never touch API keys.
 *
 * Why not call Anthropic directly from the container?
 * - /v1/messages does not accept OAuth tokens (Anthropic limitation)
 * - Containers don't have API keys (security: credential proxy handles SDK auth)
 * - Host-executor runs on the VPS host with access to ~/.atlas/.env
 */
/**
 * Read QUALITY_CHECK_TOKEN from /home/node/.atlas/.env (the read-only mount
 * of the host's ~/.atlas/.env). Mirrors the host-side _load_quality_check_token
 * direct-parse pattern — file-only, no process.env check. The host side is
 * also file-only by design, so the host endpoint and the container caller
 * read from the same single source of truth and cannot drift. Cached at
 * module load — restart the container after rotating the token.
 */
function loadQualityCheckToken(): string {
  const envPath = '/home/node/.atlas/.env';
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('QUALITY_CHECK_TOKEN=')) {
        return line.slice('QUALITY_CHECK_TOKEN='.length).trim();
      }
    }
  } catch { /* file missing or unreadable — return empty, callHaiku will treat as unavailable */ }
  return '';
}

const QUALITY_CHECK_TOKEN = loadQualityCheckToken();

// Classify a legacy host response (pre-tri-state). Old hosts return
// {score: -N, error: "...", raw_text?: "..."} wrapped in HTTP 200. Inspect
// numeric score and error text to choose the closest UnavailableReason.
// Used only when body lacks a valid `status` field.
function classifyLegacyError(score: number | undefined, errorText: string): UnavailableReason {
  const err = (errorText || '').toLowerCase();
  if (/insufficient_quota|credit balance/.test(err)) return 'billing';
  if (/\b401\b|unauthorized/.test(err)) return 'auth';
  if (/api_key not found|token missing|key not found/.test(err)) return 'token_missing';
  if (/json|parse/.test(err)) return 'parse';
  if (/timeout/.test(err)) return 'timeout';
  if (/network|url|connection/.test(err)) return 'network';
  // Numeric fallbacks (host-executor pre-tri-state used -2 parse, -3 network, -4 timeout)
  if (score === -2) return 'parse';
  if (score === -3) return 'network';
  if (score === -4) return 'timeout';
  return 'api_error';
}

const QUALITY_CHECK_RETRYABLE: ReadonlySet<UnavailableReason> = new Set<UnavailableReason>([
  'timeout',
  'network',
  'busy',
  'host_unreachable',
]);

interface AttemptOutcome {
  result: QualityCheckResult;
  legacy: boolean;  // true if host responded without `status` field — used for one-time DEPRECATED log
}

// Single HTTP attempt at the /quality-check endpoint. Returns a tri-state
// result and a legacy flag indicating whether the host body was schema-v1.
// Retry policy lives in callHaiku() above this — keeps attempt logic linear.
function attemptQualityCheck(
  responseText: string,
  attemptTimeoutMs: number,
): Promise<AttemptOutcome> {
  // Port 3003 (was 3002 historically — moved to avoid colliding with
  // atlas-bridge.service which owns 127.0.0.1:3002 on the VPS). Hardcoded
  // to keep host and container constants in lockstep — no env-var
  // propagation channel into containers exists today. Changing the port
  // requires editing host/host-executor.py too.
  const hostGateway = process.env.CONTAINER_HOST_GATEWAY || 'host.docker.internal';
  const port = 3003;
  const url = `http://${hostGateway}:${port}/quality-check`;

  const body = JSON.stringify({ response: responseText.slice(0, 4000) });
  const log = (msg: string) => console.error(`[response-interceptor] ${msg}`);

  const unavailable = (
    reason: UnavailableReason,
    retryable: boolean,
    detail: string,
  ): QualityCheckResult => ({ status: 'unavailable', reason, retryable, detail: detail.slice(0, 300) });

  if (!QUALITY_CHECK_TOKEN) {
    log('Quality-check token missing — skipping host call (treated as host_unauthorized)');
    return Promise.resolve({
      result: unavailable('token_missing', false, 'QUALITY_CHECK_TOKEN missing in container .env mount'),
      legacy: false,
    });
  }

  return new Promise<AttemptOutcome>((resolve) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          // Bearer token shared with host-executor's QualityCheckHandler.
          // Host-side compares with hmac.compare_digest so timing leaks are
          // avoided. Don't log the header value here or in error paths.
          'Authorization': `Bearer ${QUALITY_CHECK_TOKEN}`,
        },
        timeout: attemptTimeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // HTTP 401: host rejected our token. Not retryable (token wouldn't
          // change between attempts). Distinct from host-internal auth fail
          // upstream — this is the bearer check on the endpoint itself.
          if (res.statusCode === 401) {
            log(`Host quality-check 401 — bearer token rejected by host endpoint`);
            resolve({
              result: unavailable('host_unauthorized', false, 'Host endpoint returned 401'),
              legacy: false,
            });
            return;
          }
          // HTTP 429: host in-flight cap reached. Retryable (the cap is
          // momentary; another attempt may land in slack capacity).
          if (res.statusCode === 429) {
            log(`Host quality-check 429 — busy (in-flight cap)`);
            try {
              const parsed429 = JSON.parse(data);
              if (parsed429 && parsed429.status === 'unavailable') {
                resolve({ result: parsed429 as QualityCheckResult, legacy: false });
                return;
              }
            } catch { /* fall through to canonical busy */ }
            resolve({
              result: unavailable('busy', true, 'Host reported in-flight cap reached'),
              legacy: false,
            });
            return;
          }
          // Any other non-200: try to parse a tri-state body before falling
          // back to a generic network classification. Host wraps handler
          // exceptions in `{status:"unavailable", reason:"api_error", ...}`
          // inside HTTP 500 (host-executor.py:444-451). Cross-review F2 on
          // 1672f4c: prior code never parsed those bodies, so internal host
          // faults were misclassified as `network/retryable` and spuriously
          // retried. Fix: parse body if it looks like tri-state, regardless
          // of status code; HTTP code is secondary signal.
          if (res.statusCode !== 200) {
            log(`Host quality-check returned ${res.statusCode}: ${data.slice(0, 200)}`);
            try {
              const parsedNon200 = JSON.parse(data);
              if (
                parsedNon200 &&
                typeof parsedNon200 === 'object' &&
                parsedNon200.status === 'unavailable' &&
                typeof parsedNon200.reason === 'string'
              ) {
                resolve({
                  result: parsedNon200 as QualityCheckResult,
                  legacy: false,
                });
                return;
              }
            } catch { /* fall through to canonical network */ }
            resolve({
              result: unavailable('network', true, `Host HTTP ${res.statusCode}`),
              legacy: false,
            });
            return;
          }
          // HTTP 200: parse body. Tri-state contract requires `status` field.
          // If absent, fall back to legacy {score, violations, error?} shape
          // and synthesize an unavailable on score<0.
          let body: unknown;
          try {
            body = JSON.parse(data);
          } catch (err) {
            log(`Quality-check JSON parse failure: ${err instanceof Error ? err.message : String(err)}`);
            log(`Raw response (first 300): ${data.slice(0, 300)}`);
            resolve({
              result: unavailable('parse', false, 'Container could not parse host JSON body'),
              legacy: false,
            });
            return;
          }
          const obj = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
          const explicitStatus = typeof obj.status === 'string' ? obj.status : '';
          if (explicitStatus === 'pass' || explicitStatus === 'fail') {
            const rawScore = obj.score;
            const score = typeof rawScore === 'number' ? rawScore : 50;
            const rawViolations = Array.isArray(obj.violations) ? obj.violations : [];
            const violations: QualityViolation[] = rawViolations
              .filter((v): v is QualityViolation => {
                return !!v && typeof v === 'object' && typeof (v as QualityViolation).rule === 'string' && typeof (v as QualityViolation).severity === 'string';
              });
            log(`Haiku evaluated: status=${explicitStatus} score=${score} violations=${violations.length} sha=${QUALITY_CHECK_PROMPT_SHA}`);
            resolve({
              result: { status: explicitStatus, score, violations },
              legacy: false,
            });
            return;
          }
          if (explicitStatus === 'unavailable') {
            const reason = (typeof obj.reason === 'string' ? obj.reason : 'api_error') as UnavailableReason;
            const retryable = !!obj.retryable;
            const detail = typeof obj.detail === 'string' ? obj.detail : '';
            log(`Host quality-check UNAVAILABLE: reason=${reason} retryable=${retryable} detail=${detail.slice(0, 200)} sha=${QUALITY_CHECK_PROMPT_SHA}`);
            resolve({
              result: { status: 'unavailable', reason, retryable, detail },
              legacy: false,
            });
            return;
          }
          // Legacy fallback (status field missing). Inspect score+error.
          const rawScore = typeof obj.score === 'number' ? obj.score : undefined;
          const errorText = typeof obj.error === 'string' ? obj.error : '';
          if (rawScore === undefined || rawScore < 0) {
            const reason = classifyLegacyError(rawScore, errorText);
            log(`Legacy host body (no status field): score=${rawScore} error=${errorText.slice(0, 200)} → reason=${reason}`);
            resolve({
              result: unavailable(reason, QUALITY_CHECK_RETRYABLE.has(reason), errorText),
              legacy: true,
            });
            return;
          }
          // Legacy success path — score>=0, derive pass/fail by threshold.
          const rawViolations = Array.isArray(obj.violations) ? obj.violations : [];
          const violations: QualityViolation[] = rawViolations
            .filter((v): v is QualityViolation => {
              return !!v && typeof v === 'object' && typeof (v as QualityViolation).rule === 'string' && typeof (v as QualityViolation).severity === 'string';
            });
          const status = rawScore >= 85 ? 'pass' : 'fail';
          log(`Legacy host body (no status field): score=${rawScore} violations=${violations.length} → status=${status}`);
          resolve({
            result: { status, score: rawScore, violations },
            legacy: true,
          });
        });
      },
    );

    req.on('error', (err) => {
      log(`Quality-check network error: ${err.message}`);
      resolve({
        result: unavailable('host_unreachable', true, err.message),
        legacy: false,
      });
    });

    req.on('timeout', () => {
      log(`Quality-check timed out after ${attemptTimeoutMs}ms`);
      req.destroy();
      resolve({
        result: unavailable('timeout', true, `Container timed out after ${attemptTimeoutMs}ms`),
        legacy: false,
      });
    });

    req.write(body);
    req.end();
  });
}

// Module-level legacy-host warning latch — emit at most once per container
// life so old hosts don't flood stderr. Cleared by container restart, which
// is the same lifecycle as token rotation.
let LEGACY_HOST_WARNED = false;

async function callHaiku(responseText: string): Promise<QualityCheckResult> {
  // Timeout ordering MUST satisfy container >= host. Host upstream Haiku
  // call is 10s (host-executor.py:177). If container abandons earlier
  // (e.g., 8s), the host keeps the in-flight slot open until its own
  // timeout — a retry then briefly double-consumes capacity and can
  // self-trigger HTTP 429 busy. Cross-review F1 on 1672f4c flagged this.
  // Set container timeouts to host_timeout + 2s slack on both attempts.
  // First 12s + ~250ms jitter + second 12s = ~24.3s worst case, still
  // inside the <30s SDK Telegram-reply envelope.
  const attempt1 = await attemptQualityCheck(responseText, 12000);
  if (attempt1.legacy && !LEGACY_HOST_WARNED) {
    LEGACY_HOST_WARNED = true;
    console.error(
      '[response-interceptor] DEPRECATED: host returned legacy body (no `status` field). ' +
      'Update host-executor to the tri-state contract; container is using legacy fallback parser.',
    );
  }
  if (attempt1.result.status !== 'unavailable') return attempt1.result;
  if (!attempt1.result.retryable) return attempt1.result;

  const jitterMs = 200 + Math.floor(Math.random() * 100);
  await new Promise<void>((r) => setTimeout(r, jitterMs));
  // Second attempt also at 12s for the same host-slot-retention reason.
  const attempt2 = await attemptQualityCheck(responseText, 12000);
  if (attempt2.legacy && !LEGACY_HOST_WARNED) {
    LEGACY_HOST_WARNED = true;
    console.error(
      '[response-interceptor] DEPRECATED: host returned legacy body on retry too. ' +
      'Update host-executor to the tri-state contract.',
    );
  }
  return attempt2.result;
}

// (Old in-place callHaiku body fully replaced by attemptQualityCheck +
// callHaiku one-retry orchestrator above; nothing else lives here.)

/**
 * Build a correction prompt that tells the SDK to rewrite its response.
 */
export function buildCorrectionPrompt(violations: QualityViolation[]): string {
  const criticals = violations.filter((v) => v.severity === 'critical');
  const rules: string[] = [];

  for (const v of criticals) {
    if (v.rule === 'layman_first') {
      rules.push(
        `LAYMAN-FIRST: ${v.description}. Restate using a plain-language analogy BEFORE any technical terms. ` +
        `Start with "Think of it like..." or explain in words someone who has never written code would understand.`
      );
    } else if (v.rule === 'decision_confirmation') {
      rules.push(
        `DECISION CONFIRMATION: ${v.description}. Split into "CEO confirmed" vs "still needs your call" sections.`
      );
    } else if (v.rule === 'assumptions') {
      rules.push(
        `ASSUMPTIONS: ${v.description}. State assumptions explicitly as "I'm assuming X — correct me if wrong."`
      );
    } else if (v.rule === 'non_answer') {
      rules.push(
        `NON-ANSWER: ${v.description}. Answer the question FULLY right now. Do not reference previous answers, ` +
        `do not tell the user to scroll up, do not say "already covered," do not suggest the user has a device problem. ` +
        `Provide the complete answer as if this is the first time it was ever asked.`
      );
    }
  }

  // Fallback: status==='fail' may carry an empty violations array (host
  // reported below-threshold score but Haiku didn't enumerate rules). We
  // still need to rewrite — empty rules list would just emit a no-op
  // correction. Emit a generic plain-language directive instead.
  // Codex consult R3: "Status should still drive routing; empty violations
  // should not suppress rewrite."
  if (rules.length === 0) {
    return (
      `Quality check flagged the response as fail without specific rules. ` +
      `Rewrite the entire answer in plain language first, fully self-contained, ` +
      `no references to prior messages, and do not present unconfirmed decisions as final. ` +
      `Do NOT say "here is the corrected version" — just give the corrected response directly.`
    );
  }

  return (
    `Your previous response violated quality rules. Rewrite it following these corrections:\n\n` +
    rules.map((r, i) => `${i + 1}. ${r}`).join('\n') +
    `\n\nRestate your ENTIRE previous response with these fixes applied. ` +
    `Do NOT say "here is the corrected version" — just give the corrected response directly.`
  );
}

/**
 * Log interception results for the learning system.
 */
function logInterception(entry: InterceptionLog): void {
  try {
    const dir = path.join(ATLAS_STATE_DIR, 'audit', entry.entity);
    fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const logPath = path.join(dir, `interceptions-${date}.jsonl`);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // Never crash on logging failure
  }
}

/**
 * Check response quality and determine if a retry is needed.
 *
 * Returns the check result. The caller decides whether to retry
 * based on `result.pass` and whether a retry has already happened.
 */
export async function checkResponseQuality(
  responseText: string,
): Promise<QualityCheckResult> {
  // Skip check for very short responses (acknowledgments, confirmations).
  // KNOWN GAP (audit doc 1.A.6 §5.4 E1): a deflection or unauthorized-decision
  // reply <100 chars still bypasses; out of scope for this commit.
  if (!responseText || responseText.length < 100) {
    return { status: 'pass', score: 95, violations: [] };
  }

  // Skip check for code-only responses (no prose to evaluate).
  // Same KNOWN GAP — code-only escapes also bypass governance.
  const codeBlockRatio = (responseText.match(/```/g) || []).length / 2;
  const lines = responseText.split('\n').length;
  if (codeBlockRatio > 0 && codeBlockRatio * 10 > lines * 0.7) {
    return { status: 'pass', score: 90, violations: [] };
  }

  return callHaiku(responseText);
}

// Helpers for unioned-result accessors. Pass/fail variants carry score and
// violations; unavailable carries reason+retryable+detail. Callers that need
// a generic numeric "did the gate run successfully" surrogate use scoreOf().
function scoreOf(r: QualityCheckResult): number {
  return r.status === 'unavailable' ? -1 : r.score;
}

function violationsOf(r: QualityCheckResult): QualityViolation[] {
  return r.status === 'unavailable' ? [] : r.violations;
}

// Coarsen the exact unavailable reason for the JSONL audit log. Per codex R5:
// non-operator readers may scan the audit dir; we don't want them seeing
// `billing` / `auth` / `token_missing` which are operational state. Exact
// reason still goes to container stderr (operator log) and host-side Telegram
// alert. The coarse string is `infra_unavailable` regardless of cause.
function coarseReason(r: QualityCheckResult): 'infra_unavailable' | null {
  return r.status === 'unavailable' ? 'infra_unavailable' : null;
}

/**
 * Log the full interception lifecycle (original check, retry, final result).
 *
 * Sink-split (codex consult 2026-04-25 R5):
 *   - JSONL audit gets coarse `reasonCoarse` (infra_unavailable | null) so
 *     non-operator readers don't see exact billing/auth state.
 *   - stderr gets the exact reason via separate log statements at the call
 *     site (index.ts UNAVAILABLE log line, includes prompt SHA).
 *   - Telegram alert gets exact reason via host-executor's
 *     _maybe_send_operator_alert (host-side persistent dedup).
 */
export function logInterceptionResult(
  entity: string,
  originalResult: QualityCheckResult,
  retried: boolean,
  finalResult: QualityCheckResult | null,
  responseLength: number,
  audit?: {
    lintTriggered?: 'rewrite' | 'warn' | 'none';
    lintFired?: string[];
  },
): void {
  logInterception({
    timestamp: new Date().toISOString(),
    entity,
    originalScore: scoreOf(originalResult),
    retried,
    finalScore: finalResult ? scoreOf(finalResult) : scoreOf(originalResult),
    violations: violationsOf(originalResult).map((v) => `${v.rule}:${v.severity}`),
    responseLength,
    schemaVersion: 2,
    status: originalResult.status,
    reasonCoarse: coarseReason(originalResult),
    lintTriggered: audit?.lintTriggered ?? 'none',
    lintFired: audit?.lintFired ?? [],
    promptSha: QUALITY_CHECK_PROMPT_SHA,
  });
}

/**
 * Local critical-text lint for use ONLY in degraded mode (status==='unavailable').
 *
 * Narrow phrase regex on a normalized copy of the input. Normalization steps:
 *   1. Unicode NFKC fold (collapses look-alike forms)
 *   2. Lowercase
 *   3. Strip zero-width chars (U+200B–U+200D, U+FEFF) that could split tokens
 *
 * Rule set is intentionally tiny — high-confidence non-answer markers only.
 * Function-name / code-fence detection moved to WARN-class (audit-only) per
 * codex R3 because false-positive risk on legitimate technical replies was
 * too high to justify a one-shot rewrite trigger.
 */
const ZERO_WIDTH_RE = /[​-‍﻿]/g;

const REWRITE_PHRASE_RULES: Array<{ name: string; re: RegExp }> = [
  // "see above" but NOT "see above-ground"
  { name: 'see_above', re: /\bsee above\b(?!-)/ },
  { name: 'scroll_up', re: /\bscroll up\b/ },
  // "as I said" but NOT "as I said to <someone>"
  { name: 'as_i_said', re: /\bas i said\b(?!\s+to\b)/ },
  { name: 'already_covered', re: /\balready covered\b/ },
];

export interface LocalLintResult {
  fired: string[];      // rule names that matched (REWRITE-class only)
}

export function runLocalCriticalLint(text: string): LocalLintResult {
  if (!text) return { fired: [] };
  const normalized = text.normalize('NFKC').toLowerCase().replace(ZERO_WIDTH_RE, '');
  const fired: string[] = [];
  for (const rule of REWRITE_PHRASE_RULES) {
    if (rule.re.test(normalized)) {
      fired.push(rule.name);
    }
  }
  return { fired };
}

/**
 * Build a degraded-mode correction prompt referencing the matched anti-patterns.
 * Used when local lint fires while quality-checker is unavailable. Static text;
 * does NOT pass through Haiku (unavailable by definition in this branch).
 */
export function buildLocalDegradedCorrection(lint: LocalLintResult): string {
  const fired = lint.fired.length > 0 ? lint.fired.join(', ') : 'unspecified';
  return (
    `Your previous response triggered local non-answer markers: [${fired}]. ` +
    `Rewrite the entire response answering the question directly, in plain language, ` +
    `with no references to prior messages ("see above", "as I said", "scroll up", "already covered"). ` +
    `Do NOT say "here is the corrected version" — give the corrected response directly.`
  );
}
