/**
 * Shared geometry for circuit-design place / route / score.
 * Coordinates are schematic mm (KiCad).
 */

export const DEFAULT_GRID_MM = 2.54;
/** KiCad schematic default fine grid (10 mil). */
export const SCH_GRID_MM = 0.254;
/**
 * KiCad Device:* / symbol-editor grid (50 mil). Part graphic sizes are
 * measured in this unit (e.g. Device:R pin span 6 × 1.27 mm).
 */
export const FINE_GRID_MM = 1.27;
/**
 * Collision / routing clearance: 1 symbol-grid unit beyond graphic extent on
 * every side. Two facing components each pad by this, so they need 2 clear grid
 * units between their graphics to route between them (a 2-grid pad would demand
 * 4, which reads as too much dead space).
 */
export const BODY_PAD_MM = FINE_GRID_MM;

export interface Point2 {
	x: number;
	y: number;
}

export interface Aabb {
	xmin: number;
	ymin: number;
	xmax: number;
	ymax: number;
}

export interface PinLocal {
	number: string;
	x: number;
	y: number;
	rotation: number;
}

export interface PlacementPose {
	ref: string;
	libId: string;
	x: number;
	y: number;
	rotation: number;
}

/**
 * Local (library Y-up) half-extents of Device:* and power:* graphic geometry:
 * body rectangles / polylines / arcs ∪ pin tip positions — never ref/value text.
 * Derived from shared/kicad-io Catalog DevicePassiveSymbols.
 */
const PASSIVE_GRAPHIC_HALF: Record<string, { hw: number; hh: number }> = {
	// Body ±1.016×±2.54 + pins at (0,±3.81) → ≈2×6 symbol-grid.
	'Device:R': { hw: 1.016, hh: 3.81 },
	// Plates ±2.032×±0.762 + pins at (0,±3.81).
	'Device:C': { hw: 2.032, hh: 3.81 },
	// Arc bulge mid x=0.6323 + pins at (0,±3.81).
	'Device:L': { hw: 0.6323, hh: 3.81 },
	// KiCad 10 parallelogram ±2.7686 + pins at (0,±3.81).
	'Device:FerriteBead': { hw: 2.7686, hh: 3.81 },
	// Body ~±1.27×±1.27 + pins at (±3.81,0).
	'Device:D': { hw: 3.81, hh: 1.27 },
	'Device:D_Schottky': { hw: 3.81, hh: 1.27 },
	// Optical arrows extend to x≈-4.572, y≈-2.286; pins at (±3.81,0).
	'Device:LED': { hw: 4.572, hh: 2.286 }
};

/** Stub length from pin tip to label / power-symbol attach (mm). */
export const PIN_STUB_LEN_MM = 5.08;

/** power:GND library pin (at origin, toward body = south / down on sheet). */
export const POWER_GND_PIN: PinLocal = { number: '1', x: 0, y: 0, rotation: 270 };

export function isPowerGndLib(libId: string): boolean {
	return libId === 'power:GND';
}

export function snapToGrid(n: number, gridMm: number = DEFAULT_GRID_MM): number {
	if (!(gridMm > 0)) {
		return n;
	}
	return Math.round(n / gridMm) * gridMm;
}

export function normalizeRot(r: number): number {
	let x = Math.round(r) % 360;
	if (x < 0) {
		x += 360;
	}
	if (x === 0 || x === 90 || x === 180 || x === 270) {
		return x;
	}
	const opts = [0, 90, 180, 270];
	return opts.reduce((best, o) =>
		Math.abs(o - x) < Math.abs(best - x) ? o : best
	);
}

/**
 * Library-local pin/body point → schematic world.
 *
 * KiCad `.kicad_sym` geometry is authored Y-up; the schematic sheet is Y-down.
 * Negate library Y first (same as SchematicPainter / connectivity), then apply
 * instance rotation + translation. Callers must pass raw library coordinates
 * from `(pin (at x y rot) …)` / Device:* tables — do not pre-flip.
 */
