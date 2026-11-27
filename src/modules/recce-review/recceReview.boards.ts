import { isRenderCategory } from './recceReview.model';
import type { MediaItem } from './recceReview.common';
import { presentItem } from './recceReview.versions';

/**
 * The shop's boards, each with EVERYTHING of that board inside it (2026-11-27):
 *
 *   board  GSB-01  { size, quantity, sided, installationType, answers (the site questions),
 *                    photos[]    the site photos of this board,
 *                    drawing2d   the 2D drawing picture,
 *                    view3d      the 3D preview picture }
 *
 * Nothing is copied. The shop's one document (RecceSubmission) still holds `mediaItems[]` (the boards) and `photos[]` (every picture, each
 * with the board's key in `mediaKey`); this only reads them together, so the apps get one nested object per board and never have to match
 * photos to boards themselves. A newer picture of the same kind wins: the live (draft or submitted) one is shown, older ones are history.
 */
type PresentedPhoto = { id: string; category: string; mediaKey: string; state: string; order: number };

export function nestBoards<P extends PresentedPhoto>(items: MediaItem[], photos: P[]) {
  const live = photos.filter((p) => p.state === 'DRAFT' || p.state === 'SUBMITTED');
  const boards = items.map((i) => {
    const mine = live.filter((p) => p.mediaKey === i.key);
    const sitePhotos = mine.filter((p) => !isRenderCategory(p.category));
    const render = (cat: string) => mine.filter((p) => p.category === cat).at(-1) ?? null;
    return { ...presentItem(i), photos: sitePhotos, photoCount: sitePhotos.length, drawing2d: render('DRAWING_2D'), view3d: render('VIEW_3D') };
  });
  const keys = new Set(items.map((i) => i.key));
  return { boards, shopPhotos: live.filter((p) => !p.mediaKey || !keys.has(p.mediaKey)) };
}
