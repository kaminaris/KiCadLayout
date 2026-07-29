/**
 * Deterministic Manhattan (90?) schematic wire autorouter.
 *
 * Algorithm (industry-standard schematic-style orthogonal routing):
 *  1. Classify nets: gnd | power_rail | signal
 *  2. GND / power rails ? short stubs + power:GND / global_label (no multi-pin maze)
 *  3. Signal nets ? Kruskal MST, then pattern routes (L / Z / U) if clear,
 *     else Lee/maze A* on a fine grid
 *  4. Obstacles: component body AABBs (+ pad), foreign pin tip keep-outs,
 *     and occupied wire edges from previously routed nets (no shared edges;
 *     orthogonal crossings at non-pin grid points are allowed)
 *
 * Not PCB routing ? schematic connectivity only.
 */

const randomUUID = (): string => globalThis.crypto.randomUUID();

import {
	Aabb,
	BODY_PAD_MM,
	FINE_GRID_MM,
	PIN_STUB_LEN_MM,
	PinLocal,
	PlacementPose,
	Point2,
	bodyAabbForPlacement,
	fmtMm,
	gndInstanceRotation,
	gndStubFromPin,
	isPowerGndLib,
	kicadOutwardOffset,
	libPinWorldRotation,
	localToWorld,
	manhattan,
	manhattanizeSegment,
	pointInAabb,
	segmentHitsAabb,
	snapToGrid
} from './Geometry';

/**
 * Cells within this distance of a routed pin tip may enter the body AABB.
 * Tips sit BODY_PAD_MM inside the padded box; allow that margin plus one
 * symbol-grid step along the pin so wires can leave the pad.
 */
const TIP_CLEAR_MM = BODY_PAD_MM + FINE_GRID_MM;
/** Keep-out half-size around foreign pin tips (mm). */
const FOREIGN_PIN_KEEP_MM = FINE_GRID_MM * 0.55;
/**
 * Minimum first-segment length along a pin's outward exit before the wire
 * may bend — avoids the "stub then immediate 90° at the pin" look.
 */
const MIN_EXIT_MM = FINE_GRID_MM * 2;
/** Extra A* cost for a bend while still within this distance of a terminal. */
const NEAR_TERMINAL_BEND_MM = FINE_GRID_MM * 3;
const NEAR_TERMINAL_BEND_PENALTY = FINE_GRID_MM * 4;

/** Body obstacle with optional GND upward-only tip clearance. */
export type BodyObstacle = Aabb & { ref: string; upwardExitOnly?: boolean };

export type NetClass = 'gnd' | 'power_rail' | 'signal';

export interface RouteTerminal {
	ref: string;
	pin: string;
	net: string;
	x: number;
	y: number;
	/** Unit outward direction from the pin tip (away from body). */
	exitDx: number;
	exitDy: number;
}

