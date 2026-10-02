import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const MpesaTransactionSchema =
  new mongoose.Schema<CollectionTypes.MpesaTransaction>(
    {
      realmId: { type: String, ref: Realm, required: true },
      transId: { type: String, required: true },
      transactionType: String,
      transTime: { type: String, required: true },
      paidAt: { type: String, required: true },
      amount: { type: Number, required: true },
      shortCode: { type: String, required: true },
      billRefNumber: { type: String, default: '' },
      invoiceNumber: String,
      msisdn: String,
      payerName: String,
      status: {
        type: String,
        enum: ['received', 'matched', 'unmatched', 'ignored'],
        required: true,
        default: 'received'
      },
      reason: { type: String, default: null },
      tenantId: { type: String, default: null },
      tenantName: { type: String, default: null },
      term: { type: Number, default: null },
      matchedBy: { type: String, default: null }
    },
    { timestamps: true }
  );

// Safaricom may deliver the same confirmation more than once: the receipt
// number is the idempotency key.
MpesaTransactionSchema.index({ realmId: 1, transId: 1 }, { unique: true });
MpesaTransactionSchema.index({ realmId: 1, status: 1, paidAt: -1 });

export default mongoose.model<CollectionTypes.MpesaTransaction>(
  'MpesaTransaction',
  MpesaTransactionSchema
);
