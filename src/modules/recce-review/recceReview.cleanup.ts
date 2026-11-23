import { collectStoredFiles, removeStoredFiles } from '../files/file.service';
import { RecceSubmission } from './recceReview.model';

/** Erases every stored recce photo (original and marked copy) of a project that is being deleted. Run before the project is purged. */
export async function removeProjectRecceFiles(projectId: string): Promise<{ failed: string[] }> {
  const subs = await RecceSubmission.find({ project: projectId }).select('photos.original photos.edited').lean();
  // `?? []`: a record written before the photos moved into the shop document has no photos array (see scripts/purge-legacy-recce.ts).
  return removeStoredFiles(collectStoredFiles(subs.flatMap((s) => (s.photos ?? []).map((p) => ({ o: p.original, e: p.edited })))));
}