export interface WireSegment {
	net: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface RouteNetResult {
	net: string;
	segments: WireSegment[];
	routed: boolean;
	terminals: RouteTerminal[];
	netClass: NetClass;
}

export interface AutorouteResult {
	segments: WireSegment[];
	byNet: RouteNetResult[];
	unroutedNets: string[];
	/** Single-terminal signal nets ? tip label only. */
	floatingNets: string[];
	/**
	 * GND / power-rail nets: no maze; Place emits stub + power:GND / global_label
	 * at each terminal.
	 */
	stubNets: string[];
	warnings: string[];
}

export interface AutorouteInput {
	placements: Array<PlacementPose & { pinNets: Record<string, string> }>;
	icPins: PinLocal[];
	pinsForLib: (libId: string) => PinLocal[];
	gridMm?: number;
	netNames?: string[];
}

export function classifyNet(name: string): NetClass {
	const n = name.trim();
	if (/^(GND|AGND|PGND|DGND|SGND|VSS|VSSA|0V|GNDA|GNDP)$/i.test(n)) {
		return 'gnd';
	}
	if (
		/^(VIN|VOUT|VCC|VDD|VBAT|VBUS|PVIN|AVIN|\+?-?\d+(\.\d+)?V|V[A-Z]?\d*)$/i.test(n)
		|| /^\+\d/.test(n)
	) {
		return 'power_rail';
	}
	return 'signal';
}

export function collectTerminals(input: AutorouteInput): Map<string, RouteTerminal[]> {
	const byNet = new Map<string, RouteTerminal[]>();
	for (const p of input.placements) {
		if (isPowerGndLib(p.libId) || p.ref.startsWith('#')) {
			continue;
		}
		const pins = input.pinsForLib(p.libId);
		for (const pin of pins) {
			const net = p.pinNets[pin.number];
			if (!net) {
				continue;
			}
			if (input.netNames && !input.netNames.includes(net)) {
				continue;
			}
			const world = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
			const toward = libPinWorldRotation(pin.rotation, p.rotation);
			const exit = kicadOutwardOffset(toward, 1);
			const list = byNet.get(net) ?? [];
			list.push({
				ref: p.ref,
				pin: pin.number,
				net,
				x: world.x,
				y: world.y,
				exitDx: Math.sign(exit.x),
				exitDy: Math.sign(exit.y)
			});
			byNet.set(net, list);
		}
	}
	return byNet;
}

export function buildBodyObstacles(
	placements: PlacementPose[],
	icPins: PinLocal[]
): BodyObstacle[] {
	return placements.map(p => {
		const isPassive = p.libId.startsWith('Device:') || p.libId.startsWith('power:');
		const box = bodyAabbForPlacement(p, isPassive ? undefined : icPins);
		return {
			...box,
			ref: p.ref,
			// Tip clearance into GND only along the upward stem ? never sideways
			// through the triangle body.
			upwardExitOnly: isPowerGndLib(p.libId) || undefined
		};
	});
}

/**
 * Predicted power:GND instance poses for every GND pin tip (same geometry as
 * Place emit). Included in router/score body obstacles so wires cannot cross
 * GND graphics even though #PWR symbols are not maze terminals.
 *
 * ownerRef is the component that owns the pin ? overlap checks skip
 * owner/own-GND pairs (padded boxes touch along the vertical stem).
 */
export function collectGndPowerPlacements(
	placements: Array<PlacementPose & { pinNets: Record<string, string> }>,
	pinsForLib: (libId: string) => PinLocal[],
	stubLenMm: number = PIN_STUB_LEN_MM
): Array<PlacementPose & { ownerRef: string }> {
	/** User-moved #PWR poses (edit mode) override derived stub positions. */
	const overrides = new Map<string, { x: number; y: number }>();
	for (const p of placements) {
		if (isPowerGndLib(p.libId) || p.ref.startsWith('#PWR')) {
			overrides.set(p.ref, { x: p.x, y: p.y });
		}
	}
	const out: Array<PlacementPose & { ownerRef: string }> = [];
	let pwrIndex = 1;
	for (const p of placements) {
		if (isPowerGndLib(p.libId) || p.ref.startsWith('#')) {
			continue;
		}
		const pins = pinsForLib(p.libId);
		for (const pin of pins) {
			const net = p.pinNets[pin.number];
			if (!net || classifyNet(net) !== 'gnd') {
				continue;
			}
			const tip = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
			const toward = libPinWorldRotation(pin.rotation, p.rotation);
			const { gndPos } = gndStubFromPin({ x: p.x, y: p.y }, tip, stubLenMm, toward);
			const ref = `#PWR${ String(pwrIndex++).padStart(2, '0') }`;
			const ov = overrides.get(ref);
			out.push({
				ref,
				libId: 'power:GND',
				x: ov?.x ?? gndPos.x,
				y: ov?.y ?? gndPos.y,
				rotation: gndInstanceRotation(),
				ownerRef: p.ref
			});
		}
	}
	return out;
}

/** All pin tips in world space with owning net (for foreign-pin keep-outs). */
export function collectAllPinTips(input: AutorouteInput): Array<Point2 & { net: string; ref: string; pin: string }> {
	const out: Array<Point2 & { net: string; ref: string; pin: string }> = [];
	for (const p of input.placements) {
		if (isPowerGndLib(p.libId) || p.ref.startsWith('#')) {
			continue;
		}
		const pins = input.pinsForLib(p.libId);
		for (const pin of pins) {
			const net = p.pinNets[pin.number] ?? '';
			const world = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
			out.push({
				x: world.x,
				y: world.y,
				net,
				ref: p.ref,
				pin: pin.number
			});
		}
	}
	return out;
}

/**
 * Kruskal MST on Manhattan distance for signal nets, then route each edge
 * with pattern (L/Z/U) or Lee/maze A*. GND/power ? stubNets only.
 */
export function autoroute(input: AutorouteInput): AutorouteResult {
	const gridMm = input.gridMm && input.gridMm > 0 ? input.gridMm : FINE_GRID_MM;
	const terminalsByNet = collectTerminals(input);
	const gndPlacements = collectGndPowerPlacements(input.placements, input.pinsForLib);
	const componentPlacements = input.placements.filter(
		p => !isPowerGndLib(p.libId) && !p.ref.startsWith('#')
	);
	const bodies = [
		...buildBodyObstacles(componentPlacements, input.icPins),
		...buildBodyObstacles(gndPlacements, [])
	];
	const allTips = [
		...collectAllPinTips(input),
		// power:GND pin tips ? foreign keep-outs so maze cannot attach sideways.
		...gndPlacements.map(g => ({
			x: g.x,
			y: g.y,
			net: 'GND',
			ref: g.ref,
			pin: '1'
		}))
	];
	const warnings: string[] = [];
	const byNet: RouteNetResult[] = [];
	const allSegments: WireSegment[] = [];
	const unroutedNets: string[] = [];
	const floatingNets: string[] = [];
	const stubNets: string[] = [];

	/** Occupied grid edges from already-routed nets (normalized keys). */
	const blockedEdges = new Set<string>();

	// Route signal nets (and power rails with real nearby fanout) first
	// (shortest total Manhattan MST first) so later nets see denser wire
	// obstacles. Only GND is always a bare stub ? GND pins are so numerous
	// that a maze of ground wires would look worse than a ground symbol at
	// each pin (standard KiCad practice). Power rails (VIN/VOUT/etc.) with
	// 2+ terminals are wired like a real net instead: with pin-aware seed
	// placement, same-rail parts often sit right next to each other, and a
	// separate VOUT/VIN global-label flag at every single pin nearby just
	// overlaps its neighbors ? an actual short wire reads far more like a
	// human-drawn schematic. A power rail with only 1 terminal still has
	// nothing to wire to, so it falls through to the floating-label case.
	const signalEntries: Array<{ net: string; terminals: RouteTerminal[]; span: number; netClass: NetClass }> = [];
	for (const [net, terminals] of terminalsByNet) {
		const netClass = classifyNet(net);
		if (netClass === 'gnd') {
			stubNets.push(net);
			byNet.push({
				net,
				segments: [],
				routed: true,
				terminals,
				netClass
			});
			continue;
		}
		if (terminals.length < 2) {
			if (netClass === 'power_rail') {
				stubNets.push(net);
			}
			else if (terminals.length === 1) {
				floatingNets.push(net);
			}
			byNet.push({
				net,
				segments: [],
				routed: true,
				terminals,
				netClass
			});
			continue;
		}
		let span = 0;
		for (let i = 0; i < terminals.length; i++) {
			for (let j = i + 1; j < terminals.length; j++) {
				span += manhattan(terminals[i]!, terminals[j]!);
			}
		}
		signalEntries.push({ net, terminals, span, netClass });
	}
	signalEntries.sort((a, b) => a.span - b.span || a.net.localeCompare(b.net));

	for (const { net, terminals, netClass } of signalEntries) {
		const edges = mstEdges(terminals);
		const netSegs: WireSegment[] = [];
		let ok = true;
		const netTips = terminals.map(t => ({ x: t.x, y: t.y }));
		const foreignPins = allTips.filter(t => t.net !== net);
		const foreignKeepouts = foreignPins.map(p => pinKeepout(p));

		for (const e of edges) {
			const path = routeEdge(
				{ x: e.a.x, y: e.a.y },
				{ x: e.b.x, y: e.b.y },
				bodies,
				foreignKeepouts,
				blockedEdges,
				gridMm,
				netTips,
				{ x: e.a.exitDx, y: e.a.exitDy },
				{ x: e.b.exitDx, y: e.b.exitDy }
			);
			if (!path || path.length < 2) {
				ok = false;
				warnings.push(
					`Unrouted ${ net }: ${ e.a.ref }.${ e.a.pin } ? ${ e.b.ref }.${ e.b.pin }`
				);
				break;
			}
			for (let i = 0; i < path.length - 1; i++) {
				const p0 = path[i]!;
				const p1 = path[i + 1]!;
				if (Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9) {
					continue;
				}
				netSegs.push({
					net,
					x1: p0.x,
					y1: p0.y,
					x2: p1.x,
					y2: p1.y
				});
			}
		}

		if (!ok) {
			unroutedNets.push(net);
			byNet.push({
				net,
				segments: [],
				routed: false,
				terminals,
				netClass
			});
		}
		else {
			for (const s of netSegs) {
				addSegmentEdges(blockedEdges, s, gridMm);
			}
			allSegments.push(...netSegs);
			byNet.push({
				net,
				segments: netSegs,
				routed: true,
				terminals,
				netClass
			});
		}
	}

	return {
		segments: allSegments,
		byNet,
		unroutedNets,
		floatingNets,
		stubNets,
		warnings
	};
}

interface MstEdge {
	a: RouteTerminal;
	b: RouteTerminal;
	dist: number;
}

function mstEdges(terminals: RouteTerminal[]): MstEdge[] {
	const n = terminals.length;
	const candidates: MstEdge[] = [];
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const a = terminals[i]!;
			const b = terminals[j]!;
			candidates.push({
				a,
				b,
				dist: manhattan(a, b)
			});
		}
	}
	candidates.sort((x, y) => x.dist - y.dist);

	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	const idx = new Map(terminals.map((t, i) => [`${ t.ref }.${ t.pin }`, i]));
	const out: MstEdge[] = [];
	for (const e of candidates) {
		const ia = idx.get(`${ e.a.ref }.${ e.a.pin }`)!;
		const ib = idx.get(`${ e.b.ref }.${ e.b.pin }`)!;
		const ra = find(ia);
		const rb = find(ib);
		if (ra === rb) {
			continue;
		}
		parent[ra] = rb;
		out.push(e);
		if (out.length >= n - 1) {
			break;
		}
	}
	return out;
}

