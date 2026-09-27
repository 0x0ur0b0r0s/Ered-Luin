import { createHash } from 'node:crypto';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 8;
const MAX_NODES = 12_000;
const MAX_ARRAY_ITEMS = 500;
const CANDIDATE_CONTAINERS = new Set(['data', 'results', 'tokens', 'prices', 'items', 'rows']);
const ADDRESS_FIELDS = new Set(['token_address', 'tokenAddress', 'address']);
const ERROR_KEYS = new Set(['error', 'errors', 'warning', 'warnings', 'issues']);
const REQUEST_KEYS = new Set(['request', 'query', 'filters', 'filter', 'params', 'parameters', 'echo']);
const ALLOWED_FAILURES = new Set(['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'HTTP_ERROR', 'TRANSPORT_ERROR', 'TIMEOUT', 'CANCELLED']);

function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (record(value)) return 'object';
  return typeof value;
}
function safeKey(value) { const text = String(value); return /^[A-Za-z0-9_$.-]{1,64}$/u.test(text) && !/(?:secret|password|credential|authorization|cookie|api[_-]?key|private)/iu.test(text) ? text : '<redacted-key>'; }
function safeFieldNames(keys) { return keys.slice(0, 100).map(safeKey); }
function pointer(path, key) { return path + '/' + safeKey(key).replace(/~/gu, '~0').replace(/\//gu, '~1'); }
function warningErrorKind(parentKey, ancestors) { const keys = ancestors.concat(parentKey).map((key) => String(key).toLowerCase()); if (keys.some((key) => ['error', 'errors', 'issues'].includes(key))) return 'error'; if (keys.some((key) => ['warning', 'warnings'].includes(key))) return 'warning'; return null; }
function fieldState(row, field) {
  if (!Object.hasOwn(row, field)) return 'absent';
  if (row[field] === null) return 'null';
  if (typeof row[field] === 'number' && Number.isFinite(row[field])) return 'numeric';
  return 'invalid';
}
function issueCode(value) {
  if (typeof value !== 'string') return null;
  const text = value.toLowerCase();
  if (/unsupported.{0,32}(asset|token)|(asset|token).{0,32}unsupported/u.test(text)) return 'UNSUPPORTED_ASSET';
  if (/invalid.{0,24}(asset|token|address)|(asset|token|address).{0,24}invalid/u.test(text)) return 'INVALID_TOKEN';
  if (/(?:(?:token|asset|address).{0,24}(?:not[_ -]?found|no[_ -]?data)|(?:not[_ -]?found|no[_ -]?data).{0,24}(?:token|asset|address))/u.test(text)) return 'ASSET_NOT_FOUND_OR_NO_DATA';
  return null;
}
function itemTypeCounts(array) {
  const counts = {};
  for (const item of array.slice(0, MAX_ARRAY_ITEMS)) {
    const type = typeOf(item);
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}
function directContainer(value, key) {
  if (!Object.hasOwn(value, key)) return { type: 'missing' };
  const item = value[key];
  return Array.isArray(item)
    ? { type: 'array', itemCount: item.length, itemTypes: itemTypeCounts(item) }
    : { type: typeOf(item) };
}
const LAST_PAGE_FLAGS = ['is_last_page', 'isLastPage'];
const HAS_MORE_FLAGS = ['has_more', 'hasMore', 'has_next_page', 'hasNextPage'];
const CURRENT_PAGE_FIELDS = ['page', 'current_page', 'currentPage'];
const TOTAL_PAGE_FIELDS = ['total_pages', 'totalPages', 'last_page', 'lastPage'];
const NEXT_PAGE_FIELDS = new Set(['next_page', 'nextPage']);
const NEXT_CURSOR_FIELDS = new Set(['next_cursor', 'nextCursor', 'next_token', 'nextToken', 'continuation_token', 'continuationToken', 'next_page_cursor', 'nextPageCursor',
  'next_cursor_id', 'nextCursorId', 'next_page_token', 'nextPageToken', 'cursor_next', 'cursorNext']);
function paginationCompleteness(value) {
  if (!record(value)) return 'unknown';
  const signals = [];
  let invalid = false;
  const add = (state) => signals.push(state);
  for (const key of LAST_PAGE_FLAGS) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'boolean') invalid = true;
    else add(value[key] ? 'complete' : 'partial');
  }
  for (const key of HAS_MORE_FLAGS) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'boolean') invalid = true;
    else add(value[key] ? 'partial' : 'complete');
  }
  const numericAliases = (keys) => {
    const values = keys.filter((key) => Object.hasOwn(value, key)).map((key) => value[key]);
    if (values.length === 0) return { present: false, valid: true, value: null };
    const valid = values.every((item) => Number.isSafeInteger(item) && item >= 1);
    return { present: true, valid: valid && new Set(values).size === 1, value: valid ? values[0] : null };
  };
  const page = numericAliases(CURRENT_PAGE_FIELDS);
  const totalPages = numericAliases(TOTAL_PAGE_FIELDS);
  if (!page.valid || !totalPages.valid) invalid = true;
  if (page.present && totalPages.present && page.valid && totalPages.valid) {
    if (page.value > totalPages.value) invalid = true;
    else add(page.value === totalPages.value ? 'complete' : 'partial');
  }
  for (const key of NEXT_PAGE_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (item === null || item === '' || item === false || item === 0) add('complete');
    else if ((typeof item === 'number' && Number.isSafeInteger(item) && item > 0) ||
        (typeof item === 'string' && item.length > 0)) add('partial');
    else invalid = true;
  }
  for (const key of NEXT_CURSOR_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (item === null || item === '') add('complete');
    else if ((typeof item === 'string' && item.length > 0) || (typeof item === 'number' && Number.isFinite(item)) || record(item) || Array.isArray(item)) add('partial');
    else invalid = true;
  }
  if (Object.keys(value).some((key) => /(?:cursor|token|continuation)/iu.test(key) && !NEXT_CURSOR_FIELDS.has(key))) invalid = true;
  if (new Set(signals).size > 1) return 'contradictory';
  if (invalid || signals.length === 0) return 'unknown';
  return signals[0];
}function addressField(row, wanted) {
  return [...ADDRESS_FIELDS].find((name) => typeof row[name] === 'string' && row[name].toLowerCase() === wanted) ?? null;
}
function candidateRow(row, parentName, wanted) {
  if (!record(row) || !CANDIDATE_CONTAINERS.has(parentName)) return null;
  const matchedAddressField = addressField(row, wanted);
  if (!matchedAddressField) return null;
  const chainField = ['chain', 'chain_name', 'chainName'].find((name) => typeof row[name] === 'string') ?? null;
  const chainMatches = chainField !== null && String(row[chainField]).toLowerCase() === 'base';
  return Object.freeze({
    addressField: matchedAddressField,
    chainField,
    chainMatches,
    path: null,
    container: parentName,
    fieldNames: safeFieldNames(Object.keys(row)),
    priceFieldState: fieldState(row, 'price_usd'),
  });
}