export function localToWorld(
	sx: number,
	sy: number,
	sRot: number,
	lx: number,
	ly: number
): Point2 {
	const r = normalizeRot(sRot);
	// Library Y-up → schematic Y-down.
	let x = lx;
	let y = -ly;
	if (r === 90) {
		const nx = -y;
		const ny = x;
		x = nx;
		y = ny;
	}
	else if (r === 180) {
		x = -x;
		y = -y;
	}
	else if (r === 270) {
		const nx = y;
		const ny = -x;
		x = nx;
		y = ny;
	}
	return { x: sx + x, y: sy + y };
}

/**
 * World-space pin orientation (toward body) in KiCad angle convention
 * (0=+X, 90=up/−Y, 180=−X, 270=down/+Y).
 *
 * The position transform ({@link localToWorld}) rotates a Y-flipped point by
 * `(x,y)→(-y,x)` for +90°, which maps a compass direction φ → φ − rotation.
 * The pin's library angle already equals its Y-flipped compass "toward body"
 * (the schematic compass here bakes in the Y-flip), so the world orientation is
 * `pinLibRotation − symbolRotation`. Using `+` (the old bug) put the outward
 * exit 180° wrong for 90°/270° rotations, so wires left rotated passives INTO
 * the body instead of away from it.
 */
export function libPinWorldRotation(pinLibRotation: number, symbolRotation: number): number {
	return normalizeRot(pinLibRotation - symbolRotation);
}

/**
 * Unit outward direction (away from body) in schematic file mm (Y-down).
 * KiCad compass: 0 east, 90 north (−Y), 180 west, 270 south (+Y).
 */
export function kicadOutwardOffset(towardBodyRotation: number, dist: number): Point2 {
	const r = normalizeRot(towardBodyRotation + 180);
	return kicadDirectionOffset(r, dist);
}

/** Offset `dist` mm in a KiCad compass direction (0=E, 90=N/−Y, 180=W, 270=S/+Y). */
export function kicadDirectionOffset(kicadRotation: number, dist: number): Point2 {
	const r = normalizeRot(kicadRotation);
	if (r === 0) {
		return { x: dist, y: 0 };
	}
	if (r === 90) {
		return { x: 0, y: -dist };
	}
	if (r === 180) {
		return { x: -dist, y: 0 };
	}
	return { x: 0, y: dist };
}

/**
 * Continue past a pin tip on a **cardinal** axis only (schematic wires must be
 * 90° — never diagonal).
 *
 * Prefer `towardBodyRot` (KiCad pin orientation toward the body): the stub
 * exits along the pin's outward direction (+180°). Tip-vs-origin dominant-axis
 * is only a fallback when pin orientation is unknown — on tall ICs that
 * fallback wrongly picks vertical near top/bottom corners of a side pin row.
 */
export function stubAwayFromBody(
	origin: Point2,
	tip: Point2,
	dist: number,
	towardBodyRot?: number
): { stubEnd: Point2; outwardRot: number } {
	let outwardRot: number;
	if (towardBodyRot !== undefined) {
		outwardRot = normalizeRot(towardBodyRot + 180);
	}
	else {
		const dx = tip.x - origin.x;
		const dy = tip.y - origin.y;
		// Dominant axis; ties prefer horizontal.
		const horizontal = Math.abs(dx) >= Math.abs(dy);
		if (horizontal) {
			outwardRot = dx >= 0 ? 0 : 180;
		}
		else {
			outwardRot = dy >= 0 ? 270 : 90; // +Y = south = 270
		}
		if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
			outwardRot = 270;
		}
	}
	const stubEnd = {
		x: tip.x + kicadDirectionOffset(outwardRot, dist).x,
		y: tip.y + kicadDirectionOffset(outwardRot, dist).y
	};
	return { stubEnd, outwardRot };
}