function pinKeepout(p: Point2): Aabb {
	const k = FOREIGN_PIN_KEEP_MM;
	return {
		xmin: p.x - k,
		ymin: p.y - k,
		xmax: p.x + k,
		ymax: p.y + k
	};
}

function routeEdge(
	from: Point2,
	to: Point2,
	bodies: BodyObstacle[],
	foreignKeepouts: Aabb[],
	blockedEdges: Set<string>,
	gridMm: number,
	netTips: Point2[],
	exitFrom: Point2 = { x: 0, y: 0 },
	exitTo: Point2 = { x: 0, y: 0 }
): Point2[] | null {
	const start = { x: from.x, y: from.y };
	const end = { x: to.x, y: to.y };
	const bodyBoxes: BodyObstacle[] = bodies.map(o => ({
		xmin: o.xmin,
		ymin: o.ymin,
		xmax: o.xmax,
		ymax: o.ymax,
		ref: o.ref,
		upwardExitOnly: o.upwardExitOnly
	}));
	const tips = netTips.length ? netTips : [start, end];

	const tryPoly = (pts: Point2[]): Point2[] | null => {
		const cleaned = collapseColinear(pts);
		for (let i = 0; i < cleaned.length - 1; i++) {
			const a = cleaned[i]!;
			const b = cleaned[i + 1]!;
			if (segmentHitsBodies(a, b, bodyBoxes, tips)) {
				return null;
			}
			if (segmentHitsForeignPins(a, b, foreignKeepouts, tips)) {
				return null;
			}
			if (segmentUsesBlockedEdges(a, b, blockedEdges, gridMm)) {
				return null;
			}
		}
		return cleaned;
	};

	const hasExit = (e: Point2): boolean => Math.abs(e.x) + Math.abs(e.y) > 0;
	const exitLen = Math.max(MIN_EXIT_MM, gridMm * 2);
	const startExit = hasExit(exitFrom)
		? { x: start.x + exitFrom.x * exitLen, y: start.y + exitFrom.y * exitLen }
		: null;
	// Approach the destination along its outward exit (last segment into the pin).
	const endApproach = hasExit(exitTo)
		? { x: end.x + exitTo.x * exitLen, y: end.y + exitTo.y * exitLen }
		: null;

	/** Prefer routes whose first step continues in exitFrom. */
	const firstSegMatchesExit = (pts: Point2[]): boolean => {
		if (!hasExit(exitFrom) || pts.length < 2) {
			return true;
		}
		const dx = Math.sign(pts[1]!.x - pts[0]!.x);
		const dy = Math.sign(pts[1]!.y - pts[0]!.y);
		return dx === exitFrom.x && dy === exitFrom.y;
	};

	const candidates: Point2[][] = [];
	const pushCandidate = (pts: Point2[] | null) => {
		if (!pts || pts.length < 2) {
			return;
		}
		candidates.push(pts);
	};

	// --- Straight-exit stubs, then pattern-route the middle ---
	if (startExit && endApproach) {
		pushCandidate(tryPoly([start, startExit, { x: endApproach.x, y: startExit.y }, endApproach, end]));
		pushCandidate(tryPoly([start, startExit, { x: startExit.x, y: endApproach.y }, endApproach, end]));
	}
	if (startExit) {
		pushCandidate(tryPoly([start, startExit, { x: end.x, y: startExit.y }, end]));
		pushCandidate(tryPoly([start, startExit, { x: startExit.x, y: end.y }, end]));
	}
	if (endApproach) {
		pushCandidate(tryPoly([start, { x: endApproach.x, y: start.y }, endApproach, end]));
		pushCandidate(tryPoly([start, { x: start.x, y: endApproach.y }, endApproach, end]));
	}

	// --- Pattern routes (L, then Z/U) before maze ---
	if (Math.abs(start.x - end.x) > 1e-6 && Math.abs(start.y - end.y) > 1e-6) {
		pushCandidate(tryPoly([start, { x: end.x, y: start.y }, end]));
		pushCandidate(tryPoly([start, { x: start.x, y: end.y }, end]));
	}
	else {
		pushCandidate(tryPoly([start, end]));
	}

	const offsets = [
		gridMm * 2, gridMm * 4, gridMm * 6, gridMm * 8, gridMm * 12, gridMm * 20,
		-gridMm * 2, -gridMm * 4, -gridMm * 6, -gridMm * 8, -gridMm * 12, -gridMm * 20
	];
	for (const off of offsets) {
		pushCandidate(tryPoly([
			start,
			{ x: start.x + off, y: start.y },
			{ x: start.x + off, y: end.y },
			end
		]));
		pushCandidate(tryPoly([
			start,
			{ x: start.x, y: start.y + off },
			{ x: end.x, y: start.y + off },
			end
		]));
		const farY = Math.max(start.y, end.y) + Math.abs(off);
		const nearY = Math.min(start.y, end.y) - Math.abs(off);
		for (const yy of [farY, nearY]) {
			pushCandidate(tryPoly([
				start,
				{ x: start.x, y: yy },
				{ x: end.x, y: yy },
				end
			]));
		}
		const farX = Math.max(start.x, end.x) + Math.abs(off);
		const nearX = Math.min(start.x, end.x) - Math.abs(off);
		for (const xx of [farX, nearX]) {
			pushCandidate(tryPoly([
				start,
				{ x: xx, y: start.y },
				{ x: xx, y: end.y },
				end
			]));
		}
	}

	if (candidates.length) {
		candidates.sort((a, b) => {
			const aExit = firstSegMatchesExit(a) ? 0 : 1;
			const bExit = firstSegMatchesExit(b) ? 0 : 1;
			if (aExit !== bExit) {
				return aExit - bExit;
			}
			const aLen = pathLength(a);
			const bLen = pathLength(b);
			return aLen - bLen || a.length - b.length;
		});
		return candidates[0]!;
	}

	// --- Lee / maze A* on fine grid (biased toward straight exits) ---
	const a = {
		x: snapToGrid(start.x, gridMm),
		y: snapToGrid(start.y, gridMm)
	};
	const b = {
		x: snapToGrid(end.x, gridMm),
		y: snapToGrid(end.y, gridMm)
	};
	const astar = gridAStar(
		a, b, bodyBoxes, foreignKeepouts, blockedEdges, gridMm, tips,
		exitFrom, exitTo
	);
	if (!astar || astar.length < 2) {
		return null;
	}
	return tryPoly([start, ...astar.slice(1, -1), end]);
}

