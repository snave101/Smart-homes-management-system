/**
 * Pure helpers of the M-Pesa C2B integration: no I/O, no framework.
 * Everything that decides where money goes is here so it can be unit tested.
 */

export const MPESA_PAYMENT_TYPE = 'mobile_money';

/** Result codes Daraja understands in a validation response. */
export const ValidationCode = {
  ACCEPTED: '0',
  INVALID_ACCOUNT: 'C2B00012',
  INVALID_AMOUNT: 'C2B00013',
  INVALID_SHORTCODE: 'C2B00015',
  OTHER: 'C2B00016'
};

function asString(value, maxLength = 128) {
  if (typeof value === 'string') {
    return value.trim().slice(0, maxLength);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

/**
 * Splits a Daraja timestamp (YYYYMMDDHHmmss, East Africa Time) into its
 * parts. Returns null when the value is not a real date and time.
 */
function parseTransTime(transTime) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    transTime || ''
  );
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1);
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return null;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
}

/**
 * Sortable form (YYYY-MM-DDTHH:mm) of a Daraja timestamp. Both are wall-clock
 * values so no time zone conversion takes place.
 */
export function transTimeToDate(transTime) {
  const parts = parseTransTime(transTime);
  if (!parts) {
    return undefined;
  }
  const { year, month, day, hour, minute } = parts;
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** The format the payments of a rent are stored with: DD/MM/YYYY. */
export function toPaymentDate(transTime) {
  const parts = parseTransTime(transTime);
  return parts ? `${parts.day}/${parts.month}/${parts.year}` : undefined;
}

/**
 * Validates and normalizes the body Safaricom posts to the validation and
 * confirmation URLs. Amounts and short codes arrive as strings or numbers
 * depending on the API version.
 * Returns { ok: true, payment } or { ok: false, reason }.
 */
export function parseC2BPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'payload is not an object' };
  }

  const transId = asString(body.TransID, 32).toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(transId)) {
    return { ok: false, reason: 'invalid TransID' };
  }

  const rawAmount = asString(body.TransAmount, 32);
  const amount = Number(rawAmount);
  if (!/^\d+(\.\d+)?$/.test(rawAmount) || !Number.isFinite(amount)) {
    return { ok: false, reason: 'invalid TransAmount' };
  }
  if (amount <= 0) {
    return { ok: false, reason: 'TransAmount must be positive' };
  }

  const shortCode = asString(body.BusinessShortCode, 16);
  if (!/^\d{3,12}$/.test(shortCode)) {
    return { ok: false, reason: 'invalid BusinessShortCode' };
  }

  const transTime = asString(body.TransTime, 14);
  const paidAt = transTimeToDate(transTime);
  if (!paidAt) {
    return { ok: false, reason: 'invalid TransTime' };
  }

  const payerName = [body.FirstName, body.MiddleName, body.LastName]
    .map((part) => asString(part, 64))
    .filter(Boolean)
    .join(' ');

  return {
    ok: true,
    payment: {
      transId,
      transactionType: asString(body.TransactionType, 32),
      transTime,
      paidAt,
      // rounded to cents: M-Pesa never sends more precision
      amount: Math.round(amount * 100) / 100,
      shortCode,
      billRefNumber: asString(body.BillRefNumber, 64),
      invoiceNumber: asString(body.InvoiceNumber, 64),
      msisdn: asString(body.MSISDN, 128),
      payerName
    }
  };
}

/**
 * Account numbers are typed on a phone: compare them without case, spaces or
 * punctuation so "a-12", "A 12" and "A12" designate the same tenant.
 */