/** True if segment is axis-aligned (horizontal or vertical). */
export function isOrthogonalSegment(a: Point2, b: Point2, eps = 1e-6): boolean {
	return Math.abs(a.x - b.x) < eps || Math.abs(a.y - b.y) < eps;
}

/**
 * Split a possibly diagonal segment into an L of two orthogonal segments
 * (horizontal-first). Degenerate / already-ortho → 0 or 1 segment.
 */
export function manhattanizeSegment(
	a: Point2,
	b: Point2
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
	if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) {
		return [];
	}
	if (isOrthogonalSegment(a, b)) {
		return [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
	}
	const corner = { x: b.x, y: a.y };
	return [
		{ x1: a.x, y1: a.y, x2: corner.x, y2: corner.y },
		{ x1: corner.x, y1: corner.y, x2: b.x, y2: b.y }
	];
}

/**
 * GND power symbols are always drawn upright (triangle pointing down) —
 * standard schematic convention, regardless of which side the stub
 * approaches from. Rotating it to match the stub's outward direction just
 * makes ground symbols point in random directions across the sheet.
 */
export function gndInstanceRotation(): number {
	return 0;
}

/**
 * Attach power:GND so the first wire segment from the GND pin is always
 * straight up on the sheet (KiCad 90 / schematic −Y).
 *
 * When the component pin already faces down, GND hangs directly below the tip.
 * Otherwise an outward (or side) jog clears the part body, then a vertical
 * stem drops to the GND symbol.
 */
export function gndStubFromPin(
	partOrigin: Point2,
	tip: Point2,
	stubLen: number = PIN_STUB_LEN_MM,
	towardBodyRot?: number
): {
	gndPos: Point2;
	junction: Point2;
	segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
	/** Outward direction of the pin stub jog (not the GND stem). */
	pinOutwardRot: number;
} {
	const { outwardRot: pinOutwardRot } = stubAwayFromBody(
		partOrigin,
		tip,
		stubLen,
		towardBodyRot
	);

	let junction: Point2;
	if (pinOutwardRot === 270) {
		// Pin faces down — single vertical stem tip → GND.
		junction = { x: tip.x, y: tip.y };
	}
	else if (pinOutwardRot === 90) {
		// Pin faces up — cannot hang GND above the tip; side-step then drop.
		const dx = tip.x - partOrigin.x;
		const sideRot = Math.abs(dx) < 1e-9 ? 0 : (dx >= 0 ? 0 : 180);
		const off = kicadDirectionOffset(sideRot, stubLen);
		junction = { x: tip.x + off.x, y: tip.y + off.y };
	}
	else {
		// Horizontal outward jog, then vertical stem down to GND.
		const off = kicadDirectionOffset(pinOutwardRot, stubLen);
		junction = { x: tip.x + off.x, y: tip.y + off.y };
	}

	const gndPos = { x: junction.x, y: junction.y + stubLen };
	const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
	if (Math.abs(tip.x - junction.x) > 1e-9 || Math.abs(tip.y - junction.y) > 1e-9) {
		segments.push(...manhattanizeSegment(tip, junction));
	}
	// Junction → GND is always +Y (down); from GND the wire leaves straight up (−Y).
	segments.push({
		x1: junction.x,
		y1: junction.y,
		x2: gndPos.x,
		y2: gndPos.y
	});
	return { gndPos, junction, segments, pinOutwardRot };
}

/**
 * Connect a pin tip to a user-moved power:GND pose. The final segment always
 * arrives from above (sheet −Y → +Y into the symbol) so the wire still leaves
 * GND straight up; earlier segments are Manhattan from tip → approach.
 */
export function gndStubToCustomPos(
	tip: Point2,
	gndPos: Point2,
	stubLen: number = PIN_STUB_LEN_MM
): {
	gndPos: Point2;
	junction: Point2;
	segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
} {
	const junction = { x: gndPos.x, y: gndPos.y - stubLen };
	const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
	if (Math.abs(tip.x - junction.x) > 1e-9 || Math.abs(tip.y - junction.y) > 1e-9) {
		segments.push(...manhattanizeSegment(tip, junction));
	}
	segments.push({
		x1: junction.x,
		y1: junction.y,
		x2: gndPos.x,
		y2: gndPos.y
	});
	return { gndPos, junction, segments };
}