function pathLength(pts: Point2[]): number {
	let len = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		len += manhattan(pts[i]!, pts[i + 1]!);
	}
	return len;
}

function nearNetTip(p: Point2, tips: Point2[], clearMm = TIP_CLEAR_MM): boolean {
	for (const tip of tips) {
		if (manhattan(p, tip) <= clearMm + 1e-6) {
			return true;
		}
	}
	return false;
}

/**
 * Tip clearance for power:GND bodies: only the upward stem (same X, at or
 * above the pin tip in schematic Y-down). Blocks sideways / downward entry
 * through the triangle via the omnidirectional tip bubble.
 */
function nearGndUpwardStem(p: Point2, tips: Point2[], clearMm = TIP_CLEAR_MM): boolean {
	for (const tip of tips) {
		if (p.y > tip.y + 1e-6) {
			continue;
		}
		if (Math.abs(p.x - tip.x) > FINE_GRID_MM + 1e-6) {
			continue;
		}
		if (manhattan(p, tip) <= clearMm + 1e-6) {
			return true;
		}
	}
	return false;
}

/**
 * True if the segment crosses a body interior outside pin-tip clearance.
 * Endpoints on/near tips are allowed so wires can leave the pad.
 *
 * Exported so scoreLayout() (CircuitDesignScore.ts) can use the EXACT same
 * body-collision test the router itself used to accept the route in the
 * first place ? it previously called the router's raw segmentHitsAabb()
 * directly, with no tip-clearance exemption. A wire leaving its own pin is
 * necessarily right at (often technically inside) its own component's body
 * AABB; the router correctly allows that, but the scorer flagged it as a
 * permanent bodyCollisions=1 that no amount of moving OTHER parts could
 * ever clear ? since the "collision" wasn't a real defect, just this
 * mismatch between the two checks. Confirmed via a real optimize run stuck
 * at an identical bodyHits=1 for 15+ iterations regardless of which part
 * was nudged.
 */
