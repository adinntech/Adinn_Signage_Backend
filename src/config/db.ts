import mongoose from 'mongoose';
import { env } from './env';

export async function connectDb(uri = env.MONGODB_URI) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
}

export const disconnectDb = () => mongoose.disconnect();
