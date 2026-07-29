/**
 * Pure layout score for circuit-design optimize loop.
 * Lower total is better. Body collisions, foreign pin touches, and unrouted
 * nets are hard penalties.
 */

import {
	Aabb,
	FINE_GRID_MM,
	PinLocal,
	PlacementPose,
	Point2,
	aabbsOverlap,
	bodyAabbForPlacement,
	localToWorld,
	manhattan,
	segmentsCross
} from './Geometry';
import type { WireSegment } from './Router';
import { buildBodyObstacles, collectGndPowerPlacements, segmentHitsBodies } from './Router';

/** Weight per 90° bend. */
export const BEND_WEIGHT = 5;
/** Weight per wire–wire crossing (different nets). */
export const CROSSING_WEIGHT = 12;
/** Soft penalty for coincident/overlapping wire edges (same grid edge). */
export const EDGE_OVERLAP_WEIGHT = 80;
/** Hard illegal: wire through body. */
export const BODY_COLLISION_PENALTY = 1_000_000;
/** Hard illegal: wire touches a pin not on that net. */
export const FOREIGN_PIN_PENALTY = 500_000;
/** Hard fail: net not fully routed. */
export const UNROUTED_PENALTY = 100_000;
/** Soft penalty for overlapping component bodies. */
export const OVERLAP_PENALTY = 50_000;
/**
 * Weight per mm of (part center → IC center) distance, summed over all
 * passives. A single long straight wire from a far-off part costs the same
 * per mm as a short one in wireLengthMm, and costs nothing extra in bends —
 * so a random-walk optimizer (simulated annealing) has no pressure to keep
 * parts close to the IC once a straight run is established, and can drift a
 * part arbitrarily far from the rest of the schematic over many iterations.
 * This term is deliberately small relative to BEND_WEIGHT so it never wins
 * against a genuinely better route; it only tie-breaks against spreading out
 * for no routing benefit.
 */
export const SPREAD_WEIGHT = 0.3;

export interface LayoutScore {
	total: number;
	wireLengthMm: number;
	bendCount: number;
	crossings: number;
	edgeOverlaps: number;
	bodyCollisions: number;
	foreignPinHits: number;
	unroutedNets: number;
	overlaps: number;
	spreadMm: number;
	illegal: boolean;
	breakdown: string;
}

export interface ScoreInput {
	placements: Array<PlacementPose & { pinNets?: Record<string, string>; libId: string }>;
	icPins: PinLocal[];
	segments: WireSegment[];
	unroutedNets: string[];
	/** Optional pin lookup; defaults to empty for Device/power, icPins otherwise. */
	pinsForLib?: (libId: string) => PinLocal[];
}