export function segmentHitsBodies(
	a: Point2,
	b: Point2,
	bodies: Array<Aabb & { upwardExitOnly?: boolean }>,
	tips: Point2[]
): boolean {
	for (const box of bodies) {
		if (!segmentHitsAabb(a, b, box)) {
			continue;
		}
		const len = manhattan(a, b);
		const steps = Math.max(2, Math.ceil(len / (FINE_GRID_MM * 0.5)));
		let interiorHit = false;
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
			if (!pointInAabb(p, box)) {
				continue;
			}
			const cleared = box.upwardExitOnly
				? nearGndUpwardStem(p, tips)
				: nearNetTip(p, tips);
			if (cleared) {
				continue;
			}
			interiorHit = true;
			break;
		}
		if (interiorHit) {
			return true;
		}
	}
	return false;
}

/** Wire must not touch / cross foreign pin keep-outs (except own-net tip clearance). */
function segmentHitsForeignPins(
	a: Point2,
	b: Point2,
	keepouts: Aabb[],
	tips: Point2[]
): boolean {
	for (const box of keepouts) {
		const len = manhattan(a, b);
		const steps = Math.max(2, Math.ceil(len / (FINE_GRID_MM * 0.4)));
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
			// Slightly expanded keep-out (negative eps) so grazing counts as a hit.
			if (!pointInAabb(p, box, -1e-4)) {
				continue;
			}
			if (nearNetTip(p, tips, TIP_CLEAR_MM * 0.5)) {
				continue;
			}
			return true;
		}
	}
	return false;
}

