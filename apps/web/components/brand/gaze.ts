/**
 * Which way Auni looks at a point `dx, dy` px away: a unit direction, scaled
 * by how far off the point is, at full strength from `full` px out. A point
 * right beside Auni barely moves its eyes; a far one turns them all the way.
 */
export function gaze(dx: number, dy: number, full: number): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };
  const strength = Math.min(distance / full, 1) / distance;
  return { x: dx * strength, y: dy * strength };
}
