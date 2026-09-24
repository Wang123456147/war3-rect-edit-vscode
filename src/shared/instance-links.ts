import type { InstanceMirrorAxis } from './model';

/** Per-axis flip of a link: `-1` mirrors that axis, `1` keeps its direction. */
export type MirrorSigns = { x: 1 | -1; y: 1 | -1 };

export interface LinkPoint {
  x: number;
  y: number;
}

/** Axis-aligned box in the canonical (min, max) form the editor works with. */
export interface LinkBox {
  min: LinkPoint;
  max: LinkPoint;
}

/** `none` keeps the offset, `horizontal` flips X (左右), `vertical` flips Y (上下). */
export function mirrorSigns(axis: InstanceMirrorAxis): MirrorSigns {
  return {
    x: axis === 'horizontal' ? -1 : 1,
    y: axis === 'vertical' ? -1 : 1
  };
}

/**
 * The offset of the affine map `target = signs * source + offset` for a pair of
 * entities that already sit somewhere, which is what reloading an instance link
 * has to recover from the stored topology alone.
 *
 * It is measured so that it agrees with how a region is re-derived: corners are
 * mapped one by one and the extents rebuilt with min/max, so on a mirrored axis
 * the source's low corner lands on the target's *high* corner. Measuring from
 * the same corner on both sides would be off by the box's size — the reason
 * this takes boxes instead of single points.
 */
export function linkOffset(source: LinkBox, target: LinkBox, axis: InstanceMirrorAxis): LinkPoint {
  const signs = mirrorSigns(axis);
  return {
    x: target.min.x - Math.min(signs.x * source.min.x, signs.x * source.max.x),
    y: target.min.y - Math.min(signs.y * source.min.y, signs.y * source.max.y)
  };
}

/**
 * The offset that drops a copied group so its centre sits on `dropCenter`.
 * Every member shares the same map, so one offset describes the whole group.
 */
export function groupOffset(
  sourceCenter: LinkPoint,
  dropCenter: LinkPoint,
  axis: InstanceMirrorAxis
): LinkPoint {
  const signs = mirrorSigns(axis);
  return {
    x: dropCenter.x - signs.x * sourceCenter.x,
    y: dropCenter.y - signs.y * sourceCenter.y
  };
}
