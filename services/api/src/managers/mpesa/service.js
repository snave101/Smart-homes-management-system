/**
 * M-Pesa C2B business rules, independent from Express and Mongoose: the
 * persistence is reached through a store (see store.js) with these methods:
 *
 *   listTenantCandidates(realmId) -> [{ _id, name, reference, active }]
 *   loadTenant(realmId, tenantId) -> { tenant, frequency } | null
 *   saveRents(realmId, tenantId, rents)
 *   findTenantHolding(realmId, transId) -> tenantId | null
 *   insertTransaction(realmId, payment) -> { created, transaction }
 *   getTransaction(realmId, transactionId) -> transaction | null
 *   updateTransaction(realmId, transId, patch) -> transaction
 */
import {
  findPaymentTerm,
  matchTenant,
  parseC2BPayload,
  pickRentTerm,
  termKeyOf,
  toRentPayment,
  ValidationCode,
  withoutPayment,
  withPayment
} from './core.js';

/** Raised for requests the landlord can fix; carries an HTTP status. */
export class MpesaError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const ACK = { ResultCode: 0, ResultDesc: 'Success' };

const UNMATCHED = {
  status: 'unmatched',
  tenantId: null,
  tenantName: null,
  term: null,
  matchedBy: null
};

function reject(code) {
  return { ResultCode: code, ResultDesc: 'Rejected' };
}

function toContract(tenant, frequency) {
  return {
    frequency,
    begin: tenant.beginDate,
    end: tenant.endDate,
    discount: tenant.discount || 0,
    vatRate: tenant.vatRatio,
    properties: tenant.properties,
    rents: tenant.rents
  };
}

