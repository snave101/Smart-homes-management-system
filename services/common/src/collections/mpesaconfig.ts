import { CollectionTypes } from '@microrealestate/types';
import mongoose from 'mongoose';
import Realm from './realm.js';

const MpesaConfigSchema = new mongoose.Schema<CollectionTypes.MpesaConfig>({
  realmId: { type: String, ref: Realm, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  environment: {
    type: String,
    enum: ['sandbox', 'production'],
    default: 'sandbox'
  },
  shortCode: { type: String, default: '' },
  shortCodeType: {
    type: String,
    enum: ['paybill', 'till'],
    default: 'paybill'
  },
  consumerKey: { type: String, default: '' },
  // encrypted with Crypto.encrypt
  consumerSecret: { type: String, default: '' },
  callbackToken: { type: String, required: true, unique: true },
  callbackBaseUrl: { type: String, default: '' },
  responseType: {
    type: String,
    enum: ['Completed', 'Cancelled'],
    default: 'Completed'
  },
  rejectUnknownAccounts: { type: Boolean, default: false },
  registeredAt: { type: Date, default: null }
});

export default mongoose.model<CollectionTypes.MpesaConfig>(
  'MpesaConfig',
  MpesaConfigSchema
);