function edgeKey(a: Point2, b: Point2): string {
	const k1 = `${ a.x.toFixed(3) },${ a.y.toFixed(3) }`;
	const k2 = `${ b.x.toFixed(3) },${ b.y.toFixed(3) }`;
	return k1 < k2 ? `${ k1 }|${ k2 }` : `${ k2 }|${ k1 }`;
}

function addSegmentEdges(blocked: Set<string>, seg: WireSegment, gridMm: number): void {
	const a = { x: seg.x1, y: seg.y1 };
	const b = { x: seg.x2, y: seg.y2 };
	const dx = Math.sign(b.x - a.x);
	const dy = Math.sign(b.y - a.y);
	if (dx === 0 && dy === 0) {
		return;
	}
	// Walk grid steps along axis-aligned segment.
	const len = manhattan(a, b);
	const steps = Math.max(1, Math.round(len / gridMm));
	let cx = snapToGrid(a.x, gridMm);
	let cy = snapToGrid(a.y, gridMm);
	const ex = snapToGrid(b.x, gridMm);
	const ey = snapToGrid(b.y, gridMm);
	for (let i = 0; i < steps + 8; i++) {
		if (Math.abs(cx - ex) < 1e-6 && Math.abs(cy - ey) < 1e-6) {
			break;
		}
		const nx = dx !== 0 ? snapToGrid(cx + dx * gridMm, gridMm) : cx;
		const ny = dy !== 0 ? snapToGrid(cy + dy * gridMm, gridMm) : cy;
		blocked.add(edgeKey({ x: cx, y: cy }, { x: nx, y: ny }));
		cx = nx;
		cy = ny;
		if (i > steps + 4) {
			break;
		}
	}
}