export function scoreLayout(input: ScoreInput): LayoutScore {
	const pinsForLib = input.pinsForLib
		?? ((libId: string) =>
			(libId.startsWith('Device:') || libId.startsWith('power:')
				? []
				: input.icPins));
	const gndPlacements = collectGndPowerPlacements(
		input.placements.map(p => ({
			...p,
			pinNets: p.pinNets ?? {}
		})),
		pinsForLib
	);
	const componentPlacements = input.placements.filter(
		p => p.libId !== 'power:GND' && !p.ref.startsWith('#')
	);
	const bodies = [
		...buildBodyObstacles(componentPlacements, input.icPins),
		...buildBodyObstacles(gndPlacements, [])
	];
	// Map body index → owner ref for skipping owner↔own-GND overlap.
	const bodyOwnerRef = [
		...componentPlacements.map(p => p.ref),
		...gndPlacements.map(g => g.ownerRef)
	];
	const bodyIsGnd = [
		...componentPlacements.map(() => false),
		...gndPlacements.map(() => true)
	];
	let wireLengthMm = 0;
	let bendCount = 0;
	let bodyCollisions = 0;
	let crossings = 0;
	let foreignPinHits = 0;
	let edgeOverlaps = 0;

	const pinTips = collectScorePinTips(input);
	const keep = FINE_GRID_MM * 0.55;

	// Per-net tip points, for the SAME "wire may touch its own net's pins"
	// exemption the router itself used when it accepted this route (see
	// segmentHitsBodies's doc comment).
	const tipsByNet = new Map<string, Point2[]>();
	for (const tip of pinTips) {
		const list = tipsByNet.get(tip.net) ?? [];
		list.push({ x: tip.x, y: tip.y });
		tipsByNet.set(tip.net, list);
	}

	// Group consecutive segments by net for bend counting at joints.
	const byNet = new Map<string, WireSegment[]>();
	for (const s of input.segments) {
		wireLengthMm += manhattan(
			{ x: s.x1, y: s.y1 },
			{ x: s.x2, y: s.y2 }
		);
		const list = byNet.get(s.net) ?? [];
		list.push(s);
		byNet.set(s.net, list);

		const netTips = tipsByNet.get(s.net) ?? [];
		for (const box of bodies) {
			if (segmentHitsBodies(
				{ x: s.x1, y: s.y1 },
				{ x: s.x2, y: s.y2 },
				[box],
				netTips
			)) {
				bodyCollisions++;
			}
		}

		for (const tip of pinTips) {
			if (tip.net === s.net) {
				continue;
			}
			if (segmentNearPoint(
				{ x: s.x1, y: s.y1 },
				{ x: s.x2, y: s.y2 },
				tip,
				keep
			)) {
				foreignPinHits++;
			}
		}
	}

	for (const segs of byNet.values()) {
		bendCount += countBends(segs);
	}

	for (let i = 0; i < input.segments.length; i++) {
		const a = input.segments[i]!;
		for (let j = i + 1; j < input.segments.length; j++) {
			const b = input.segments[j]!;
			if (a.net === b.net) {
				continue;
			}
			if (segmentsCross(
				{ x: a.x1, y: a.y1 },
				{ x: a.x2, y: a.y2 },
				{ x: b.x1, y: b.y1 },
				{ x: b.x2, y: b.y2 }
			)) {
				crossings++;
			}
			if (segmentsCoincide(a, b)) {
				edgeOverlaps++;
			}
		}
	}

	let overlaps = 0;
	for (let i = 0; i < bodies.length; i++) {
		for (let j = i + 1; j < bodies.length; j++) {
			// #PWR GND ↔ #PWR GND: multi-GND ICs place symbols within one pad of
			// each other by construction — not a placement defect. (Still routing
			// obstacles so wires cannot cross either triangle.)
			if (bodyIsGnd[i] && bodyIsGnd[j]) {
				continue;
			}
			// Owner part ↔ its own #PWR GND: padded boxes touch on the stem — not a defect.
			if (bodyIsGnd[i] !== bodyIsGnd[j]) {
				const gndIdx = bodyIsGnd[i] ? i : j;
				const partIdx = bodyIsGnd[i] ? j : i;
				if (bodyOwnerRef[gndIdx] === bodyOwnerRef[partIdx]) {
					continue;
				}
			}
			// AABBs already include 2-grid graphic margin; any overlap is illegal.
			if (aabbsOverlap(bodies[i]!, bodies[j]!)) {
				overlaps++;
			}
		}
	}

	let spreadMm = 0;
	const icPlacement = input.placements.find(
		p => !(p.libId.startsWith('Device:') || p.libId.startsWith('power:'))
	);
	if (icPlacement) {
		for (const p of input.placements) {
			if (p === icPlacement) {
				continue;
			}
			spreadMm += manhattan({ x: p.x, y: p.y }, { x: icPlacement.x, y: icPlacement.y });
		}
	}

	const unroutedNets = input.unroutedNets.length;
	const total =
		wireLengthMm
		+ bendCount * BEND_WEIGHT
		+ crossings * CROSSING_WEIGHT
		+ edgeOverlaps * EDGE_OVERLAP_WEIGHT
		+ bodyCollisions * BODY_COLLISION_PENALTY
		+ foreignPinHits * FOREIGN_PIN_PENALTY
		+ unroutedNets * UNROUTED_PENALTY
		+ overlaps * OVERLAP_PENALTY
		+ spreadMm * SPREAD_WEIGHT;

	const illegal =
		bodyCollisions > 0
		|| foreignPinHits > 0
		|| unroutedNets > 0
		|| overlaps > 0;
	const breakdown =
		`len=${ wireLengthMm.toFixed(1) }mm`
		+ ` bends=${ bendCount }`
		+ ` cross=${ crossings }`
		+ ` edgeOv=${ edgeOverlaps }`
		+ ` bodyHits=${ bodyCollisions }`
		+ ` pinHits=${ foreignPinHits }`
		+ ` unrouted=${ unroutedNets }`
		+ ` overlap=${ overlaps }`
		+ ` spread=${ spreadMm.toFixed(0) }mm`
		+ ` → ${ total.toFixed(1) }`;

	return {
		total,
		wireLengthMm,
		bendCount,
		crossings,
		edgeOverlaps,
		bodyCollisions,
		foreignPinHits,
		unroutedNets,
		overlaps,
		spreadMm,
		illegal,
		breakdown
	};
}

function collectScorePinTips(input: ScoreInput): Array<Point2 & { net: string }> {
	const out: Array<Point2 & { net: string }> = [];
	for (const p of input.placements) {
		if (p.libId === 'power:GND' || p.ref.startsWith('#')) {
			continue;
		}
		const pins = input.pinsForLib
			? input.pinsForLib(p.libId)
			: (p.libId.startsWith('Device:') || p.libId.startsWith('power:')
				? []
				: input.icPins);
		const pinNets = p.pinNets ?? {};
		for (const pin of pins) {
			const net = pinNets[pin.number] ?? '';
			const w = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
			out.push({ x: w.x, y: w.y, net });
		}
	}
	return out;
}

