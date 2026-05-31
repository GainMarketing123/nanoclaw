/**
 * Thin HTTP client to the standalone Second-Brain memory service (/v1 API).
 *
 * Design contract (D-ENG1): nanoclaw's Teams channel holds only a THIN client
 * to this sibling service — mirroring the Atlas Bridge boundary. The chat path
 * is latency-critical, so EVERY method degrades gracefully: a slow or failing
 * brain returns a `degraded` sentinel, never a throw and never a hang.
 *
 * Uses node's built-in http/https (no axios/fetch dep), following the
 * timeout + destroy + error-dedup pattern from container-runner.ts.
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { logger } from '../logger.js';

export interface AskProvenance {
  raw_event_id: string;
  source: string | null;
  memory_item_ids: string[];
  score: number;
  cached: boolean;
}

export interface AskResult {
  answer: string;
  provenance: AskProvenance[];
  degraded: boolean;
}

export interface EntityInfo {
  id: string;
  slug: string;
  display_name: string | null;
}

export interface IngestStats {
  unprocessed_count: number;
  running_count: number;
  dead_letter_count: number;
  oldest_pending_age_seconds: number;
  lease_expired_count: number;
  unembedded_memory_items: number;
}

interface Envelope<T> {
  data: T | null;
  degraded: boolean;
  error: { code: string; message: string } | null;
}

interface RequestOutcome {
  envelope: Envelope<unknown> | null;
  degraded: boolean;
}

const DEGRADED_OUTCOME: RequestOutcome = { envelope: null, degraded: true };

/**
 * Parse a "loom" course-Q&A command. Pure (no network) so the regex lives in
 * one place and is unit-testable. Returns the question when the text is a loom
 * command, `''` when it is exactly "loom" with no question, and `null` when the
 * text is NOT a loom command (e.g. "I loom over the code").
 */
export function parseLoomQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (!/^loom\b/i.test(trimmed)) return null;
  return trimmed.replace(/^loom\b[:,]?\s*/i, '').trim();
}