export function createMpesaService({ store, payTerm, withLock, logger }) {
  /**
   * Must run inside the tenant lock.
   * Returns { applied: true, term, tenantName } or { applied: false, reason }.
   */
  async function applyToTenant(realmId, tenantId, payment, requestedTerm) {
    const loaded = await store.loadTenant(realmId, tenantId);
    if (!loaded) {
      return { applied: false, reason: 'unknown_account' };
    }
    const { tenant, frequency } = loaded;
    if (!tenant.rents?.length || !tenant.beginDate || !tenant.endDate) {
      return { applied: false, reason: 'no_rent' };
    }

    // a confirmation delivered twice must never be counted twice
    const alreadyRecordedTerm = findPaymentTerm(tenant.rents, payment.transId);
    if (alreadyRecordedTerm !== undefined) {
      return {
        applied: true,
        term: alreadyRecordedTerm,
        tenantName: tenant.name
      };
    }

    const term =
      requestedTerm ??
      pickRentTerm(
        tenant.rents.map((rent) => rent.term),
        termKeyOf(payment.transTime)
      );
    const rent = tenant.rents.find((candidate) => candidate.term === term);
    if (term === undefined || !rent) {
      return { applied: false, reason: 'no_rent' };
    }

    const contract = payTerm(
      toContract(tenant, frequency),
      String(term),
      withPayment(rent, toRentPayment(payment))
    );
    await store.saveRents(realmId, tenantId, contract.rents);
    return { applied: true, term, tenantName: tenant.name };
  }

  /** Removes the payment of a receipt from whichever tenant holds it. */
  async function removeFromHolder(realmId, transId) {
    const holderId = await store.findTenantHolding(realmId, transId);
    if (!holderId) {
      return;
    }
    await withLock(holderId, async () => {
      const loaded = await store.loadTenant(realmId, holderId);
      if (!loaded) {
        return;
      }
      const { tenant, frequency } = loaded;
      const term = findPaymentTerm(tenant.rents, transId);
      const rent = (tenant.rents || []).find(
        (candidate) => candidate.term === term
      );
      if (term === undefined || !rent) {
        return;
      }
      const contract = payTerm(
        toContract(tenant, frequency),
        String(term),
        withoutPayment(rent, transId)
      );
      await store.saveRents(realmId, holderId, contract.rents);
    });
  }

  async function requireTransaction(realmId, transactionId) {
    const transaction = await store.getTransaction(realmId, transactionId);
    if (!transaction) {
      throw new MpesaError('transaction not found', 404);
    }
    return transaction;
  }

  return {
    /**
     * Answers the validation request Safaricom sends before completing a
     * payment (only when external validation is activated on the short code).
     */
    async validate(config, body) {
      const parsed = parseC2BPayload(body);
      if (!parsed.ok) {
        logger.warn(`M-Pesa validation rejected: ${parsed.reason}`);
        return reject(
          /amount/i.test(parsed.reason)
            ? ValidationCode.INVALID_AMOUNT
            : ValidationCode.OTHER
        );
      }
      const { payment } = parsed;
      if (!config.enabled) {
        return reject(ValidationCode.OTHER);
      }
      if (payment.shortCode !== config.shortCode) {
        return reject(ValidationCode.INVALID_SHORTCODE);
      }
      if (config.rejectUnknownAccounts && config.shortCodeType === 'paybill') {
        const match = matchTenant(
          await store.listTenantCandidates(config.realmId),
          payment.billRefNumber
        );
        if (match.kind !== 'match') {
          logger.info(
            `M-Pesa validation rejected: the account number is ${
              match.kind === 'none' ? 'unknown' : 'ambiguous'
            }`
          );
          return reject(ValidationCode.INVALID_ACCOUNT);
        }
      }
      return { ResultCode: ValidationCode.ACCEPTED, ResultDesc: 'Accepted' };
    },

    /**
     * Records a completed payment. The money has already moved when this is
     * called, so a transaction is always stored: when no tenant can be
     * determined it is kept as unmatched for the landlord to allocate.
     * Throws only when the transaction itself could not be stored, so that
     * Safaricom delivers the confirmation again.
     */
    async confirm(config, body) {
      const parsed = parseC2BPayload(body);
      if (!parsed.ok) {
        logger.warn(`M-Pesa confirmation ignored: ${parsed.reason}`);
        return ACK;
      }
      const { payment } = parsed;
      const { realmId } = config;
      if (payment.shortCode !== config.shortCode) {
        logger.warn(
          `M-Pesa confirmation ${payment.transId} ignored: it is for another short code`
        );
        return ACK;
      }

      const { created, transaction } = await store.insertTransaction(
        realmId,
        payment
      );
      if (!created && transaction.status !== 'received') {
        logger.info(`M-Pesa confirmation ${payment.transId} already processed`);
        return ACK;
      }

      const leaveUnmatched = (reason) =>
        store.updateTransaction(realmId, payment.transId, {
          ...UNMATCHED,
          reason
        });

      try {
        if (!config.enabled) {
          await leaveUnmatched('integration_disabled');
          return ACK;
        }

        // the landlord may have typed this receipt in the payment form
        // before the confirmation arrived: adopt it instead of counting twice
        let tenantId = await store.findTenantHolding(realmId, payment.transId);
        const alreadyRecorded = !!tenantId;
        if (!tenantId) {
          const match = matchTenant(
            await store.listTenantCandidates(realmId),
            payment.billRefNumber
          );
          if (match.kind !== 'match') {
            await leaveUnmatched(
              match.kind === 'none' ? 'unknown_account' : 'ambiguous_account'
            );
            logger.info(
              `M-Pesa payment ${payment.transId} stored as unmatched (${match.kind})`
            );
            return ACK;
          }
          tenantId = match.tenant._id;
        }

        const result = await withLock(tenantId, () =>
          applyToTenant(realmId, tenantId, payment)
        );
        if (!result.applied) {
          await leaveUnmatched(result.reason);
          return ACK;
        }
        await store.updateTransaction(realmId, payment.transId, {
          status: 'matched',
          reason: null,
          tenantId,
          tenantName: result.tenantName,
          term: result.term,
          matchedBy: alreadyRecorded ? 'manual' : 'auto'
        });
        logger.info(
          `M-Pesa payment ${payment.transId} recorded on term ${result.term}`
        );
      } catch (error) {
        // the transaction is stored: acknowledge and let the landlord
        // allocate it rather than have Safaricom retry forever
        logger.error(
          `M-Pesa payment ${payment.transId} could not be applied: ${
            error?.message || error
          }`
        );
        await leaveUnmatched('apply_failed').catch(() => undefined);
      }
      return ACK;
    },

    /** Records (or moves) a transaction on the rent of a tenant. */
    async allocate(realmId, transactionId, tenantId, term) {
      const transaction = await requireTransaction(realmId, transactionId);
      if (term !== undefined && !Number.isInteger(term)) {
        throw new MpesaError('invalid term', 422);
      }

      await removeFromHolder(realmId, transaction.transId);

      const result = await withLock(tenantId, () =>
        applyToTenant(realmId, tenantId, transaction, term)
      );
      if (!result.applied) {
        await store.updateTransaction(realmId, transaction.transId, {
          ...UNMATCHED,
          reason: 'detached'
        });
        throw new MpesaError(
          result.reason === 'unknown_account'
            ? 'tenant not found'
            : 'this tenant has no rent the payment can be recorded on',
          result.reason === 'unknown_account' ? 404 : 422
        );
      }
      return store.updateTransaction(realmId, transaction.transId, {
        status: 'matched',
        reason: null,
        tenantId,
        tenantName: result.tenantName,
        term: result.term,
        matchedBy: 'manual'
      });
    },

    /** Removes the payment from the rent and puts the transaction back. */
    async detach(realmId, transactionId) {
      const transaction = await requireTransaction(realmId, transactionId);
      await removeFromHolder(realmId, transaction.transId);
      return store.updateTransaction(realmId, transaction.transId, {
        ...UNMATCHED,
        reason: 'detached'
      });
    },

    /** Sets aside (or restores) a transaction that is not a rent payment. */
    async setIgnored(realmId, transactionId, ignored) {
      const transaction = await requireTransaction(realmId, transactionId);
      if (transaction.status === 'matched') {
        throw new MpesaError(
          'remove the payment from the rent before ignoring it',
          409
        );
      }
      return store.updateTransaction(realmId, transaction.transId, {
        status: ignored ? 'ignored' : 'unmatched',
        reason: ignored ? null : transaction.reason || 'detached'
      });
    }
  };
}
