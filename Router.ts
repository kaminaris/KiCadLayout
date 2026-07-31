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
/** Schematic wires should stay visually simple even when a longer path exists. */
const BEND_PENALTY = FINE_GRID_MM * 16;

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

/**
 * A fixed net terminal that is NOT a component pin — a preserved global /
 * hierarchical label or a power-rail symbol (e.g. +3.3V). The router wires the
 * net's component pins to it at its `x,y` (its connection point). Its net name
 * matches the locked netlist (the flood-fill names the net after the label /
 * rail), so it merges with the component pins on that net.
 */
export interface FixedTerminal {
	/** Unique id used for MST keying / debug (e.g. "#PWR039", "#GLABEL:2"). */
	ref: string;
	net: string;
	x: number;
	y: number;
	/** Optional outward exit unit dir; 0,0 = router chooses. */
	exitDx?: number;
	exitDy?: number;
}

export interface WireSegment {
	net: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/**
	 * True when this segment is a *forced* connection the router could not
	 * route cleanly (straight or single 90° L). The net is still electrically
	 * connected, so no error — but the wire is flagged (emitted red) so the
	 * user knows to prettify by moving parts apart.
	 */
	invalid?: boolean;
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
	/**
	 * Nets that contain at least one forced (invalid/red) segment. Every net is
	 * always fully connected — this is the "needs prettifying" list, not errors.
	 */
	invalidNets: string[];
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
	/** Preserved label / power-rail terminals to wire the net's pins to. */
	fixedTerminals?: FixedTerminal[];
	/**
	 * Nets that are GROUND (have a power:GND symbol in the source). Authoritative
	 * over the name heuristic — these are always stubbed to ground symbols, never
	 * wired or labelled, regardless of the net's name.
	 */
	gndNets?: Set<string>;
}

/**
 * Name-based ground heuristic. Only a fallback — the reliable signal is a
 * `power:GND` symbol on the net (see LockNetlist `gndNets`), which catches
 * ground nets renamed by a global label or an unusual ground name.
 */
export function isGndNetName(name: string): boolean {
	const n = name.trim();
	return /^(A|D|P|S|E)?GND([A-Z]|\d+)?$/i.test(n)
		|| /^(VSS|VSSA|0V)$/i.test(n);
}