function segmentNearPoint(a: Point2, b: Point2, p: Point2, keepMm: number): boolean {
	const len = manhattan(a, b);
	const steps = Math.max(2, Math.ceil(len / (FINE_GRID_MM * 0.4)));
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		if (manhattan(q, p) <= keepMm + 1e-6) {
			return true;
		}
	}
	return false;
}

/** Axis-aligned segments that share a positive-length overlap (coincide). */
function segmentsCoincide(a: WireSegment, b: WireSegment, eps = 1e-4): boolean {
	const aH = Math.abs(a.y1 - a.y2) < eps;
	const bH = Math.abs(b.y1 - b.y2) < eps;
	const aV = Math.abs(a.x1 - a.x2) < eps;
	const bV = Math.abs(b.x1 - b.x2) < eps;
	if (aH && bH && Math.abs(a.y1 - b.y1) < eps) {
		const a0 = Math.min(a.x1, a.x2);
		const a1 = Math.max(a.x1, a.x2);
		const b0 = Math.min(b.x1, b.x2);
		const b1 = Math.max(b.x1, b.x2);
		return Math.min(a1, b1) - Math.max(a0, b0) > eps;
	}
	if (aV && bV && Math.abs(a.x1 - b.x1) < eps) {
		const a0 = Math.min(a.y1, a.y2);
		const a1 = Math.max(a.y1, a.y2);
		const b0 = Math.min(b.y1, b.y2);
		const b1 = Math.max(b.y1, b.y2);
		return Math.min(a1, b1) - Math.max(a0, b0) > eps;
	}
	return false;
}

function countBends(segs: WireSegment[]): number {
	// Count direction changes at shared endpoints (polyline joints).
	const adj = new Map<string, Array<{ x: number; y: number }>>();
	const k = (x: number, y: number): string => `${ x.toFixed(3) },${ y.toFixed(3) }`;
	const add = (x1: number, y1: number, x2: number, y2: number) => {
		const ka = k(x1, y1);
		const list = adj.get(ka) ?? [];
		list.push({ x: x2, y: y2 });
		adj.set(ka, list);
	};
	for (const s of segs) {
		add(s.x1, s.y1, s.x2, s.y2);
		add(s.x2, s.y2, s.x1, s.y1);
	}

	let bends = 0;
	for (const [key, neighbors] of adj) {
		if (neighbors.length !== 2) {
			continue;
		}
		const [xs, ys] = key.split(',').map(Number);
		const p = { x: xs!, y: ys! };
		const a = neighbors[0]!;
		const b = neighbors[1]!;
		const dx1 = Math.sign(a.x - p.x);
		const dy1 = Math.sign(a.y - p.y);
		const dx2 = Math.sign(b.x - p.x);
		const dy2 = Math.sign(b.y - p.y);
		// Colinear opposite → no bend; otherwise 90° bend.
		if (!(dx1 === -dx2 && dy1 === -dy2)) {
			bends++;
		}
	}
	return bends;
}

export function placementsOverlap(
	placements: Array<PlacementPose & { pinNets?: Record<string, string> }>,
	icPins: PinLocal[],
	pinsForLib?: (libId: string) => PinLocal[]
): boolean {
	const resolvePins = pinsForLib
		?? ((libId: string) =>
			(libId.startsWith('Device:') || libId.startsWith('power:')
				? []
				: icPins));
	const withNets = placements.map(p => ({
		...p,
		pinNets: p.pinNets ?? {}
	}));
	const gndPlacements = collectGndPowerPlacements(withNets, resolvePins);
	const componentPlacements = placements.filter(
		p => p.libId !== 'power:GND' && !p.ref.startsWith('#')
	);
	const bodies: Aabb[] = [
		...componentPlacements.map(p => {
			const isPassive = p.libId.startsWith('Device:') || p.libId.startsWith('power:');
			return bodyAabbForPlacement(p, isPassive ? undefined : icPins);
		}),
		...gndPlacements.map(p => bodyAabbForPlacement(p, undefined))
	];
	const nParts = componentPlacements.length;
	for (let i = 0; i < bodies.length; i++) {
		for (let j = i + 1; j < bodies.length; j++) {
			const aIsGnd = i >= nParts;
			const bIsGnd = j >= nParts;
			// Adjacent IC GND pins → overlapping #PWR boxes; ignore (see scoreLayout).
			if (aIsGnd && bIsGnd) {
				continue;
			}
			if (aIsGnd !== bIsGnd) {
				const gnd = aIsGnd ? gndPlacements[i - nParts]! : gndPlacements[j - nParts]!;
				const part = aIsGnd ? componentPlacements[j]! : componentPlacements[i]!;
				if (gnd.ownerRef === part.ref) {
					continue;
				}
			}
			if (aabbsOverlap(bodies[i]!, bodies[j]!)) {
				return true;
			}
		}
	}
	return false;
}
