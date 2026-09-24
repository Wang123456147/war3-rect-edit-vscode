/**
 * Geometry for "scroll the sidebar so the selected row is visible".
 *
 * Kept pure and DOM-free so the awkward parts — centering a short row, clamping
 * at both ends, a row taller than the list — are covered by tests instead of
 * only by watching the panel.
 */

export interface ScrollRevealView {
  /** Row top edge, in the list's content coordinates. */
  rowTop: number;
  rowHeight: number;
  scrollTop: number;
  viewHeight: number;
  contentHeight: number;
}

/**
 * The `scrollTop` that centres the row, or `undefined` when the row is already
 * fully visible — a row the user can see must never make the list move.
 */
export function scrollTargetForRow(view: ScrollRevealView): number | undefined {
  const viewBottom = view.scrollTop + view.viewHeight;
  if (view.rowTop >= view.scrollTop && view.rowTop + view.rowHeight <= viewBottom) {
    return undefined;
  }
  const maxScroll = Math.max(0, view.contentHeight - view.viewHeight);
  const centered = view.rowTop - (view.viewHeight - view.rowHeight) / 2;
  return Math.min(Math.max(centered, 0), maxScroll);
}