function segmentUsesBlockedEdges(
	a: Point2,
	b: Point2,
	blocked: Set<string>,
	gridMm: number
): boolean {
	if (!blocked.size) {
		return false;
	}
	const dx = Math.sign(b.x - a.x);
	const dy = Math.sign(b.y - a.y);
	if (dx === 0 && dy === 0) {
		return false;
	}
	const len = manhattan(a, b);
	const steps = Math.max(1, Math.round(len / gridMm));
	let cx = snapToGrid(a.x, gridMm);
	let cy = snapToGrid(a.y, gridMm);
	const ex = snapToGrid(b.x, gridMm);
	const ey = snapToGrid(b.y, gridMm);
	for (let i = 0; i < steps + 8; i++) {
		if (Math.abs(cx - ex) < 1e-6 && Math.abs(cy - ey) < 1e-6) {
			break;
		}
		const nx = dx !== 0 ? snapToGrid(cx + dx * gridMm, gridMm) : cx;
		const ny = dy !== 0 ? snapToGrid(cy + dy * gridMm, gridMm) : cy;
		if (blocked.has(edgeKey({ x: cx, y: cy }, { x: nx, y: ny }))) {
			return true;
		}
		cx = nx;
		cy = ny;
		if (i > steps + 4) {
			break;
		}
	}
	return false;
}

function collapseColinear(pts: Point2[]): Point2[] {
	if (pts.length <= 2) {
		return pts;
	}
	const out: Point2[] = [pts[0]!];
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = out[out.length - 1]!;
		const cur = pts[i]!;
		const next = pts[i + 1]!;
		const colinear =
			(Math.abs(prev.x - cur.x) < 1e-9 && Math.abs(cur.x - next.x) < 1e-9)
			|| (Math.abs(prev.y - cur.y) < 1e-9 && Math.abs(cur.y - next.y) < 1e-9);
		if (!colinear) {
			out.push(cur);
		}
	}
	out.push(pts[pts.length - 1]!);
	return out;
}

function cellBlocked(
	p: Point2,
	obstacles: Array<Aabb & { upwardExitOnly?: boolean }>,
	foreignKeepouts: Aabb[],
	tips: Point2[]
): boolean {
	for (const box of obstacles) {
		if (!pointInAabb(p, box)) {
			continue;
		}
		const cleared = box.upwardExitOnly
			? nearGndUpwardStem(p, tips)
			: nearNetTip(p, tips);
		if (cleared) {
			continue;
		}
		return true;
	}
	if (nearNetTip(p, tips)) {
		return false;
	}
	for (const box of foreignKeepouts) {
		if (pointInAabb(p, box, -1e-4)) {
			return true;
		}
	}
	return false;
}

