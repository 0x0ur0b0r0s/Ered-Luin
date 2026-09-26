import { createHash, randomUUID } from 'node:crypto';
import type {
  LedgerErrorCode,
  NansenCreditLedger,
  NansenOperation,
  NansenOutcome,
} from './index.js';

export const NANSEN_API_ORIGIN = 'https://api.nansen.ai' as const;
export const NANSEN_ENDPOINT_PATHS = Object.freeze({
  TOKEN_SCREENER: '/api/v1/token-screener',
  FLOW_INTELLIGENCE: '/api/v1/tgm/flow-intelligence',
  SMART_MONEY_NETFLOW: '/api/v1/smart-money/netflow',
} as const);

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES = 20;
const MAX_REQUEST_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LEDGER_ERROR_CODES = new Set<LedgerErrorCode>([
  'INVALID_INPUT', 'DATABASE_PATH_INVALID', 'DATABASE_ALREADY_EXISTS', 'DATABASE_NOT_FOUND',
  'DATABASE_CORRUPT', 'UNSUPPORTED_SCHEMA_VERSION', 'UNKNOWN_COST_PROFILE', 'UNKNOWN_OPERATION',
  'CONFIGURATION_MISMATCH', 'BUDGET_EXHAUSTED', 'DUPLICATE_ATTEMPT_CONFLICT',
  'ATTEMPT_NOT_FOUND', 'COMPLETION_CONFLICT', 'ACCOUNTING_HALTED', 'INTEGER_OVERFLOW',
  'DATABASE_FAILURE', 'LEDGER_CLOSED',
]);

export type NansenClientErrorCode =
  | 'DISABLED' | 'CREDENTIAL_MISSING' | 'INVALID_CONFIGURATION' | 'INVALID_REQUEST'
  | 'RESERVATION_DENIED' | 'DUPLICATE_ATTEMPT' | 'TRANSPORT_ERROR' | 'TIMEOUT'
  | 'CANCELLED' | 'RESPONSE_TOO_LARGE' | 'INVALID_RESPONSE' | 'HTTP_ERROR'
  | 'LEDGER_RECORD_FAILED';

const CLIENT_ERROR_MESSAGES: Record<NansenClientErrorCode, string> = {
  DISABLED: 'Nansen requests are disabled.',
  CREDENTIAL_MISSING: 'Nansen API credential is unavailable.',
  INVALID_CONFIGURATION: 'Nansen client configuration is invalid.',
  INVALID_REQUEST: 'Nansen request is invalid.',
  RESERVATION_DENIED: 'The credit ledger did not grant this request.',
  DUPLICATE_ATTEMPT: 'The credit ledger denied a duplicate dispatch attempt.',
  TRANSPORT_ERROR: 'Nansen transport failed after a reservation was committed.',
  TIMEOUT: 'Nansen request timed out after a reservation was committed.',
  CANCELLED: 'Nansen request was cancelled after a reservation was committed.',
  RESPONSE_TOO_LARGE: 'Nansen response exceeded the configured size limit.',
  INVALID_RESPONSE: 'Nansen response was not valid JSON for the requested endpoint.',
  HTTP_ERROR: 'Nansen returned a non-success HTTP status.',
  LEDGER_RECORD_FAILED: 'The credit ledger could not record the known request outcome.',
};

export class NansenClientError extends Error {
  readonly code: NansenClientErrorCode;
  readonly attemptId: string | null;
  readonly status: number | null;
  readonly providerRequestId: string | null;
  readonly chargedCredits: number | null;
  readonly ledgerCode: LedgerErrorCode | null;

  constructor(
    code: NansenClientErrorCode,
    details: {
      attemptId?: string | null;
      status?: number | null;
      providerRequestId?: string | null;
      chargedCredits?: number | null;
      ledgerCode?: LedgerErrorCode | null;
    } = {},
  ) {
    super(CLIENT_ERROR_MESSAGES[code]);
    this.name = 'NansenClientError';
    this.code = code;
    this.attemptId = details.attemptId ?? null;
    this.status = details.status ?? null;
    this.providerRequestId = details.providerRequestId ?? null;
    this.chargedCredits = details.chargedCredits ?? null;
    this.ledgerCode = details.ledgerCode ?? null;
  }
}

export interface NansenHttpRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<{
    apikey: string;
    accept: 'application/json';
    'content-type': 'application/json';
  }>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: 'error';
  readonly maxResponseBytes: number;
}

export interface NansenHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type NansenHttpTransport = (request: NansenHttpRequest) => Promise<NansenHttpResponse>;

export interface NansenCallOptions {
  readonly signal?: AbortSignal;
  /** Per-query page limit; it cannot exceed the bound fixed when the client is created. */
  readonly maxPages?: number;
}

