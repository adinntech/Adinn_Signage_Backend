import { Schema, model } from 'mongoose';

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = model('Counter', counterSchema);

export async function nextSeq(key: string): Promise<number> {
  const c = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return c.seq;
}


/** Next number nextSeq would hand out, without using it (for previews; another save may take it first). */
export async function peekSeq(key: string): Promise<number> {
  const c = await Counter.findById(key).lean();
  return (c?.seq ?? 0) + 1;
}

/** Reserve `n` consecutive numbers; returns the first. */
export async function nextSeqBlock(key: string, n: number): Promise<number> {
  const c = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: n } }, { upsert: true, returnDocument: 'after' });
  return c.seq - n + 1;
}