export class SecondBrainClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(
    baseUrl: string,
    opts: { timeoutMs?: number; apiKey?: string } = {},
  ) {
    // Normalize: strip a trailing slash so path concatenation is predictable.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.apiKey = opts.apiKey;
  }

  /**
   * Ask the brain a question, scoped to one business (entity_id is required).
   * Never throws: a degraded envelope OR any network/timeout error yields
   * `{ answer: '', provenance: [], degraded: true }` so the caller can render
   * the "memory is catching up" fallback.
   */
  async ask(entityId: string, question: string): Promise<AskResult> {
    const outcome = await this._request('POST', '/v1/ask', {
      entity_id: entityId,
      question,
    });
    if (
      outcome.degraded ||
      !outcome.envelope ||
      outcome.envelope.degraded ||
      !outcome.envelope.data
    ) {
      return { answer: '', provenance: [], degraded: true };
    }
    const data = outcome.envelope.data as {
      answer?: string;
      provenance?: AskProvenance[];
    };
    return {
      answer: typeof data.answer === 'string' ? data.answer : '',
      provenance: Array.isArray(data.provenance) ? data.provenance : [],
      degraded: false,
    };
  }

  /**
   * Ask the brain a question scoped to ONE entity by slug (e.g. "learning"),
   * so callers need not resolve the UUID. Same never-throw contract as ask():
   * any failure/timeout/degraded envelope yields
   * `{ answer: '', provenance: [], degraded: true }`.
   */
  async askBySlug(slug: string, question: string): Promise<AskResult> {
    const outcome = await this._request('POST', '/v1/ask', {
      entity_slug: slug,
      question,
    });
    if (
      outcome.degraded ||
      !outcome.envelope ||
      outcome.envelope.degraded ||
      !outcome.envelope.data
    ) {
      return { answer: '', provenance: [], degraded: true };
    }
    const data = outcome.envelope.data as {
      answer?: string;
      provenance?: AskProvenance[];
    };
    return {
      answer: typeof data.answer === 'string' ? data.answer : '',
      provenance: Array.isArray(data.provenance) ? data.provenance : [],
      degraded: false,
    };
  }

  /**
   * List all entities the brain knows about (the businesses + personal space).
   * Used by the owner all-entity fan-out. Never throws: any failure or
   * degraded envelope yields `[]` so the chat path keeps moving.
   */
  async listEntities(): Promise<EntityInfo[]> {
    const outcome = await this._request('GET', '/v1/entities');
    if (
      outcome.degraded ||
      !outcome.envelope ||
      outcome.envelope.degraded ||
      !outcome.envelope.data
    ) {
      return [];
    }
    const data = outcome.envelope.data;
    return Array.isArray(data) ? (data as EntityInfo[]) : [];
  }

  /** Health probe. ok=false on any failure; degraded mirrors the envelope. */
  async health(): Promise<{ ok: boolean; degraded: boolean }> {
    const outcome = await this._request('GET', '/v1/health');
    if (outcome.degraded || !outcome.envelope) {
      return { ok: false, degraded: true };
    }
    return {
      ok: !outcome.envelope.degraded && outcome.envelope.data != null,
      degraded: outcome.envelope.degraded,
    };
  }

  /** Ingest observability counters; null on any failure. */
  async ingestStats(entityId?: string): Promise<IngestStats | null> {
    const path = entityId
      ? `/v1/ingest/stats?entity_id=${encodeURIComponent(entityId)}`
      : '/v1/ingest/stats';
    const outcome = await this._request('GET', path);
    if (outcome.degraded || !outcome.envelope || !outcome.envelope.data) {
      return null;
    }
    return outcome.envelope.data as IngestStats;
  }

  /**
   * Single bounded request. Resolves to a degraded sentinel on timeout,
   * socket error, or unparseable body — never rejects, so callers cannot hang.
   */
  private _request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<RequestOutcome> {
    return new Promise<RequestOutcome>((resolve) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (outcome: RequestOutcome) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve(outcome);
      };

      let url: URL;
      try {
        url = new URL(this.baseUrl + path);
      } catch (err) {
        logger.warn({ err, path }, 'second-brain: invalid URL');
        return done(DEGRADED_OUTCOME);
      }

      const transport = url.protocol === 'https:' ? https : http;
      let payload: string | undefined;
      try {
        payload = body === undefined ? undefined : JSON.stringify(body);
      } catch (err) {
        // Never throw to the caller — an unserializable body degrades like any
        // other failure on the latency-critical chat path.
        logger.warn({ err, path }, 'second-brain: unserializable request body');
        return done(DEGRADED_OUTCOME);
      }
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(payload));
      }
      if (this.apiKey) {
        headers['X-Atlas-Ingest-Secret'] = this.apiKey;
      }

      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          // NOTE: do NOT disable the socket timeout here — leaving it armed
          // means a response that stalls mid-body still trips 'timeout' below.
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              const envelope = JSON.parse(raw) as Envelope<unknown>;
              done({ envelope, degraded: Boolean(envelope.degraded) });
            } catch (err) {
              logger.warn(
                { err, path, status: res.statusCode },
                'second-brain: unparseable response',
              );
              done(DEGRADED_OUTCOME);
            }
          });
        },
      );

      let timedOut = false;
      req.on('error', () => {
        if (timedOut) return; // dedup the cascade from timeout destroy
        logger.warn({ path }, 'second-brain: request error; degrading');
        done(DEGRADED_OUTCOME);
      });
      req.on('timeout', () => {
        timedOut = true;
        logger.warn(
          { path, timeoutMs: this.timeoutMs },
          'second-brain: request timed out; degrading',
        );
        req.destroy(new Error('second-brain request timeout'));
        done(DEGRADED_OUTCOME);
      });

      // Hard overall deadline: bounds total time even if the socket stays
      // active (slow trickle) so the chat path always resolves within budget.
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        logger.warn(
          { path, timeoutMs: this.timeoutMs },
          'second-brain: overall deadline exceeded; degrading',
        );
        req.destroy(new Error('second-brain overall deadline'));
        done(DEGRADED_OUTCOME);
      }, this.timeoutMs);

      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