export interface NansenClientOptions {
  readonly ledger: NansenCreditLedger;
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly transport?: NansenHttpTransport;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxPages?: number;
}

export interface NansenAttemptMetadata {
  readonly attemptId: string;
  readonly status: number;
  readonly providerRequestId: string | null;
  readonly chargedCredits: number | null;
}

export interface GuardedResponse<T> extends NansenAttemptMetadata {
  readonly value: T;
}

export type GuardedPost = <T>(
  operation: NansenOperation,
  body: Readonly<Record<string, unknown>>,
  parse: (value: unknown) => T,
  callOptions?: NansenCallOptions,
) => Promise<GuardedResponse<T>>;

export interface NormalizedClientOptions {
  readonly ledger: NansenCreditLedger;
  readonly enabled: boolean;
  readonly apiKey: string | null;
  readonly transport: NansenHttpTransport;
  readonly provenance: 'nansen' | 'synthetic';
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxPages: number;
}

class TransportAbort extends Error {}
class ResponseReadFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly headers: Readonly<Record<string, string>>,
  ) { super(); }
}
class ResponseLimitExceeded extends Error {
  constructor(
    readonly status: number | null,
    readonly headers: Readonly<Record<string, string>>,
  ) { super(); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptions(value: unknown): NormalizedClientOptions {
  if (!isRecord(value)) throw new NansenClientError('INVALID_CONFIGURATION');
  const allowed = ['ledger', 'enabled', 'apiKey', 'transport', 'timeoutMs', 'maxResponseBytes', 'maxPages'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new NansenClientError('INVALID_CONFIGURATION');
  }
  const ledger = value.ledger as NansenCreditLedger | undefined;
  if (
    !ledger ||
    typeof ledger.reserveAttempt !== 'function' ||
    typeof ledger.recordTerminalResult !== 'function'
  ) throw new NansenClientError('INVALID_CONFIGURATION');

  const enabled = value.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new NansenClientError('INVALID_CONFIGURATION');
  const apiKey = value.apiKey;
  if (
    apiKey !== undefined &&
    (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4_096 || /\s/u.test(apiKey))
  ) throw new NansenClientError('INVALID_CONFIGURATION');
  const providedTransport = value.transport;
  if (providedTransport !== undefined && typeof providedTransport !== 'function') throw new NansenClientError('INVALID_CONFIGURATION');
  const transport = providedTransport === undefined ? fetchTransport : providedTransport as NansenHttpTransport;

  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) throw new NansenClientError('INVALID_CONFIGURATION');
  const maxResponseBytes = value.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    typeof maxResponseBytes !== 'number' ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) throw new NansenClientError('INVALID_CONFIGURATION');
  const maxPages = value.maxPages ?? DEFAULT_MAX_PAGES;
  if (
    typeof maxPages !== 'number' ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_PAGES
  ) throw new NansenClientError('INVALID_CONFIGURATION');

  return Object.freeze({
    ledger,
    enabled,
    apiKey: typeof apiKey === 'string' ? apiKey : null,
    transport,
    provenance: providedTransport === undefined ? 'nansen' : 'synthetic',
    timeoutMs,
    maxResponseBytes,
    maxPages,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new NansenClientError('INVALID_REQUEST');
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NansenClientError('INVALID_REQUEST');
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new NansenClientError('INVALID_REQUEST');
    return serialized;
  }
  if (Array.isArray(value)) return '[' + value.map((part) => canonicalJson(part)).join(',') + ']';
  if (!isRecord(value)) throw new NansenClientError('INVALID_REQUEST');
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => {
    const part = value[key];
    if (part === undefined) throw new NansenClientError('INVALID_REQUEST');
    return JSON.stringify(key) + ':' + canonicalJson(part);
  }).join(',') + '}';
}

function requestFingerprint(operation: NansenOperation, jsonBody: string): string {
  const path = NANSEN_ENDPOINT_PATHS[operation];
  return createHash('sha256')
    .update(canonicalJson({ method: 'POST', path, operation, body: JSON.parse(jsonBody) }))
    .digest('hex');
}

function safeLedgerCode(error: unknown): LedgerErrorCode | null {
  if (!isRecord(error) || typeof error.code !== 'string') return null;
  return LEDGER_ERROR_CODES.has(error.code as LedgerErrorCode) ? error.code as LedgerErrorCode : null;
}

function safeHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (!key) return null;
  const value = headers[key];
  return typeof value === 'string' ? value : null;
}

function safeProviderRequestId(headers: Readonly<Record<string, string>>): string | null {
  const value = safeHeader(headers, 'x-request-id');
  return value !== null && REQUEST_ID.test(value) ? value : null;
}