export function classifyNet(name: string): NetClass {
	const n = name.trim();
	if (isGndNetName(n)) {
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
	// Preserved label / power-rail terminals join their net by name.
	for (const ft of input.fixedTerminals ?? []) {
		if (!ft.net) {
			continue;
		}
		if (input.netNames && !input.netNames.includes(ft.net)) {
			continue;
		}
		const list = byNet.get(ft.net) ?? [];
		list.push({
			ref: ft.ref,
			pin: '',
			net: ft.net,
			x: ft.x,
			y: ft.y,
			exitDx: ft.exitDx ?? 0,
			exitDy: ft.exitDy ?? 0
		});
		byNet.set(ft.net, list);
	}
	return byNet;
}

export function buildBodyObstacles(
	placements: PlacementPose[],
	pinsForLib: (libId: string) => PinLocal[],
	/** Extra physical clearance around graphics; drag rewire uses a tiny value. */
	padMm: number = BODY_PAD_MM,
): BodyObstacle[] {
	return placements.map(p => {
		const isPassive = p.libId.startsWith('Device:') || p.libId.startsWith('power:');
		const box = bodyAabbForPlacement(
			p,
			isPassive ? undefined : pinsForLib(p.libId),
			padMm,
		);
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
	stubLenMm: number = PIN_STUB_LEN_MM,
	gndNets?: Set<string>
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
			if (!net || !(gndNets?.has(net) || classifyNet(net) === 'gnd')) {
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
	const gndPlacements = collectGndPowerPlacements(
		input.placements, input.pinsForLib, PIN_STUB_LEN_MM, input.gndNets
	);
	const componentPlacements = input.placements.filter(
		p => !isPowerGndLib(p.libId) && !p.ref.startsWith('#')
	);
	const bodies = [
		...buildBodyObstacles(componentPlacements, input.pinsForLib),
		...buildBodyObstacles(gndPlacements, () => [])
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
		})),
		// Preserved label / rail connection points are keep-outs for other nets.
		...(input.fixedTerminals ?? []).map(ft => ({
			x: ft.x,
			y: ft.y,
			net: ft.net,
			ref: ft.ref,
			pin: ''
		}))
	];
	const warnings: string[] = [];
	const byNet: RouteNetResult[] = [];
	const allSegments: WireSegment[] = [];
	const invalidNets: string[] = [];
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
		const netClass: NetClass = input.gndNets?.has(net) ? 'gnd' : classifyNet(net);
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
		const netSegs: WireSegment[] = [];
		let netInvalid = false;
		const netTips = terminals.map(t => ({ x: t.x, y: t.y }));
		const foreignPins = allTips.filter(t => t.net !== net);
		const foreignKeepouts = foreignPins.map(p => pinKeepout(p));

		// Incremental trunk routing (Prim over the net's own geometry): connect
		// each terminal to the NEAREST point on what the net has already routed —
		// tapping the trunk — instead of routing MST pin-pairs independently,
		// which lay parallel columns / doubled wires that read as "two wires
		// where a junction belongs".
		const remaining = terminals.slice();
		// Start the trunk from the most central terminal — deterministic and
		// independent of terminal order (so a file round-trip that reorders
		// symbols can't change the routing), and it keeps the trunk short.
		const cx = terminals.reduce((s, tt) => s + tt.x, 0) / terminals.length;
		const cy = terminals.reduce((s, tt) => s + tt.y, 0) / terminals.length;
		let startI = 0;
		let startD = Infinity;
		for (let i = 0; i < remaining.length; i++) {
			const d = Math.abs(remaining[i]!.x - cx) + Math.abs(remaining[i]!.y - cy);
			if (d < startD) {
				startD = d;
				startI = i;
			}
		}
		const start = remaining.splice(startI, 1)[0]!;
		// Connected geometry. A terminal TIP carries its outward exit so a later
		// tap approaches it from OUTSIDE (never arriving into the body backward);
		// routed path points carry no exit (mid-trunk taps).
		const connectedPts: Array<Point2 & { exitDx: number; exitDy: number }> = [
			{ x: start.x, y: start.y, exitDx: start.exitDx, exitDy: start.exitDy }
		];
		const connectedSegs: WireSegment[] = [];

		while (remaining.length) {
			let bestIdx = 0;
			let bestDist = Infinity;
			let bestTarget: Point2 = connectedPts[0]!;
			let bestExit: Point2 = { x: 0, y: 0 };
			for (let i = 0; i < remaining.length; i++) {
				const near = nearestOnGeometry(remaining[i]!, connectedPts, connectedSegs);
				if (near.dist < bestDist) {
					bestDist = near.dist;
					bestIdx = i;
					bestTarget = near.point;
					bestExit = near.exit;
				}
			}
			const t = remaining.splice(bestIdx, 1)[0]!;
			const path = routeEdge(
				{ x: t.x, y: t.y },
				bestTarget,
				bodies,
				foreignKeepouts,
				blockedEdges,
				gridMm,
				netTips,
				{ x: t.exitDx, y: t.exitDy },
				bestExit
			);
			// Clean route found → normal wire. Otherwise FORCE a direct connection
			// (straight or single 90° L) so the net is never left unconnected; the
			// forced segments are flagged invalid (emitted red) for the user to fix.
			const forced = !path || path.length < 2;
			const usePath = forced
				? forcedEdgePath({ x: t.x, y: t.y }, bestTarget, foreignPins)
				: path!;
			if (forced) {
				netInvalid = true;
				warnings.push(`Forced wire on ${ net }: ${ t.ref }.${ t.pin } (move parts apart to clear)`);
			}
			for (let i = 0; i < usePath.length - 1; i++) {
				const p0 = usePath[i]!;
				const p1 = usePath[i + 1]!;
				if (Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9) {
					continue;
				}
				const seg: WireSegment = {
					net,
					x1: p0.x,
					y1: p0.y,
					x2: p1.x,
					y2: p1.y,
					invalid: forced || undefined
				};
				netSegs.push(seg);
				connectedSegs.push(seg);
			}
			// t's tip carries its outward exit; interior/target path points do not.
			connectedPts.push({ x: t.x, y: t.y, exitDx: t.exitDx, exitDy: t.exitDy });
			for (let i = 1; i < usePath.length; i++) {
				connectedPts.push({ x: usePath[i]!.x, y: usePath[i]!.y, exitDx: 0, exitDy: 0 });
			}
		}

		for (const s of netSegs) {
			addSegmentEdges(blockedEdges, s, gridMm);
		}
		allSegments.push(...netSegs);
		if (netInvalid) {
			invalidNets.push(net);
		}
		byNet.push({
			net,
			segments: netSegs,
			routed: true,
			terminals,
			netClass
		});
	}

	return {
		segments: allSegments,
		byNet,
		invalidNets,
		unroutedNets,
		floatingNets,
		stubNets,
		warnings
	};
}