export function rotateLocalExtents(
	hw: number,
	hh: number,
	rotation: number
): { hw: number; hh: number } {
	const r = normalizeRot(rotation);
	if (r === 90 || r === 270) {
		return { hw: hh, hh: hw };
	}
	return { hw, hh };
}

/**
 * Local (library Y-up) graphic AABB: body/polylines ∪ pin tips, no text.
 * Used by {@link bodyAabbForPlacement} before world transform + pad.
 */
export function graphicLocalAabb(
	libId: string,
	pins: PinLocal[] | undefined
): { xmin: number; ymin: number; xmax: number; ymax: number } {
	// power:GND: pin at (0,0); triangle polyline y∈[-2.54,0], x∈[-1.27,1.27]
	// (library Y-up). Do not use a symmetric half-box — that would invent
	// graphic above the pin and invite sideways tip-clearance into the body.
	if (isPowerGndLib(libId)) {
		return { xmin: -1.27, ymin: -2.54, xmax: 1.27, ymax: 0 };
	}
	const passive = PASSIVE_GRAPHIC_HALF[libId];
	if (passive) {
		return {
			xmin: -passive.hw,
			ymin: -passive.hh,
			xmax: passive.hw,
			ymax: passive.hh
		};
	}
	if (pins?.length) {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const pin of pins) {
			minX = Math.min(minX, pin.x);
			minY = Math.min(minY, pin.y);
			maxX = Math.max(maxX, pin.x);
			maxY = Math.max(maxY, pin.y);
		}
		// Pin tips are the outermost graphics on typical IC symbols.
		return {
			xmin: minX,
			ymin: minY,
			xmax: maxX,
			ymax: maxY
		};
	}
	return { xmin: -5, ymin: -5, xmax: 5, ymax: 5 };
}

/**
 * Graphic-extent AABB in world mm, plus padding on every side.
 * Default pad = {@link BODY_PAD_MM} (2 × {@link FINE_GRID_MM}).
 * Pass padMm=0 for unpadded graphic extent (e.g. placement seeding).
 */
export function bodyAabbForPlacement(
	p: PlacementPose,
	icPins: PinLocal[] | undefined,
	padMm: number = BODY_PAD_MM
): Aabb {
	const local = graphicLocalAabb(p.libId, icPins);
	const corners = [
		localToWorld(p.x, p.y, p.rotation, local.xmin, local.ymin),
		localToWorld(p.x, p.y, p.rotation, local.xmin, local.ymax),
		localToWorld(p.x, p.y, p.rotation, local.xmax, local.ymin),
		localToWorld(p.x, p.y, p.rotation, local.xmax, local.ymax)
	];
	let xmin = Infinity;
	let ymin = Infinity;
	let xmax = -Infinity;
	let ymax = -Infinity;
	for (const c of corners) {
		xmin = Math.min(xmin, c.x);
		ymin = Math.min(ymin, c.y);
		xmax = Math.max(xmax, c.x);
		ymax = Math.max(ymax, c.y);
	}
	return {
		xmin: xmin - padMm,
		ymin: ymin - padMm,
		xmax: xmax + padMm,
		ymax: ymax + padMm
	};
}

export function aabbsOverlap(a: Aabb, b: Aabb, gap = 0): boolean {
	return !(
		a.xmax + gap < b.xmin
		|| b.xmax + gap < a.xmin
		|| a.ymax + gap < b.ymin
		|| b.ymax + gap < a.ymin
	);
}

export function pointInAabb(p: Point2, box: Aabb, eps = 1e-6): boolean {
	return (
		p.x > box.xmin + eps
		&& p.x < box.xmax - eps
		&& p.y > box.ymin + eps
		&& p.y < box.ymax - eps
	);
}