function documentedChargedCredits(headers: Readonly<Record<string, string>>): number | null {
  const value = safeHeader(headers, 'x-nansen-credits-used');
  if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599;
}

function knownResponseHeaders(response: Response): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const name of ['x-request-id', 'x-nansen-credits-used']) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return Object.freeze(headers);
}
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^(0|[1-9][0-9]*)$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maxBytes) {
      try { await response.body?.cancel(); } catch { /* Do not expose provider stream errors. */ }
      throw new ResponseLimitExceeded(validStatus(response.status) ? response.status : null, knownResponseHeaders(response));
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        try { await reader.cancel(); } catch { /* Preserve the bounded-size failure. */ }
        throw new ResponseLimitExceeded(validStatus(response.status) ? response.status : null, knownResponseHeaders(response));
      }
      chunks.push(next.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* Stream may already be closed. */ }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function fetchTransport(request: NansenHttpRequest): Promise<NansenHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      apikey: request.headers.apikey,
      accept: request.headers.accept,
      'content-type': request.headers['content-type'],
    },
    body: request.body,
    signal: request.signal,
    redirect: request.redirect,
  });
  const headers = knownResponseHeaders(response);
  if (response.status < 200 || response.status >= 300) {
    try { await response.body?.cancel(); } catch { /* Provider error bodies are never retained. */ }
    return { status: response.status, headers, body: new Uint8Array() };
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBody(response, request.maxResponseBytes);
  } catch (error) {
    if (error instanceof ResponseLimitExceeded) throw error;
    throw new ResponseReadFailure(
      validStatus(response.status) ? response.status : null,
      headers,
    );
  }
  return { status: response.status, headers, body };
}
function validateRequestBody(body: Readonly<Record<string, unknown>>): string {
  let json: string;
  try { json = canonicalJson(body); }
  catch (error) {
    if (error instanceof NansenClientError) throw error;
    throw new NansenClientError('INVALID_REQUEST');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) {
    throw new NansenClientError('INVALID_REQUEST');
  }
  return json;
}