/**
 * Nearest point on a net's already-routed geometry to terminal `t`: the closest
 * connected point, or the closest (clamped) projection onto an existing axis
 * segment — so a new terminal taps the trunk mid-span (→ junction) instead of
 * routing its own parallel run.
 */
function nearestOnGeometry(
	t: Point2,
	pts: Array<Point2 & { exitDx: number; exitDy: number }>,
	segs: WireSegment[]
): { point: Point2; dist: number; exit: Point2 } {
	let best: Point2 = pts[0] ?? { x: t.x, y: t.y };
	let bestExit: Point2 = { x: 0, y: 0 };
	let bestDist = Infinity;
	for (const p of pts) {
		const d = manhattan(t, p);
		if (d < bestDist) {
			bestDist = d;
			best = { x: p.x, y: p.y };
			bestExit = { x: p.exitDx, y: p.exitDy };
		}
	}
	for (const s of segs) {
		const cp = closestPointOnAxisSeg(t, s);
		const d = manhattan(t, cp);
		if (d < bestDist) {
			bestDist = d;
			best = cp;
			bestExit = { x: 0, y: 0 };
		}
	}
	return { point: best, dist: bestDist, exit: bestExit };
}

function closestPointOnAxisSeg(t: Point2, s: WireSegment): Point2 {
	if (Math.abs(s.y1 - s.y2) < 1e-6) {
		const lo = Math.min(s.x1, s.x2);
		const hi = Math.max(s.x1, s.x2);
		return { x: Math.max(lo, Math.min(hi, t.x)), y: s.y1 };
	}
	if (Math.abs(s.x1 - s.x2) < 1e-6) {
		const lo = Math.min(s.y1, s.y2);
		const hi = Math.max(s.y1, s.y2);
		return { x: s.x1, y: Math.max(lo, Math.min(hi, t.y)) };
	}
	return { x: s.x1, y: s.y1 };
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

/** True if `p` lies on the axis-aligned segment a→b (endpoints included). */
function pointOnAxisSeg(p: Point2, a: Point2, b: Point2, tol = 1e-6): boolean {
	if (Math.abs(a.x - b.x) < tol) {
		return Math.abs(p.x - a.x) <= tol
			&& p.y >= Math.min(a.y, b.y) - tol
			&& p.y <= Math.max(a.y, b.y) + tol;
	}
	if (Math.abs(a.y - b.y) < tol) {
		return Math.abs(p.y - a.y) <= tol
			&& p.x >= Math.min(a.x, b.x) - tol
			&& p.x <= Math.max(a.x, b.x) + tol;
	}
	return false;
}

/**
 * Forced fallback route used when no clean path exists: a straight wire when
 * the terminals share an axis, otherwise a single 90° L. Of the two possible L
 * corners, pick the one crossing the fewest FOREIGN-net pin points (best-effort
 * short-avoidance). Guarantees the connection always exists; the caller marks
 * the resulting segments invalid so they render red.
 */
function forcedEdgePath(
	a: Point2,
	b: Point2,
	foreignPins: Point2[]
): Point2[] {
	if (Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9) {
		return [a, b];
	}
	const horizFirst = { x: b.x, y: a.y };
	const vertFirst = { x: a.x, y: b.y };
	const crossings = (corner: Point2): number => {
		let n = 0;
		for (const fp of foreignPins) {
			if (pointOnAxisSeg(fp, a, corner) || pointOnAxisSeg(fp, corner, b)) {
				n++;
			}
		}
		return n;
	};
	return crossings(horizFirst) <= crossings(vertFirst)
		? [a, horizFirst, b]
		: [a, vertFirst, b];
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
	exitTo: Point2 = { x: 0, y: 0 },
	maxBends: number = Infinity
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

	/**
	 * A wire must never leave a pin heading straight back INTO the body (the
	 * opposite of its outward exit) — it overlaps the pin/body and reads wrong.
	 * Perpendicular first steps are fine; only the direct reverse is banned.
	 */
	const startsBackward = (pts: Point2[]): boolean => {
		if (!hasExit(exitFrom) || pts.length < 2) {
			return false;
		}
		const dx = Math.sign(pts[1]!.x - pts[0]!.x);
		const dy = Math.sign(pts[1]!.y - pts[0]!.y);
		return dx === -exitFrom.x && dy === -exitFrom.y;
	};

	/**
	 * Symmetric guard for the destination pin: the wire must ARRIVE from the
	 * target's outward side, not plunge into its body from behind.
	 */
	const endsBackward = (pts: Point2[]): boolean => {
		if (!hasExit(exitTo) || pts.length < 2) {
			return false;
		}
		const n = pts.length;
		const dx = Math.sign(pts[n - 2]!.x - pts[n - 1]!.x);
		const dy = Math.sign(pts[n - 2]!.y - pts[n - 1]!.y);
		return dx === -exitTo.x && dy === -exitTo.y;
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

	const boundedCandidates = candidates.filter(path => Math.max(0, path.length - 2) <= maxBends);
	if (boundedCandidates.length) {
		boundedCandidates.sort((a, b) => {
			// Never leave (or enter) a pin backward through its body, even at the
			// cost of an extra bend — a clean U out the front beats a jog through it.
			const aBack = (startsBackward(a) ? 1 : 0) + (endsBackward(a) ? 1 : 0);
			const bBack = (startsBackward(b) ? 1 : 0) + (endsBackward(b) ? 1 : 0);
			if (aBack !== bBack) {
				return aBack - bBack;
			}
			const aBends = Math.max(0, a.length - 2);
			const bBends = Math.max(0, b.length - 2);
			if (aBends !== bBends) {
				return aBends - bBends;
			}
			const aExit = firstSegMatchesExit(a) ? 0 : 1;
			const bExit = firstSegMatchesExit(b) ? 0 : 1;
			if (aExit !== bExit) {
				return aExit - bExit;
			}
			return pathLength(a) - pathLength(b);
		});
		return boundedCandidates[0]!;
	}

	// Local rewires deliberately do not fall back to a maze when the caller
	// asks for a bounded bend count.
	if (Number.isFinite(maxBends)) {
		return null;
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
			// Prefer the pin's outward exit for the first step from the terminal;
			// heavily penalise stepping straight back INTO the body.
			if (hasExitFrom && parent.get(bestK) === null) {
				if (stepDx === -exitFrom.x && stepDy === -exitFrom.y) {
					stepCost += BEND_PENALTY * 4;
				}
				else if (stepDx !== exitFrom.x || stepDy !== exitFrom.y) {
					stepCost += NEAR_TERMINAL_BEND_PENALTY;
				}
			}
			// Prefer arriving along the destination pin's outward exit; heavily
			// penalise arriving straight into its body (stepping in +exitTo).
			if (hasExitTo && Math.abs(np.x - goal.x) < 1e-6 && Math.abs(np.y - goal.y) < 1e-6) {
				if (stepDx === exitTo.x && stepDy === exitTo.y) {
					stepCost += BEND_PENALTY * 4;
				}
				else if (stepDx !== -exitTo.x || stepDy !== -exitTo.y) {
					stepCost += NEAR_TERMINAL_BEND_PENALTY;
				}
			}
			const bending = cur.dirX !== 0 || cur.dirY !== 0
				? (stepDx !== cur.dirX || stepDy !== cur.dirY)
				: false;
			if (bending) {
				stepCost += BEND_PENALTY;
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

/** KiCad per-wire stroke color for forced/invalid connections (red, opaque). */
const INVALID_WIRE_COLOR = '(color 255 0 0 1)';

export function emitWireSexpr(seg: WireSegment): string {
	const stroke = seg.invalid
		? `(stroke (width 0) (type default) ${ INVALID_WIRE_COLOR })`
		: '(stroke (width 0) (type default))';
	return `
(wire (pts (xy ${ fmtMm(seg.x1) } ${ fmtMm(seg.y1) }) (xy ${ fmtMm(seg.x2) } ${ fmtMm(seg.y2) }))
  ${ stroke }
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
				y2: p.y2,
				invalid: seg.invalid
			});
		}
	}
	return ortho.map(emitWireSexpr).join('\n\n');
}

/** Point key at emit precision (dedupe / arm counting). */
function junctionKey(p: Point2): string {
	return `${ fmtMm(p.x) },${ fmtMm(p.y) }`;
}

/**
 * Wire "arms" incident to `p` among same-net segments: +1 for a segment
 * ending at `p`, +2 for a segment whose interior passes through `p` (a T-tap).
 */
function armCount(p: Point2, segs: WireSegment[]): number {
	let arms = 0;
	for (const s of segs) {
		const a = { x: s.x1, y: s.y1 };
		const b = { x: s.x2, y: s.y2 };
		const atA = Math.abs(p.x - a.x) < 1e-6 && Math.abs(p.y - a.y) < 1e-6;
		const atB = Math.abs(p.x - b.x) < 1e-6 && Math.abs(p.y - b.y) < 1e-6;
		if (atA || atB) {
			arms += 1;
		}
		else if (pointOnAxisSeg(p, a, b)) {
			arms += 2;
		}
	}
	return arms;
}

/**
 * Junction dots where 3+ same-net wire arms meet (branch or T-tap). Computed
 * per net so cross-net crossings never get a junction — those stay
 * electrically separate, exactly as KiCad treats an un-dotted crossing.
 */
export function computeJunctions(segments: WireSegment[]): Point2[] {
	const byNet = new Map<string, WireSegment[]>();
	for (const s of segments) {
		const list = byNet.get(s.net) ?? [];
		list.push(s);
		byNet.set(s.net, list);
	}
	const out: Point2[] = [];
	const seen = new Set<string>();
	for (const segs of byNet.values()) {
		const candidates = new Map<string, Point2>();
		for (const s of segs) {
			candidates.set(junctionKey({ x: s.x1, y: s.y1 }), { x: s.x1, y: s.y1 });
			candidates.set(junctionKey({ x: s.x2, y: s.y2 }), { x: s.x2, y: s.y2 });
		}
		for (const p of candidates.values()) {
			if (armCount(p, segs) >= 3) {
				const k = junctionKey(p);
				if (!seen.has(k)) {
					seen.add(k);
					out.push(p);
				}
			}
		}
	}
	return out;
}

/**
 * Merge collinear, overlapping/touching same-net segments into single spans.
 * MST edges routed independently can lay a branch back along the trunk, drawing
 * two wires on top of each other — merging collapses them to one trunk so the
 * branch reads as a junction tap (see {@link computeJunctions}) instead of a
 * doubled wire. Non-orthogonal segments (shouldn't occur) pass through.
 */
export function mergeCollinearSegments(segments: WireSegment[]): WireSegment[] {
	type Group = { net: string; horiz: boolean; fixed: number; segs: Array<{ lo: number; hi: number; invalid?: boolean }> };
	const groups = new Map<string, Group>();
	const out: WireSegment[] = [];
	for (const s of segments) {
		const horiz = Math.abs(s.y1 - s.y2) < 1e-6;
		const vert = Math.abs(s.x1 - s.x2) < 1e-6;
		if (horiz && vert) {
			continue; // zero length
		}
		if (!horiz && !vert) {
			out.push(s); // diagonal — leave alone
			continue;
		}
		const fixed = horiz ? s.y1 : s.x1;
		const key = `${ horiz ? 'H' : 'V' }|${ fixed.toFixed(3) }|${ s.net }`;
		let g = groups.get(key);
		if (!g) {
			g = { net: s.net, horiz, fixed, segs: [] };
			groups.set(key, g);
		}
		const lo = horiz ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2);
		const hi = horiz ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2);
		g.segs.push({ lo, hi, invalid: s.invalid });
	}
	for (const g of groups.values()) {
		g.segs.sort((a, b) => a.lo - b.lo);
		let cur = { ...g.segs[0]! };
		const merged: Array<{ lo: number; hi: number; invalid?: boolean }> = [];
		for (let i = 1; i < g.segs.length; i++) {
			const nx = g.segs[i]!;
			if (nx.lo <= cur.hi + 1e-6) {
				cur.hi = Math.max(cur.hi, nx.hi);
				cur.invalid = cur.invalid || nx.invalid;
			}
			else {
				merged.push(cur);
				cur = { ...nx };
			}
		}
		merged.push(cur);
		for (const m of merged) {
			out.push(g.horiz
				? { net: g.net, x1: m.lo, y1: g.fixed, x2: m.hi, y2: g.fixed, invalid: m.invalid }
				: { net: g.net, x1: g.fixed, y1: m.lo, x2: g.fixed, y2: m.hi, invalid: m.invalid });
		}
	}
	return out;
}

export function emitJunctionsSexpr(points: Point2[]): string {
	return points
		.map(p => `(junction (at ${ fmtMm(p.x) } ${ fmtMm(p.y) }) (diameter 0) (color 0 0 0 0) (uuid "${ randomUUID() }"))`)
		.join('\n');
}