/** Axis-aligned segment vs AABB (open interior). Endpoints on boundary OK. */
export function segmentHitsAabb(
	a: Point2,
	b: Point2,
	box: Aabb,
	eps = 1e-4
): boolean {
	const xmin = box.xmin + eps;
	const xmax = box.xmax - eps;
	const ymin = box.ymin + eps;
	const ymax = box.ymax - eps;
	if (xmax <= xmin || ymax <= ymin) {
		return false;
	}

	// Both endpoints outside same side → no hit if segment doesn't cross.
	const dx = b.x - a.x;
	const dy = b.y - a.y;

	// Liang–Barsky clip; if clipped length > 0 and not only touching edge from outside, hit.
	let t0 = 0;
	let t1 = 1;
	const clip = (p: number, q: number): boolean => {
		if (Math.abs(p) < 1e-12) {
			return q >= 0;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) {
				return false;
			}
			if (r > t0) {
				t0 = r;
			}
		}
		else {
			if (r < t0) {
				return false;
			}
			if (r < t1) {
				t1 = r;
			}
		}
		return true;
	};

	if (
		!clip(-dx, a.x - xmin)
		|| !clip(dx, xmax - a.x)
		|| !clip(-dy, a.y - ymin)
		|| !clip(dy, ymax - a.y)
	) {
		return false;
	}
	// Touching only at t=0 or t=1 (endpoint on boundary) is allowed if endpoints are outside interior.
	if (t1 - t0 <= 1e-9) {
		return false;
	}
	const midT = (t0 + t1) / 2;
	const mx = a.x + dx * midT;
	const my = a.y + dy * midT;
	return mx > xmin && mx < xmax && my > ymin && my < ymax;
}

export function manhattan(a: Point2, b: Point2): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function fmtMm(n: number): string {
	const r = Math.round(n * 100) / 100;
	return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/\.?0+$/, '') || '0';
}

export function escapeSexpr(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\r\n/g, '\\n')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\n');
}

/** Proper segment–segment intersection (not mere shared endpoint). */
export function segmentsCross(
	a1: Point2,
	a2: Point2,
	b1: Point2,
	b2: Point2,
	eps = 1e-6
): boolean {
	const orient = (p: Point2, q: Point2, r: Point2): number => {
		const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
		if (Math.abs(v) < eps) {
			return 0;
		}
		return v > 0 ? 1 : 2;
	};
	const onSeg = (p: Point2, q: Point2, r: Point2): boolean =>
		q.x <= Math.max(p.x, r.x) + eps
		&& q.x >= Math.min(p.x, r.x) - eps
		&& q.y <= Math.max(p.y, r.y) + eps
		&& q.y >= Math.min(p.y, r.y) - eps;

	const o1 = orient(a1, a2, b1);
	const o2 = orient(a1, a2, b2);
	const o3 = orient(b1, b2, a1);
	const o4 = orient(b1, b2, a2);

	if (o1 !== o2 && o3 !== o4) {
		// Exclude shared endpoints (T-junctions / same net joins).
		const share =
			(Math.abs(a1.x - b1.x) < eps && Math.abs(a1.y - b1.y) < eps)
			|| (Math.abs(a1.x - b2.x) < eps && Math.abs(a1.y - b2.y) < eps)
			|| (Math.abs(a2.x - b1.x) < eps && Math.abs(a2.y - b1.y) < eps)
			|| (Math.abs(a2.x - b2.x) < eps && Math.abs(a2.y - b2.y) < eps);
		return !share;
	}
	if (o1 === 0 && onSeg(a1, b1, a2)) {
		return false;
	}
	if (o2 === 0 && onSeg(a1, b2, a2)) {
		return false;
	}
	if (o3 === 0 && onSeg(b1, a1, b2)) {
		return false;
	}
	if (o4 === 0 && onSeg(b1, a2, b2)) {
		return false;
	}
	return false;
}