export function createGuardedPost(
  options: NansenClientOptions,
  attemptIdFactory: () => string = randomUUID,
): { readonly post: GuardedPost; readonly maxPages: number; readonly provenance: 'nansen' | 'synthetic' } {
  const config = normalizeOptions(options);
  if (typeof attemptIdFactory !== 'function') throw new NansenClientError('INVALID_CONFIGURATION');
  const post: GuardedPost = async <T>(
    operation: NansenOperation,
    body: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
    callOptions: NansenCallOptions = {},
  ): Promise<GuardedResponse<T>> => {
    if (!config.enabled) throw new NansenClientError('DISABLED');
    if (config.apiKey === null) throw new NansenClientError('CREDENTIAL_MISSING');
    if (!Object.hasOwn(NANSEN_ENDPOINT_PATHS, operation)) throw new NansenClientError('INVALID_REQUEST');
    if (callOptions.signal !== undefined && !(callOptions.signal instanceof AbortSignal)) {
      throw new NansenClientError('INVALID_REQUEST');
    }
    if (callOptions.signal?.aborted) throw new NansenClientError('CANCELLED');
    const jsonBody = validateRequestBody(body);
    let attemptId: string;
    try { attemptId = attemptIdFactory(); }
    catch { throw new NansenClientError('INVALID_CONFIGURATION'); }
    if (typeof attemptId !== 'string' || !IDENTIFIER.test(attemptId)) {
      throw new NansenClientError('INVALID_CONFIGURATION');
    }

    const fingerprint = requestFingerprint(operation, jsonBody);
    let grant;
    try {
      grant = config.ledger.reserveAttempt({
        attemptId,
        operation,
        requestFingerprint: fingerprint,
      });
    } catch (error) {
      throw new NansenClientError('RESERVATION_DENIED', { ledgerCode: safeLedgerCode(error) });
    }
    if (!grant.dispatchGranted) {
      throw new NansenClientError('DUPLICATE_ATTEMPT', { attemptId });
    }

    const abortController = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const externalSignal = callOptions.signal;
    const cancel = () => {
      cancelled = true;
      abortController.abort();
    };
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener('abort', cancel, { once: true });
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, config.timeoutMs);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortController.signal.addEventListener('abort', () => reject(new TransportAbort()), { once: true });
    });

    const finalize = (
      outcome: NansenOutcome,
      details: {
        status?: number | null;
        providerRequestId?: string | null;
        chargedCredits?: number | null;
      } = {},
    ): void => {
      try {
        config.ledger.recordTerminalResult({
          attemptId,
          outcome,
          httpStatus: details.status ?? null,
          providerRequestId: details.providerRequestId ?? null,
          chargedCredits: details.chargedCredits ?? null,
        });
      } catch (error) {
        throw new NansenClientError('LEDGER_RECORD_FAILED', {
          attemptId,
          status: details.status ?? null,
          providerRequestId: details.providerRequestId ?? null,
          chargedCredits: details.chargedCredits ?? null,
          ledgerCode: safeLedgerCode(error),
        });
      }
    };

    const request: NansenHttpRequest = Object.freeze({
      url: NANSEN_API_ORIGIN + NANSEN_ENDPOINT_PATHS[operation],
      method: 'POST',
      headers: Object.freeze({
        apikey: config.apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
      }),
      body: jsonBody,
      signal: abortController.signal,
      redirect: 'error',
      maxResponseBytes: config.maxResponseBytes,
    });

    try {
      if (abortController.signal.aborted) {
        finalize('CANCELLED');
        throw new NansenClientError('CANCELLED', { attemptId });
      }
      let response: NansenHttpResponse;
      try {
        response = await Promise.race([
          Promise.resolve().then(() => config.transport(request)),
          abortPromise,
        ]);
      } catch (error) {
        if (error instanceof ResponseLimitExceeded) {
          const providerRequestId = safeProviderRequestId(error.headers);
          const chargedCredits = documentedChargedCredits(error.headers);
          finalize('RESPONSE_ERROR', {
            status: error.status,
            providerRequestId,
            chargedCredits,
          });
          throw new NansenClientError('RESPONSE_TOO_LARGE', {
            attemptId,
            status: error.status,
            providerRequestId,
            chargedCredits,
          });
        }
        const readFailure = error instanceof ResponseReadFailure ? error : null;
        const responseDetails: { status: number | null; providerRequestId: string | null; chargedCredits: number | null } = readFailure === null ? { status: null, providerRequestId: null, chargedCredits: null } : {
          status: readFailure.status,
          providerRequestId: safeProviderRequestId(readFailure.headers),
          chargedCredits: documentedChargedCredits(readFailure.headers),
        };
        if (timedOut) {
          finalize('TRANSPORT_ERROR', responseDetails);
          throw new NansenClientError('TIMEOUT', {
            attemptId,
            status: responseDetails.status,
            providerRequestId: responseDetails.providerRequestId,
            chargedCredits: responseDetails.chargedCredits,
          });
        }
        if (cancelled) {
          finalize('CANCELLED', responseDetails);
          throw new NansenClientError('CANCELLED', {
            attemptId,
            status: responseDetails.status,
            providerRequestId: responseDetails.providerRequestId,
            chargedCredits: responseDetails.chargedCredits,
          });
        }
        finalize('TRANSPORT_ERROR', responseDetails);
        throw new NansenClientError('TRANSPORT_ERROR', {
          attemptId,
          status: responseDetails.status,
          providerRequestId: responseDetails.providerRequestId,
          chargedCredits: responseDetails.chargedCredits,
        });
      }

      if (!isRecord(response)) {
        finalize('RESPONSE_ERROR');
        throw new NansenClientError('INVALID_RESPONSE', { attemptId });
      }
      const responseHeaders = isRecord(response.headers) ? response.headers : {};
      const responseStatus = validStatus(response.status) ? response.status : null;
      const providerRequestId = safeProviderRequestId(responseHeaders);
      const chargedCredits = documentedChargedCredits(responseHeaders);
      if (
        responseStatus === null ||
        !(response.body instanceof Uint8Array) ||
        !isRecord(response.headers)
      ) {
        finalize('RESPONSE_ERROR', {
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
        throw new NansenClientError('INVALID_RESPONSE', {
          attemptId,
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
      }
      if (response.body.byteLength > config.maxResponseBytes) {
        finalize('RESPONSE_ERROR', {
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
        throw new NansenClientError('RESPONSE_TOO_LARGE', {
          attemptId,
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
      }
      if (responseStatus < 200 || responseStatus >= 300) {
        finalize('HTTP_ERROR', {
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
        throw new NansenClientError('HTTP_ERROR', {
          attemptId,
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
      }

      let value: T;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
        value = parse(JSON.parse(text) as unknown);
      } catch {
        finalize('RESPONSE_ERROR', {
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
        throw new NansenClientError('INVALID_RESPONSE', {
          attemptId,
          status: responseStatus,
          providerRequestId,
          chargedCredits,
        });
      }
      finalize('SUCCESS', {
        status: responseStatus,
        providerRequestId,
        chargedCredits,
      });
      return {
        value,
        attemptId,
        status: responseStatus,
        providerRequestId,
        chargedCredits,
      };
    } finally {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener('abort', cancel);
    }
  };
  return Object.freeze({ post, maxPages: config.maxPages, provenance: config.provenance });
}
