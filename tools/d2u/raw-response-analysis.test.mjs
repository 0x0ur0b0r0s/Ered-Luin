import { describe, expect, it } from 'vitest';
import { analyzeRawD2uResponse } from './raw-response-analysis.mjs';

const address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const bytes = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const absentNormalizer = {
  parserFailureCode: null,
  diagnosticRows: [{ asset: 'USDC', presence: 'absent', fields: [{ name: 'price_usd', state: 'absent' }] }],
  usdcSignals: [
    { asset: 'USDC', metric: 'market_cap_usd', quality: 'MISSING', value: null },
    { asset: 'USDC', metric: 'price_usd', quality: 'MISSING', value: null },
  ],
};

describe('D2u bounded raw-response attribution', () => {
  it('distinguishes a successful empty data array from synthesized missing signals', () => {
    const report = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { page: 1, per_page: 100, is_last_page: true } }), normalizer: absentNormalizer });
    expect(report).toMatchObject({ classification: 'raw-provider-omission', reasonCode: 'NO_USDC_ADDRESS_OR_DATA_ROW_IN_RESPONSE',
      providerReturnedAddress: false, providerReturnedUsdcDataRow: false, normalizerProducedUsdcDataRow: false,
      raw: { directContainers: { data: { type: 'array', itemCount: 0 } } },
      normalizer: { selectedContainer: '/data', adapterUsdcPresence: 'absent', usdcSignalCount: 2, synthesizedPlaceholderSignalCount: 2 } });
  });

  it.each([
    ['is_last_page=false', { is_last_page: false }],
    ['has_more=true', { has_more: true }],
    ['snake-case next cursor', { next_cursor: 'continuation' }],
    ['camel-case next cursor', { nextCursor: 'continuation' }],
    ['snake-case next page cursor', { next_page_cursor: 'continuation' }],
    ['camel-case next page cursor', { nextPageCursor: 'continuation' }],
    ['snake-case next token', { next_token: 'continuation' }],
    ['camel-case next token', { nextToken: 'continuation' }],
    ['snake-case continuation token', { continuation_token: 'continuation' }],
    ['camel-case continuation token', { continuationToken: 'continuation' }],
    ['snake-case cursor id', { next_cursor_id: 'continuation' }],
    ['camel-case cursor id', { nextCursorId: 'continuation' }],
    ['snake-case page token', { next_page_token: 'continuation' }],
    ['camel-case page token', { nextPageToken: 'continuation' }],
    ['snake-case cursor next', { cursor_next: 'continuation' }],
    ['camel-case cursor next', { cursorNext: 'continuation' }],
    ['snake-case next page', { next_page: 2 }],
    ['camel-case next page', { nextPage: 2 }],
    ['page totals', { page: 1, totalPages: 2 }],
  ])('keeps an empty page indeterminate when pagination is partial: %s', (_name, pagination) => {
    const report = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination }), normalizer: absentNormalizer });
    expect(report).toMatchObject({ classification: 'indeterminate', reasonCode: 'PAGINATION_INCOMPLETE',
      raw: { paginationCompleteness: 'partial' } });
  });

  it('rejects contradictory pagination and unknown page-only metadata', () => {
    const contradictory = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { is_last_page: true, has_more: true } }), normalizer: absentNormalizer });
    expect(contradictory).toMatchObject({ classification: 'indeterminate', reasonCode: 'PAGINATION_CONTRADICTORY',
      raw: { paginationCompleteness: 'contradictory' } });
    const cursorContradiction = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { is_last_page: true, next_token: 'continuation' } }), normalizer: absentNormalizer });
    expect(cursorContradiction).toMatchObject({ classification: 'indeterminate', reasonCode: 'PAGINATION_CONTRADICTORY',
      raw: { paginationCompleteness: 'contradictory' } });
    const unknown = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { page: 1, per_page: 100 } }), normalizer: absentNormalizer });
    expect(unknown).toMatchObject({ classification: 'indeterminate', reasonCode: 'PAGINATION_COMPLETENESS_UNKNOWN',
      raw: { paginationCompleteness: 'unknown' } });
    const unknownCursor = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { cursor: 'continuation' } }), normalizer: absentNormalizer });
    expect(unknownCursor).toMatchObject({ classification: 'indeterminate', reasonCode: 'PAGINATION_COMPLETENESS_UNKNOWN',
      raw: { paginationCompleteness: 'unknown' } });
  });

  it.each([
    ['has_more=false', { has_more: false }],
    ['next_cursor=null', { next_cursor: null }],
    ['nextCursor empty', { nextCursor: '' }],
    ['final page count', { page: 2, total_pages: 2 }],
  ])('accepts explicit terminal pagination evidence: %s', (_name, pagination) => {
    const report = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination }), normalizer: absentNormalizer });
    expect(report).toMatchObject({ classification: 'raw-provider-omission', reasonCode: 'NO_USDC_ADDRESS_OR_DATA_ROW_IN_RESPONSE',
      raw: { paginationCompleteness: 'complete' } });
  });
  it('does not call a returned row with missing price a provider row omission', () => {
    const row = { chain: 'base', token_address: address, token_symbol: 'USDC' };
    const report = analyzeRawD2uResponse({ bytes: bytes({ data: [row], pagination: { page: 1, per_page: 100, is_last_page: true } }), normalizer: {
      parserFailureCode: null,
      diagnosticRows: [{ asset: 'USDC', presence: 'present', fields: [{ name: 'price_usd', state: 'absent' }] }],
      usdcSignals: [{ asset: 'USDC', metric: 'price_usd', quality: 'PARTIAL', value: null }],
    } });
    expect(report).toMatchObject({ classification: 'indeterminate', reasonCode: 'USDC_ROW_PRESENT_PRICE_MISSING_OR_INVALID',
      providerReturnedAddress: true, providerReturnedUsdcDataRow: true, normalizerProducedUsdcDataRow: true,
      normalizer: { sourceRows: [{ path: '/data/0', container: 'data', addressField: 'token_address', chainMatches: true, priceFieldState: 'absent' }] } });
    expect(report.normalizer.sourceRows[0].rawObjectReference).toBe('raw-response#/data/0');
  });

  it('identifies a real row in an alternative response container that the production adapter rejected', () => {
    const report = analyzeRawD2uResponse({ bytes: bytes({ results: [{ chain: 'base', token_address: address, token_symbol: 'USDC', price_usd: 1 }], pagination: { page: 1, per_page: 100 } }),
      normalizer: { parserFailureCode: 'INVALID_RESPONSE', diagnosticRows: [], usdcSignals: [] } });
    expect(report).toMatchObject({ classification: 'normalization-omission', reasonCode: 'USDC_ROW_NOT_ACCEPTED_BY_PRODUCTION_NORMALIZER',
      providerReturnedAddress: true, providerReturnedUsdcDataRow: true, normalizerProducedUsdcDataRow: false,
      raw: { candidateContainers: [{ path: '/results', name: 'results', itemCount: 1 }] },
      normalizer: { selectedContainer: '/data', parserFailureCode: 'INVALID_RESPONSE', sourceRows: [{ path: '/results/0' }] } });
  });

  it('classifies an address in an asset-specific warning separately from an address echoed in the request', () => {
    const warning = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { page: 1, per_page: 100 }, warnings: [`Unsupported token ${address}`] }), normalizer: absentNormalizer });
    expect(warning.classification).toBe('per-asset-provider-error');
    expect(warning.reasonCode).toBe('PROVIDER_REPORTED_UNSUPPORTED_ASSET');
    expect(warning.raw.addressOccurrences).toContainEqual(expect.objectContaining({ classification: 'error-warning' }));
    const echo = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { page: 1, per_page: 100, is_last_page: true }, query: { token_address: address } }), normalizer: absentNormalizer });
    expect(echo).toMatchObject({ classification: 'raw-provider-omission', reasonCode: 'NO_USDC_DATA_ROW_ADDRESS_ECHO_ONLY', providerReturnedAddress: true, providerReturnedUsdcDataRow: false });
    expect(echo.raw.addressOccurrences).toContainEqual(expect.objectContaining({ classification: 'request-echo' }));
  });

  it('keeps invalid JSON and truncated captures indeterminate while preserving parser diagnostics', () => {
    const normalizer = { parserFailureCode: 'INVALID_RESPONSE', diagnosticRows: [], usdcSignals: [
      { asset: 'USDC', metric: 'price_usd', quality: 'MISSING', value: null },
    ] };
    const invalid = analyzeRawD2uResponse({ bytes: bytes('{"data":['), normalizer });
    expect(invalid).toMatchObject({ classification: 'indeterminate', reasonCode: 'RAW_JSON_INVALID', normalizer: { parserFailureCode: 'INVALID_RESPONSE', usdcSignalCount: 1, synthesizedPlaceholderSignalCount: 1 } });
    const truncated = analyzeRawD2uResponse({ bytes: bytes('{"data":[]}'), complete: false, normalizer });
    expect(truncated).toMatchObject({ classification: 'indeterminate', reasonCode: 'CAPTURE_TRUNCATED', normalizer: { parserFailureCode: 'INVALID_RESPONSE', usdcSignalCount: 1 } });
  });

  it('attributes a valid normalized Base USDC row without treating it as omission', () => {
    const row = { chain: 'base', token_address: address, token_symbol: 'USDC', price_usd: 1, private_key: 'SYNTHETIC_SECRET' };
    const report = analyzeRawD2uResponse({ bytes: bytes({ data: [row], pagination: { page: 1, per_page: 100, is_last_page: true } }), normalizer: {
      parserFailureCode: null, diagnosticRows: [{ asset: 'USDC', presence: 'present', fields: [{ name: 'price_usd', state: 'numeric' }] }],
      usdcSignals: [{ asset: 'USDC', metric: 'price_usd', quality: 'COMPLETE', value: '1000000' }],
    } });
    expect(report).toMatchObject({ classification: 'indeterminate', reasonCode: 'USDC_ROW_AND_PRICE_PRESENT',
      providerReturnedAddress: true, providerReturnedUsdcDataRow: true, normalizerProducedUsdcDataRow: true,
      raw: { candidateContainers: [{ path: '/data', itemCount: 1 }] },
      normalizer: { adapterUsdcPresence: 'present', usdcSignalCount: 1, synthesizedPlaceholderSignalCount: 0 } });
    expect(report.normalizer.sourceRows[0].fieldNames).toContain('token_address');
    expect(report.normalizer.sourceRows[0].fieldNames).not.toContain('private_key');
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_SECRET');
  });

  it('finds nested candidate rows but keeps an informational warning distinct from an asset error', () => {
    const nested = analyzeRawD2uResponse({ bytes: bytes({ data: [{ chain: 'base', tokens: [{ chain: 'base', token_address: address, price_usd: 1 }] }],
      pagination: { page: 1, per_page: 100 }, warnings: ['Observed query for ' + address] }), normalizer: {
      parserFailureCode: 'INVALID_RESPONSE', diagnosticRows: [], usdcSignals: [],
    } });
    expect(nested).toMatchObject({ classification: 'normalization-omission', providerReturnedAddress: true, providerReturnedUsdcDataRow: true,
      raw: { candidateContainers: expect.arrayContaining([expect.objectContaining({ path: '/data/0/tokens', name: 'tokens', itemCount: 1 })]), addressOccurrences: expect.arrayContaining([expect.objectContaining({ classification: 'error-warning', kind: 'warning' })]) } });
    const error = analyzeRawD2uResponse({ bytes: bytes({ data: [], pagination: { page: 1, per_page: 100 }, error: { message: 'Unsupported token ' + address + '; secret do-not-print' } }), normalizer: absentNormalizer });
    expect(error).toMatchObject({ classification: 'per-asset-provider-error', reasonCode: 'PROVIDER_REPORTED_UNSUPPORTED_ASSET' });
    expect(JSON.stringify(error)).not.toContain('secret do-not-print');
  });

  it('reports container shape and warning presence without exposing secret-bearing text or values', () => {
    const report = analyzeRawD2uResponse({ bytes: bytes({ data: { token: address }, pagination: {}, error: { message: 'private-key-value do-not-print' }, provider_extra: { opaque: 'raw-private-value' } }), normalizer: absentNormalizer });
    const serialized = JSON.stringify(report);
    expect(report).toMatchObject({ classification: 'indeterminate', reasonCode: 'PROVIDER_WARNING_OR_ERROR_NOT_ASSET_SPECIFIC', raw: { directContainers: { data: { type: 'object' } }, topLevelKeys: ['data', 'pagination', 'error', 'provider_extra'] } });
    expect(serialized).not.toContain('private-key-value');
    expect(serialized).not.toContain('raw-private-value');
    const missing = analyzeRawD2uResponse({ bytes: bytes({ pagination: {} }), normalizer: { parserFailureCode: 'INVALID_RESPONSE', diagnosticRows: [], usdcSignals: [] } });
    expect(missing.raw.directContainers.data).toEqual({ type: 'missing' });
    expect(missing.classification).toBe('indeterminate');
  });
});