import { Collections } from '@microrealestate/common';
import { MPESA_PAYMENT_TYPE } from './core.js';
import { resolveTenantFrequency } from '../tenantfrequency.js';

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

function toTransaction(doc) {
  return { ...doc, _id: String(doc._id) };
}

/** Mongo implementation of the store used by the M-Pesa service. */
export const mongoStore = {
  async listTenantCandidates(realmId) {
    const now = new Date();
    const tenants = await Collections.Tenant.find(
      { realmId },
      { name: 1, reference: 1, endDate: 1, terminationDate: 1 }
    ).lean();
    return tenants.map((tenant) => {
      const lastDay = tenant.terminationDate || tenant.endDate;
      return {
        _id: String(tenant._id),
        name: tenant.name,
        reference: tenant.reference || '',
        active: !lastDay || new Date(lastDay) >= now
      };
    });
  },

  async loadTenant(realmId, tenantId) {
    if (!Collections.ObjectId.isValid(tenantId)) {
      return null;
    }
    const tenant = await Collections.Tenant.findOne({
      _id: tenantId,
      realmId
    }).lean();
    if (!tenant) {
      return null;
    }
    return {
      tenant,
      frequency: await resolveTenantFrequency(realmId, tenant)
    };
  },

  async saveRents(realmId, tenantId, rents) {
    const result = await Collections.Tenant.updateOne(
      { _id: tenantId, realmId },
      { $set: { rents } }
    );
    if (!result.matchedCount) {
      throw new Error('tenant not found');
    }
  },

  async findTenantHolding(realmId, transId) {
    const tenant = await Collections.Tenant.findOne(
      {
        realmId,
        'rents.payments': {
          $elemMatch: { type: MPESA_PAYMENT_TYPE, reference: transId }
        }
      },
      { _id: 1 }
    ).lean();
    return tenant ? String(tenant._id) : null;
  },

  async insertTransaction(realmId, payment) {
    try {
      const created = await Collections.MpesaTransaction.create({
        realmId,
        transId: payment.transId,
        transactionType: payment.transactionType,
        transTime: payment.transTime,
        paidAt: payment.paidAt,
        amount: payment.amount,
        shortCode: payment.shortCode,
        billRefNumber: payment.billRefNumber,
        invoiceNumber: payment.invoiceNumber,
        msisdn: payment.msisdn,
        payerName: payment.payerName,
        status: 'received'
      });
      return { created: true, transaction: toTransaction(created.toObject()) };
    } catch (error) {
      // unique index on (realmId, transId): the receipt is already known
      if (isDuplicateKeyError(error)) {
        const existing = await Collections.MpesaTransaction.findOne({
          realmId,
          transId: payment.transId
        }).lean();
        if (existing) {
          return { created: false, transaction: toTransaction(existing) };
        }
      }
      throw error;
    }
  },

  async getTransaction(realmId, transactionId) {
    if (!Collections.ObjectId.isValid(transactionId)) {
      return null;
    }
    const transaction = await Collections.MpesaTransaction.findOne({
      _id: transactionId,
      realmId
    }).lean();
    return transaction ? toTransaction(transaction) : null;
  },

  async updateTransaction(realmId, transId, patch) {
    const transaction = await Collections.MpesaTransaction.findOneAndUpdate(
      { realmId, transId },
      { $set: patch },
      { new: true }
    ).lean();
    if (!transaction) {
      throw new Error(`M-Pesa transaction ${transId} not found`);
    }
    return toTransaction(transaction);
  }
};
