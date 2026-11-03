import { Schema, model } from 'mongoose';
import { clientDetailsSchema } from '../clients/clientDetails';
import { rateCardRevisionSchema } from './ratecard.model';

/**
 * Rate Card Creation (Client Servicing): a rate card made on its own, without an order. The Zoho client is kept on it
 * (`clientDetails`, last entry = current client, as on orders) and every save that changes something appends a version
 * with its own PDF (`rateCardArray`, the same revision shape as an order's rate card).
 */
const rateCardCreationSchema = new Schema(
  {
    /** ADINN/RC/<IST date>/<n>, stable across versions. */
    quotationRef: { type: String, required: true, unique: true },
    clientDetails: { type: [clientDetailsSchema], default: [] },
    rateCardArray: { type: [rateCardRevisionSchema], default: [] },
    currentRevision: { type: Number, default: 0 },
    /** Same Save sent twice (double click / retry) creates one rate card. */
    requestKey: { type: String, unique: true, sparse: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
  },
  { timestamps: true },
);
rateCardCreationSchema.index({ deletedAt: 1, createdBy: 1, updatedAt: -1 });
rateCardCreationSchema.index({ 'clientDetails.name': 1 });

export const StandaloneRateCard = model('StandaloneRateCard', rateCardCreationSchema, 'ratecards');