export function normalizeReference(reference) {
  return String(reference ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Finds the tenant an account number designates among candidates shaped
 * { _id, name, reference, active }. When a reference was reused the tenant
 * whose lease is still running wins; anything else is ambiguous and left for
 * the landlord to allocate.
 * Returns { kind: 'match', tenant } | { kind: 'none' } | { kind: 'ambiguous' }.
 */
export function matchTenant(candidates, billRefNumber) {
  const wanted = normalizeReference(billRefNumber);
  if (!wanted) {
    return { kind: 'none' };
  }
  const found = candidates.filter(
    (candidate) => normalizeReference(candidate.reference) === wanted
  );
  if (found.length === 0) {
    return { kind: 'none' };
  }
  if (found.length === 1) {
    return { kind: 'match', tenant: found[0] };
  }
  const active = found.filter((candidate) => candidate.active);
  if (active.length === 1) {
    return { kind: 'match', tenant: active[0] };
  }
  return { kind: 'ambiguous', count: found.length };
}

/** Rent terms are numbers shaped YYYYMMDDHH. */
export function termKeyOf(transTime) {
  return Number(String(transTime).slice(0, 10));
}

/**
 * Picks the rent a payment belongs to: the term in force when the money was
 * sent. A payment made before the lease starts goes to the first rent and one
 * made after it ended goes to the last rent, where the final balance is.
 * Works for every lease frequency because only term ordering is used.
 */
export function pickRentTerm(terms, paymentKey) {
  if (!terms || !terms.length) {
    return undefined;
  }
  const sorted = [...terms].sort((a, b) => a - b);
  let picked = sorted[0];
  for (const term of sorted) {
    if (term <= paymentKey) {
      picked = term;
    } else {
      break;
    }
  }
  return picked;
}

function isPaymentOf(payment, wantedReference) {
  return (
    payment?.type === MPESA_PAYMENT_TYPE &&
    normalizeReference(payment.reference) === wantedReference
  );
}

/** Finds the term holding a payment already recorded for this receipt. */
export function findPaymentTerm(rents, transId) {
  const wanted = normalizeReference(transId);
  return (rents || []).find((rent) =>
    (rent.payments || []).some((payment) => isPaymentOf(payment, wanted))
  )?.term;
}

/** The rent payment recorded for a transaction. */
export function toRentPayment({ transId, transTime, amount }) {
  return {
    date: toPaymentDate(transTime) || '',
    type: MPESA_PAYMENT_TYPE,
    reference: transId,
    amount
  };
}

/**
 * Extracts from a computed rent what the landlord (or M-Pesa) entered, in the
 * shape Contract.payTerm expects to recompute that rent.
 */
export function settlementOf(rent) {
  return {
    payments: (rent.payments || []).map((payment) => ({ ...payment })),
    debts: (rent.debts || []).map((debt) => ({ ...debt })),
    discounts: (rent.discounts || [])
      .filter((discount) => discount.origin === 'settlement')
      .map((discount) => ({ ...discount })),
    description: rent.description || ''
  };
}

export function withPayment(rent, payment) {
  const settlement = settlementOf(rent);
  settlement.payments.push(payment);
  return settlement;
}

export function withoutPayment(rent, transId) {
  const wanted = normalizeReference(transId);
  const settlement = settlementOf(rent);
  settlement.payments = settlement.payments.filter(
    (payment) => !isPaymentOf(payment, wanted)
  );
  return settlement;
}

/**
 * M-Pesa payments recorded on a rent are backed by a transaction received
 * from Safaricom. The payment form submits the whole payment list of a rent:
 * a stale form (opened before the money arrived) must not erase them, and
 * their amount cannot be edited. They are moved or removed from the M-Pesa
 * page instead.
 */
export function mergeLockedPayments(submitted, lockedTransactions) {
  if (!lockedTransactions || !lockedTransactions.length) {
    return submitted;
  }
  const lockedIds = new Set(
    lockedTransactions.map(({ transId }) => normalizeReference(transId))
  );
  const kept = submitted.filter(
    (payment) => !lockedIds.has(normalizeReference(payment.reference))
  );
  return [...kept, ...lockedTransactions.map(toRentPayment)];
}

/** Daraja refuses callback URLs containing these words (case-insensitive). */
const FORBIDDEN_URL_KEYWORDS = [
  'mpesa',
  'm-pesa',
  'safaricom',
  'exec',
  'exe',
  'cmd',
  'sql',
  'query'
];

export function buildCallbackUrls(baseUrl, token) {
  const origin = String(baseUrl).trim().replace(/\/+$/, '');
  return {
    validationUrl: `${origin}/api/v2/c2b/${token}/validation`,
    confirmationUrl: `${origin}/api/v2/c2b/${token}/confirmation`
  };
}

/**
 * Lists what would make Safaricom refuse (or never reach) the callback URLs:
 * 'not_a_url', 'https_required', 'not_public', 'forbidden_keyword'.
 * An empty list means the base URL is usable.
 */
export function findCallbackUrlIssues(baseUrl, environment) {
  const issues = [];
  let url;
  try {
    url = new URL(String(baseUrl).trim());
  } catch (error) {
    return ['not_a_url'];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return ['not_a_url'];
  }
  if (environment === 'production' && url.protocol !== 'https:') {
    issues.push('https_required');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]'
  ) {
    issues.push('not_public');
  }
  const lowered = `${host}${url.pathname}`.toLowerCase();
  if (FORBIDDEN_URL_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
    issues.push('forbidden_keyword');
  }
  return issues;
}
