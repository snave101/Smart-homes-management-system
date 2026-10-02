/* eslint-env node, jest */
import {
  buildCallbackUrls,
  findCallbackUrlIssues,
  findPaymentTerm,
  matchTenant,
  mergeLockedPayments,
  normalizeReference,
  parseC2BPayload,
  pickRentTerm,
  termKeyOf,
  toPaymentDate,
  transTimeToDate
} from '../../managers/mpesa/core.js';

const confirmation = {
  TransactionType: 'Pay Bill',
  TransID: 'RKTQDM7W6S',
  TransTime: '20260305143845',
  TransAmount: '15000.00',
  BusinessShortCode: '600638',
  BillRefNumber: ' a12 ',
  InvoiceNumber: '',
  OrgAccountBalance: '49197.00',
  ThirdPartyTransID: '',
  MSISDN: '25470****149',
  FirstName: 'John',
  MiddleName: '',
  LastName: 'Doe'
};

describe('M-Pesa payload parsing', () => {
  it('normalizes a Daraja confirmation', () => {
    expect(parseC2BPayload(confirmation)).toEqual({
      ok: true,
      payment: {
        transId: 'RKTQDM7W6S',
        transactionType: 'Pay Bill',
        transTime: '20260305143845',
        paidAt: '2026-03-05T14:38',
        amount: 15000,
        shortCode: '600638',
        billRefNumber: 'a12',
        invoiceNumber: '',
        msisdn: '25470****149',
        payerName: 'John Doe'
      }
    });
  });

  it('accepts numeric amounts and short codes', () => {
    const parsed = parseC2BPayload({
      ...confirmation,
      TransAmount: 1250.5,
      BusinessShortCode: 600638
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.payment.amount).toBe(1250.5);
    expect(parsed.payment.shortCode).toBe('600638');
  });

  it('refuses what cannot be a payment', () => {
    const refused = (override) =>
      parseC2BPayload({ ...confirmation, ...override });

    expect(parseC2BPayload(null).ok).toBe(false);
    expect(parseC2BPayload('RKTQDM7W6S').ok).toBe(false);
    expect(parseC2BPayload([confirmation]).ok).toBe(false);
    expect(refused({ TransID: '' }).reason).toBe('invalid TransID');
    expect(refused({ TransID: { $ne: null } }).reason).toBe('invalid TransID');
    expect(refused({ TransID: 'AB;DROP' }).reason).toBe('invalid TransID');
    expect(refused({ TransAmount: '-5' }).reason).toBe('invalid TransAmount');
    expect(refused({ TransAmount: '1e9' }).reason).toBe('invalid TransAmount');
    expect(refused({ TransAmount: 'abc' }).reason).toBe('invalid TransAmount');
    expect(refused({ TransAmount: '0' }).reason).toBe(
      'TransAmount must be positive'
    );
    expect(refused({ BusinessShortCode: 'x' }).reason).toBe(
      'invalid BusinessShortCode'
    );
    expect(refused({ TransTime: '20261305143845' }).reason).toBe(
      'invalid TransTime'
    );
    expect(refused({ TransTime: '20260230100000' }).reason).toBe(
      'invalid TransTime'
    );
  });

  it('converts Daraja timestamps without shifting the time zone', () => {
    expect(transTimeToDate('20261231235959')).toBe('2026-12-31T23:59');
    expect(toPaymentDate('20261231235959')).toBe('31/12/2026');
    expect(toPaymentDate('20260101000000')).toBe('01/01/2026');
    expect(transTimeToDate('2026')).toBeUndefined();
    expect(toPaymentDate(undefined)).toBeUndefined();
    expect(termKeyOf('20260305143845')).toBe(2026030514);
  });
});

describe('M-Pesa tenant matching', () => {
  const tenants = [
    { _id: '1', name: 'Wanjiku', reference: 'A12', active: true },
    { _id: '2', name: 'Otieno', reference: 'b-07', active: true },
    { _id: '3', name: 'Old tenant', reference: 'C3', active: false },
    { _id: '4', name: 'New tenant', reference: 'c3', active: true },
    { _id: '5', name: 'Twin 1', reference: 'D1', active: true },
    { _id: '6', name: 'Twin 2', reference: 'D1', active: true },
    { _id: '7', name: 'No reference', reference: '', active: true }
  ];

  it('ignores case, spaces and punctuation', () => {
    expect(normalizeReference(' a-12 ')).toBe('A12');
    expect(matchTenant(tenants, ' a 12').tenant._id).toBe('1');
    expect(matchTenant(tenants, 'B07').tenant._id).toBe('2');
    expect(matchTenant(tenants, 'b/07').tenant._id).toBe('2');
  });

  it('does not match unknown or empty account numbers', () => {
    expect(matchTenant(tenants, 'Z99').kind).toBe('none');
    expect(matchTenant(tenants, '').kind).toBe('none');
    expect(matchTenant(tenants, '---').kind).toBe('none');
    expect(matchTenant(tenants, undefined).kind).toBe('none');
    // a partial account number is not a match
    expect(matchTenant(tenants, 'A1').kind).toBe('none');
  });

  it('prefers the running lease when a reference was reused', () => {
    expect(matchTenant(tenants, 'C3').tenant._id).toBe('4');
  });

  it('never guesses between two running leases', () => {
    expect(matchTenant(tenants, 'D1')).toEqual({ kind: 'ambiguous', count: 2 });
  });
});

describe('M-Pesa rent selection', () => {
  const months = [2026010100, 2026020100, 2026030100];

  it('picks the term in force when the money was sent', () => {
    expect(pickRentTerm(months, 2026020100)).toBe(2026020100);
    expect(pickRentTerm(months, 2026022823)).toBe(2026020100);
    expect(pickRentTerm(months, 2026030100)).toBe(2026030100);
  });

  it('falls back on the first or the last rent outside the lease', () => {
    expect(pickRentTerm(months, 2025123123)).toBe(2026010100);
    expect(pickRentTerm(months, 2027010100)).toBe(2026030100);
    expect(pickRentTerm([], 2026010100)).toBeUndefined();
  });

  it('works with unsorted and weekly terms', () => {
    const weeks = [2026011500, 2026010100, 2026010800];
    expect(pickRentTerm(weeks, 2026011012)).toBe(2026010800);
  });

  it('finds the rent holding a receipt', () => {
    const rents = [
      { term: 2026010100, payments: [] },
      {
        term: 2026020100,
        payments: [
          { type: 'cash', reference: 'RKTQDM7W6S', amount: 1 },
          { type: 'mobile_money', reference: 'rktqdm7w6s', amount: 100 }
        ]
      }
    ];
    expect(findPaymentTerm(rents, 'RKTQDM7W6S')).toBe(2026020100);
    expect(findPaymentTerm(rents, 'OTHER00001')).toBeUndefined();
    expect(findPaymentTerm(undefined, 'RKTQDM7W6S')).toBeUndefined();
  });
});

describe('M-Pesa payments and the rent payment form', () => {
  const locked = [
    { transId: 'RKTQDM7W6S', transTime: '20260305143845', amount: 15000 }
  ];
  const mpesaPayment = {
    date: '05/03/2026',
    type: 'mobile_money',
    reference: 'RKTQDM7W6S',
    amount: 15000
  };

  it('leaves the form untouched when nothing is locked', () => {
    const submitted = [{ type: 'cash', reference: '', amount: 500 }];
    expect(mergeLockedPayments(submitted, [])).toBe(submitted);
  });

  it('restores a payment missing from a stale form', () => {
    const submitted = [{ type: 'cash', reference: '', amount: 500 }];
    expect(mergeLockedPayments(submitted, locked)).toEqual([
      ...submitted,
      mpesaPayment
    ]);
  });

  it('does not let the form edit or duplicate an M-Pesa payment', () => {
    const submitted = [
      { type: 'mobile_money', reference: 'rktqdm7w6s', amount: 1 },
      { type: 'transfer', reference: 'BANK-1', amount: 200 }
    ];
    expect(mergeLockedPayments(submitted, locked)).toEqual([
      { type: 'transfer', reference: 'BANK-1', amount: 200 },
      mpesaPayment
    ]);
  });
});

describe('M-Pesa callback URLs', () => {
  it('builds URLs Daraja accepts', () => {
    const urls = buildCallbackUrls('https://rent.example.co.ke/', 'abc123');
    expect(urls).toEqual({
      validationUrl: 'https://rent.example.co.ke/api/v2/c2b/abc123/validation',
      confirmationUrl:
        'https://rent.example.co.ke/api/v2/c2b/abc123/confirmation'
    });
    expect(findCallbackUrlIssues(urls.confirmationUrl, 'production')).toEqual(
      []
    );
  });

  it('reports what Safaricom would refuse', () => {
    expect(findCallbackUrlIssues('rent.example.com', 'sandbox')).toEqual([
      'not_a_url'
    ]);
    expect(findCallbackUrlIssues('ftp://example.com', 'sandbox')).toEqual([
      'not_a_url'
    ]);
    expect(findCallbackUrlIssues('http://example.com', 'production')).toEqual([
      'https_required'
    ]);
    expect(findCallbackUrlIssues('http://example.com', 'sandbox')).toEqual([]);
    expect(findCallbackUrlIssues('https://localhost', 'production')).toEqual([
      'not_public'
    ]);
    expect(findCallbackUrlIssues('https://192.168.1.4', 'sandbox')).toEqual([
      'not_public'
    ]);
    expect(
      findCallbackUrlIssues('https://mpesa.example.com', 'production')
    ).toEqual(['forbidden_keyword']);
    expect(
      findCallbackUrlIssues('https://example.com/safaricom', 'production')
    ).toEqual(['forbidden_keyword']);
  });
});