function gridAStar(
	start: Point2,
	goal: Point2,
	obstacles: Array<Aabb & { upwardExitOnly?: boolean }>,
	foreignKeepouts: Aabb[],
	blockedEdges: Set<string>,
	gridMm: number,
	tips: Point2[],
	exitFrom: Point2 = { x: 0, y: 0 },
	exitTo: Point2 = { x: 0, y: 0 }
): Point2[] | null {
	const key = (p: Point2): string => `${ p.x.toFixed(3) },${ p.y.toFixed(3) }`;
	type Node = { p: Point2; g: number; f: number; dirX: number; dirY: number };
	const open = new Map<string, Node>();
	const parent = new Map<string, string | null>();
	const gScore = new Map<string, number>();
	const closed = new Set<string>();

	const sk = key(start);
	open.set(sk, { p: start, g: 0, f: manhattan(start, goal), dirX: 0, dirY: 0 });
	gScore.set(sk, 0);
	parent.set(sk, null);

	const maxExpand = 40_000;
	let expands = 0;
	const pad = gridMm * 80;
	const minX = Math.min(start.x, goal.x) - pad;
	const maxX = Math.max(start.x, goal.x) + pad;
	const minY = Math.min(start.y, goal.y) - pad;
	const maxY = Math.max(start.y, goal.y) + pad;
	const hasExitFrom = Math.abs(exitFrom.x) + Math.abs(exitFrom.y) > 0;
	const hasExitTo = Math.abs(exitTo.x) + Math.abs(exitTo.y) > 0;

	while (open.size && expands < maxExpand) {
		expands++;
		let bestK = '';
		let bestF = Infinity;
		for (const [k, n] of open) {
			if (n.f < bestF) {
				bestF = n.f;
				bestK = k;
			}
		}
		const cur = open.get(bestK)!;
		open.delete(bestK);
		if (closed.has(bestK)) {
			continue;
		}
		closed.add(bestK);

		if (Math.abs(cur.p.x - goal.x) < 1e-6 && Math.abs(cur.p.y - goal.y) < 1e-6) {
			const path: Point2[] = [];
			let ck: string | null = bestK;
			while (ck) {
				path.push(parseKey(ck));
				ck = parent.get(ck) ?? null;
			}
			path.reverse();
			return path;
		}

		for (const d of [
			{ x: gridMm, y: 0 },
			{ x: -gridMm, y: 0 },
			{ x: 0, y: gridMm },
			{ x: 0, y: -gridMm }
		]) {
			const np = {
				x: snapToGrid(cur.p.x + d.x, gridMm),
				y: snapToGrid(cur.p.y + d.y, gridMm)
			};
			if (np.x < minX || np.x > maxX || np.y < minY || np.y > maxY) {
				continue;
			}
			const nk = key(np);
			if (closed.has(nk)) {
				continue;
			}
			if (blockedEdges.has(edgeKey(cur.p, np))) {
				continue;
			}
			if (cellBlocked(np, obstacles, foreignKeepouts, tips)) {
				continue;
			}
			if (segmentHitsBodies(cur.p, np, obstacles, tips)) {
				continue;
			}
			if (segmentHitsForeignPins(cur.p, np, foreignKeepouts, tips)) {
				continue;
			}
			const stepDx = Math.sign(d.x);
			const stepDy = Math.sign(d.y);
			let stepCost = gridMm;
			// Prefer the pin's outward exit for the first step from the terminal.
			if (hasExitFrom && parent.get(bestK) === null) {
				if (stepDx !== exitFrom.x || stepDy !== exitFrom.y) {
					stepCost += NEAR_TERMINAL_BEND_PENALTY;
				}
			}
			// Prefer arriving along the destination pin's outward exit.
			if (hasExitTo && Math.abs(np.x - goal.x) < 1e-6 && Math.abs(np.y - goal.y) < 1e-6) {
				if (stepDx !== -exitTo.x || stepDy !== -exitTo.y) {
					stepCost += NEAR_TERMINAL_BEND_PENALTY;
				}
			}
			const bending = cur.dirX !== 0 || cur.dirY !== 0
				? (stepDx !== cur.dirX || stepDy !== cur.dirY)
				: false;
			if (bending) {
				const nearStart = manhattan(cur.p, start) <= NEAR_TERMINAL_BEND_MM;
				const nearGoal = manhattan(cur.p, goal) <= NEAR_TERMINAL_BEND_MM;
				if (nearStart || nearGoal) {
					stepCost += NEAR_TERMINAL_BEND_PENALTY;
				}
			}
			const ng = cur.g + stepCost;
			if ((gScore.get(nk) ?? Infinity) <= ng) {
				continue;
			}
			gScore.set(nk, ng);
			parent.set(nk, bestK);
			open.set(nk, {
				p: np,
				g: ng,
				f: ng + manhattan(np, goal),
				dirX: stepDx,
				dirY: stepDy
			});
		}
	}
	return null;
}

function parseKey(k: string): Point2 {
	const [xs, ys] = k.split(',');
	return { x: Number(xs), y: Number(ys) };
}

export function emitWireSexpr(seg: WireSegment): string {
	return `
(wire (pts (xy ${ fmtMm(seg.x1) } ${ fmtMm(seg.y1) }) (xy ${ fmtMm(seg.x2) } ${ fmtMm(seg.y2) }))
  (stroke (width 0) (type default))
  (uuid "${ randomUUID() }")
)
`.trim();
}

/** Emit wires; force Manhattan (split any accidental diagonal into an L). */
export function emitWiresSexpr(segments: WireSegment[]): string {
	const ortho: WireSegment[] = [];
	for (const seg of segments) {
		const parts = manhattanizeSegment(
			{ x: seg.x1, y: seg.y1 },
			{ x: seg.x2, y: seg.y2 }
		);
		for (const p of parts) {
			ortho.push({
				net: seg.net,
				x1: p.x1,
				y1: p.y1,
				x2: p.x2,
				y2: p.y2
			});
		}
	}
	return ortho.map(emitWireSexpr).join('\n\n');
}