function safeNormalizerSummary(normalizer, sourceRows = []) {
  const parserFailureCode = ALLOWED_FAILURES.has(normalizer?.parserFailureCode) ? normalizer.parserFailureCode : null;
  const diagnosticRows = Array.isArray(normalizer?.diagnosticRows) ? normalizer.diagnosticRows : [];
  const usdcDiagnostic = diagnosticRows.find((row) => row?.asset === 'USDC') ?? null;
  const signals = Array.isArray(normalizer?.usdcSignals)
    ? normalizer.usdcSignals.filter((signal) => signal?.asset === 'USDC').slice(0, 32).map((signal) => ({ metric: signal.metric, quality: signal.quality, hasValue: signal.value !== null }))
    : [];
  return Object.freeze({ selectedContainer: '/data', parserFailureCode, sourceRows: Object.freeze(sourceRows.slice(0, 64)),
    adapterUsdcPresence: usdcDiagnostic?.presence ?? null, usdcSignalCount: signals.length,
    usdcSignals: Object.freeze(signals), synthesizedPlaceholderSignalCount: signals.filter((signal) => signal.quality === 'MISSING').length });
}

export function analyzeRawD2uResponse({ bytes, complete = true, normalizer = null, targetAddress = USDC_ADDRESS } = {}) {
  const empty = (reasonCode) => Object.freeze({
    classification: 'indeterminate', reasonCode, providerReturnedAddress: false,
    providerReturnedUsdcDataRow: false, normalizerProducedUsdcDataRow: normalizer === null ? null : false,
    raw: Object.freeze({ byteCount: bytes instanceof Uint8Array ? bytes.byteLength : null, sha256: bytes instanceof Uint8Array ? createHash('sha256').update(bytes).digest('hex') : null,
      topLevelKeys: [], directContainers: {}, candidateContainers: [], pagination: [], paginationCompleteness: 'unknown', addressOccurrences: [], errorWarningIndicators: [], traversalTruncated: false }),
    normalizer: safeNormalizerSummary(normalizer),
  });
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) return empty('CAPTURE_BYTES_INVALID_OR_OVER_LIMIT');
  if (complete !== true) return empty('CAPTURE_TRUNCATED');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return empty('CAPTURE_UTF8_INVALID'); }
  let root;
  try { root = JSON.parse(text); }
  catch { return empty('RAW_JSON_INVALID'); }
  if (!record(root)) return empty('RAW_JSON_ROOT_NOT_OBJECT');
  const wanted = typeof targetAddress === 'string' ? targetAddress.toLowerCase() : USDC_ADDRESS.toLowerCase();
  const topLevelKeys = safeFieldNames(Object.keys(root));
  const directContainers = Object.freeze(Object.fromEntries(['data', 'results', 'tokens', 'prices'].map((key) => [key, directContainer(root, key)])));
  const candidateContainers = [];
  const occurrences = [];
  const candidateRows = [];
  const pagination = [];
  const errorWarningIndicators = [];
  let visited = 0;
  let traversalTruncated = false;

  function walk(value, path, depth, parentKey, ancestorKeys, parentRow) {
    visited += 1;
    if (visited > MAX_NODES || depth > MAX_DEPTH) { traversalTruncated = true; return; }
    if (typeof value === 'string' && value.toLowerCase().includes(wanted)) {
      const underError = ancestorKeys.some((key) => ERROR_KEYS.has(key.toLowerCase()));
      const underRequest = ancestorKeys.some((key) => REQUEST_KEYS.has(key.toLowerCase()));
      occurrences.push(Object.freeze({ path: path.slice(0, 512), classification: underError ? 'error-warning' : underRequest ? 'request-echo' : parentRow ? 'candidate-data-row' : 'unknown', ...(underError ? { kind: warningErrorKind(parentKey, ancestorKeys) } : {}) }));
    }
    if (Array.isArray(value)) {
      if (CANDIDATE_CONTAINERS.has(parentKey)) {
        candidateContainers.push(Object.freeze({ path: path.slice(0, 512), name: parentKey, type: 'array', itemCount: value.length, itemTypes: itemTypeCounts(value) }));
      }
      const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
      if (value.length > limit) traversalTruncated = true;
      for (let index = 0; index < limit; index += 1) {
        const child = value[index];
        const childPath = pointer(path, index);
        const row = candidateRow(child, parentKey, wanted);
        if (row) candidateRows.push(Object.freeze({ ...row, path: childPath.slice(0, 512) }));
        walk(child, childPath, depth + 1, String(index), ancestorKeys.concat(parentKey), row !== null || parentRow);
      }
      return;
    }
    const underError = ERROR_KEYS.has(parentKey.toLowerCase()) || ancestorKeys.some((key) => ERROR_KEYS.has(key.toLowerCase()));
    if (!record(value) && !Array.isArray(value)) {
      if (typeof value === 'string' && underError) {
        const code = issueCode(value);
        errorWarningIndicators.push(Object.freeze({ path: path.slice(0, 512), type: 'string', length: value.length,
          kind: warningErrorKind(parentKey, ancestorKeys), mentionsAddress: value.toLowerCase().includes(wanted), ...(code ? { code } : {}) }));
      }
      return;
    }
    const keys = record(value) ? Object.keys(value) : [];
    if (underError) errorWarningIndicators.push(Object.freeze({ path: path.slice(0, 512), type: typeOf(value), kind: warningErrorKind(parentKey, ancestorKeys),
      ...(record(value) ? { fieldNames: safeFieldNames(keys).slice(0, 64) } : {}), mentionsAddress: record(value) && JSON.stringify(value).toLowerCase().includes(wanted) }));
    if (parentKey === 'pagination' || parentKey === 'pageInfo' || parentKey === 'page_info') {
      const safeFields = {};
      for (const key of keys.slice(0, 64)) {
        const item = value[key];
        if (['page', 'current_page', 'currentPage', 'per_page', 'perPage', 'total', 'total_pages', 'totalPages', 'last_page', 'lastPage', 'is_last_page', 'isLastPage', 'has_more', 'hasMore', 'has_next_page', 'hasNextPage'].includes(key) &&
          ((typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean')) safeFields[key] = item;
        else if (/cursor/iu.test(key)) safeFields[key] = { present: item !== null && item !== undefined, type: typeOf(item), ...(typeof item === 'string' ? { length: item.length } : {}) };
      }
      pagination.push(Object.freeze({ path: path.slice(0, 512), type: 'object', fieldNames: keys.slice(0, 64), safeFields: Object.freeze(safeFields) }));
    }
    if (!record(value)) {
      const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
      if (value.length > limit) traversalTruncated = true;
      for (let index = 0; index < limit; index += 1) walk(value[index], pointer(path, index), depth + 1, String(index), ancestorKeys.concat(parentKey), false);
      return;
    }
    for (const key of keys.slice(0, MAX_ARRAY_ITEMS)) walk(value[key], pointer(path, key), depth + 1, key, ancestorKeys.concat(key), parentRow);
    if (keys.length > MAX_ARRAY_ITEMS) traversalTruncated = true;
  }
  walk(root, '', 0, '', [], false);

  const normalizedFailure = ALLOWED_FAILURES.has(normalizer?.parserFailureCode) ? normalizer.parserFailureCode : null;
  const diagnosticsRows = Array.isArray(normalizer?.diagnosticRows) ? normalizer.diagnosticRows : [];
  const usdcDiagnostic = diagnosticsRows.find((row) => row?.asset === 'USDC') ?? null;
  const normalizerProduced = normalizer === null ? null : normalizedFailure !== null ? false : usdcDiagnostic?.presence === 'present' || usdcDiagnostic?.presence === 'duplicate';
  const sourceRows = candidateRows.map((row) => ({ ...row, rawObjectReference: 'raw-response#' + row.path }));
  const rawRows = candidateRows.filter((row) => row.chainMatches);
  const unverifiedRows = candidateRows.filter((row) => !row.chainMatches);
  const hasErrorForAsset = occurrences.some((entry) => entry.classification === 'error-warning' && entry.kind === 'error') || errorWarningIndicators.some((entry) =>
    ['UNSUPPORTED_ASSET', 'INVALID_TOKEN', 'ASSET_NOT_FOUND_OR_NO_DATA'].includes(entry.code) || (entry.kind === 'error' && entry.mentionsAddress === true));
  const hasUnattributedErrorWarning = errorWarningIndicators.length > 0 && !hasErrorForAsset;
  const unknownAddress = occurrences.some((entry) => entry.classification === 'unknown');
  const alternateCandidateRows = rawRows.some((row) => row.container !== 'data');
  const dataContainerValid = Array.isArray(root.data) && record(root.pagination);
  const pageCompleteness = paginationCompleteness(root.pagination);
  let classification = 'indeterminate';
  let reasonCode = 'UNRESOLVED_RESPONSE_SHAPE';
  if (normalizedFailure !== null && rawRows.length > 0) {
    classification = 'normalization-omission'; reasonCode = 'USDC_ROW_NOT_ACCEPTED_BY_PRODUCTION_NORMALIZER';
  } else if (rawRows.length > 0 && normalizer !== null && normalizerProduced === false) {
    classification = 'normalization-omission'; reasonCode = 'USDC_ROW_NOT_EMITTED_BY_PRODUCTION_NORMALIZER';
  } else if (hasErrorForAsset && rawRows.length === 0) {
    classification = 'per-asset-provider-error'; reasonCode = errorWarningIndicators.some((entry) => entry.code === 'UNSUPPORTED_ASSET') ? 'PROVIDER_REPORTED_UNSUPPORTED_ASSET' : 'PROVIDER_ERROR_REFERENCES_USDC';
  } else if (hasUnattributedErrorWarning) reasonCode = 'PROVIDER_WARNING_OR_ERROR_NOT_ASSET_SPECIFIC';
  else if (unverifiedRows.length > 0) reasonCode = 'USDC_ADDRESS_PRESENT_WITHOUT_BASE_CHAIN_IDENTITY';
  else if (dataContainerValid && rawRows.length === 0 && !alternateCandidateRows && !unknownAddress && !traversalTruncated && pageCompleteness === 'complete') {
    classification = 'raw-provider-omission'; reasonCode = occurrences.some((entry) => entry.classification === 'request-echo') ? 'NO_USDC_DATA_ROW_ADDRESS_ECHO_ONLY' : 'NO_USDC_ADDRESS_OR_DATA_ROW_IN_RESPONSE';  } else if (dataContainerValid && rawRows.length === 0 && !alternateCandidateRows && !unknownAddress && !traversalTruncated && pageCompleteness !== 'complete') {
    reasonCode = pageCompleteness === 'partial' ? 'PAGINATION_INCOMPLETE' : pageCompleteness === 'contradictory' ? 'PAGINATION_CONTRADICTORY' : 'PAGINATION_COMPLETENESS_UNKNOWN';
  } else if (rawRows.length > 0 && normalizerProduced === true) {
    classification = 'indeterminate'; reasonCode = rawRows.some((row) => row.priceFieldState !== 'numeric') ? 'USDC_ROW_PRESENT_PRICE_MISSING_OR_INVALID' : 'USDC_ROW_AND_PRICE_PRESENT';
  } else if (normalizedFailure !== null) reasonCode = 'PRODUCTION_NORMALIZER_REJECTED_CAPTURE';
  else if (!dataContainerValid) reasonCode = 'DOCUMENTED_DATA_OR_PAGINATION_CONTAINER_MISSING_OR_INVALID';
  else if (unknownAddress || traversalTruncated) reasonCode = 'ADDRESS_LOCATION_OR_RESPONSE_TRAVERSAL_AMBIGUOUS';

  const normalizerReport = safeNormalizerSummary(normalizer, sourceRows);
  return Object.freeze({
    classification,
    reasonCode,
    providerReturnedAddress: occurrences.length > 0,
    providerReturnedUsdcDataRow: rawRows.length > 0,
    normalizerProducedUsdcDataRow: normalizer === null ? null : normalizerProduced,
    raw: Object.freeze({
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      topLevelKeys: Object.freeze(topLevelKeys),
      directContainers,
      candidateContainers: Object.freeze(candidateContainers.slice(0, 128)),
      pagination: Object.freeze(pagination.slice(0, 16)), paginationCompleteness: pageCompleteness,
      addressOccurrences: Object.freeze(occurrences.slice(0, 128)),
      addressOccurrencesTruncated: occurrences.length > 128,
      errorWarningIndicators: Object.freeze(errorWarningIndicators.slice(0, 64)),
      traversalTruncated,
    }),
    normalizer: normalizerReport,
  });
}