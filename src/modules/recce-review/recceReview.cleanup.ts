import { collectStoredFiles, removeStoredFiles } from '../files/file.service';
import { ReccePhoto } from './recceReview.model';

/** Erases every stored recce photo (original and marked copy) of a project that is being deleted. Run before the project is purged. */
export async function removeProjectRecceFiles(projectId: string): Promise<{ failed: string[] }> {
  const photos = await ReccePhoto.find({ project: projectId }).select('original edited').lean();
  return removeStoredFiles(collectStoredFiles(photos.map((p) => ({ o: p.original, e: p.edited }))));
}
