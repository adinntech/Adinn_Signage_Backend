import { AuditLog } from '../audit/auditLog.model';
import { collectStoredFiles, removeStoredFiles } from '../files/file.service';
import { Project } from '../projects/project.model';
import { SalesOrder } from '../sales/sales.model';
import { CodeRequest } from '../codeRequests/codeRequest.model';
import { Client } from './client.model';
import { AppError } from '../../common/errors';

/**
 * EVERYTHING a client owns and must disappear with it: its sales orders (comments, approval proof, rate card revisions,
 * sent emails, pipeline log) and every stored file of those orders. Add a line here for every new collection that
 * stores a `client` reference (skill `project-data-cascade`).
 *
 * A client that still has projects is NOT purged: it is only hidden (soft delete), because those projects need it.
 */
export async function purgeClientData(clientId: string): Promise<{ purged: boolean; removed: Record<string, number> }> {
  if (await Project.exists({ client: clientId })) return { purged: false, removed: {} };
  const orders = await SalesOrder.find({ client: clientId }).lean();
  const client = await Client.findById(clientId).select('gstCertificates').lean();
  // Files first: if one cannot be erased from storage, nothing is deleted and the person can simply try again.
  const { failed } = await removeStoredFiles(collectStoredFiles([...orders, client]));
  if (failed.length) throw AppError.conflict(`Could not remove these files from storage, so the client was not deleted: ${failed.join(', ')}. Try again.`);
  const ids = orders.map((o) => o._id);
  const removed: Record<string, number> = {};
  const requestIds = (await CodeRequest.find({ order: { $in: ids } }).select('_id').lean()).map((r) => r._id);
  removed['Code request history'] = (await AuditLog.deleteMany({ entity: 'CodeRequest', entityId: { $in: requestIds } })).deletedCount ?? 0;
  removed['Code requests'] = (await CodeRequest.deleteMany({ order: { $in: ids } })).deletedCount ?? 0;
  removed['Audit history'] = (await AuditLog.deleteMany({ entity: 'SalesOrder', entityId: { $in: ids } })).deletedCount ?? 0;
  removed['Sales orders'] = (await SalesOrder.deleteMany({ client: clientId })).deletedCount ?? 0;
  removed.Client = (await Client.deleteOne({ _id: clientId })).deletedCount ?? 0;
  return { purged: true, removed };
}
