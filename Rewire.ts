/**
 * The single schematic rewire algorithm.
 *
 * Rips up ALL connectivity graphics (wires, junctions, net labels, power-port
 * symbols) and regenerates them from the locked netlist. It never reads the
 * old wiring — only the frozen pin→net map — so it works regardless of how
 * complex the original connection was, and connectivity is preserved exactly
 * (no adds, no drops) by construction.
 *
 * Nets that cannot be routed cleanly are NOT dropped: they get a forced wire
 * (straight or a single 90° L) flagged invalid (rendered red) so the user can
 * prettify them by moving parts apart. Errors are impossible; ugliness is
 * merely flagged.
 */

import { KicadParser } from '@kicad-io/KicadParser';
import { KicadElementGlobalLabel } from '@kicad-io/KicadElementGlobalLabel';
import { KicadElementHierarchicalLabel } from '@kicad-io/KicadElementHierarchicalLabel';
import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';

import { FINE_GRID_MM, type PinLocal } from './Geometry';
import {
	lockNetlistFromSchematic,
	pinsForLockedLib,
	type LockedNetlist
} from './LockNetlist';
import { componentPlacementsOnly, emitConnectivity } from './Place';
import { replaceConnectivityGraphics } from './SchematicWirePatch';
import type { CircuitPlacement } from './Types';
import { CircuitLayoutError } from './Types';
import { autoroute, type FixedTerminal, type WireSegment } from './Router';
import { scoreLayout, type LayoutScore } from './Score';

/**
 * Preserved, user-placed net terminals that are NOT component pins and NOT
 * regenerated: global / hierarchical labels and power-rail symbols (+3.3V, +5V,
 * …). The router wires each net's component pins to these. Net name = label
 * text / rail Value, which is exactly how the flood-fill named the net, so they
 * merge by name. power:GND is excluded (regenerated per-pin) and PWR_FLAG has no
 * net name of its own.
 */
function collectFixedTerminals(schematicText: string, gndNets: Set<string>): FixedTerminal[] {
	let root: { findChildrenByClass?: (c: unknown) => unknown[] };
	try {
		root = new KicadParser().parse(schematicText) as never;
	}
	catch {
		return [];
	}
	const children = (cls: unknown): any[] =>
		(typeof root.findChildrenByClass === 'function' ? root.findChildrenByClass(cls) : []) as any[];

	const out: FixedTerminal[] = [];
	let i = 0;
	const add = (ref: string, net: string, o: { x: number; y: number }): void => {
		// Ground nets are grounded with ground symbols, never treated as a
		// label/rail terminal — even if a stray global label renamed them.
		if (!net || gndNets.has(net)) {
			return;
		}
		out.push({ ref, net, x: o.x, y: o.y });
	};
	for (const gl of children(KicadElementGlobalLabel)) {
		add(`#GLABEL:${ i++ }`, String(gl.getName?.() ?? '').trim(), gl.getOrigin?.() ?? { x: 0, y: 0 });
	}
	for (const hl of children(KicadElementHierarchicalLabel)) {
		add(`#HLABEL:${ i++ }`, String(hl.getName?.() ?? '').trim(), hl.getOrigin?.() ?? { x: 0, y: 0 });
	}
	for (const sym of children(KicadElementSymbol)) {
		const libId = String(sym.getLibId?.() ?? '');
		if (!libId.startsWith('power:') || libId === 'power:GND' || libId === 'power:PWR_FLAG') {
			continue;
		}
		const net = String(sym.getPropertyByName?.('Value')?.propertyValue ?? '').trim();
		add(String(sym.getReference?.() || `#PWR:${ i++ }`), net, sym.getOrigin?.() ?? { x: 0, y: 0 });
	}
	return out;
}

function clonePlacement(p: CircuitPlacement): CircuitPlacement {
	return {
		...p,
		nets: [...(p.nets ?? [])],
		pinNets: { ...(p.pinNets ?? {}) }
	};
}

/**
 * Apply the locked pin↔net map onto placement rows: pose comes from the caller
 * (the live drag), nets are frozen from the lock. This is what makes a drag
 * unable to change connectivity.
 */
export function applyLockedPinNets(
	placements: CircuitPlacement[],
	locked: LockedNetlist
): CircuitPlacement[] {
	return placements.map(p => {
		const pinNets = locked.pinNetsByRef[p.ref];
		if (!pinNets) {
			return clonePlacement(p);
		}
		return {
			...clonePlacement(p),
			pinNets: { ...pinNets },
			nets: Object.values(pinNets)
		};
	});
}

export interface RewireInput {
	/** Current schematic text (symbol poses already match `placements`). */
	schematicText: string;
	placements: CircuitPlacement[];
	/** Frozen netlist locked on load; rebuilt from text only if omitted. */
	locked?: LockedNetlist;
	routeGridMm?: number;
	/** 'autoroute' (default) redraws wires; 'clear-wires' emits labels/GND only. */
	connectivity?: 'autoroute' | 'clear-wires';
}

export interface RewireResult {
	kicadSchFull: string;
	score: LayoutScore;
	placements: CircuitPlacement[];
	locked: LockedNetlist;
	/** Nets containing a forced (red) wire — the prettify to-do list, not errors. */
	invalidNets: string[];
	segments: WireSegment[];
	warnings: string[];
}

export function rewireSchematic(body: RewireInput): RewireResult {
	const schematicText = body.schematicText?.trim() ?? '';
	if (!schematicText.includes('kicad_sch')) {
		throw new CircuitLayoutError('schematicText must be a .kicad_sch document', 400);
	}

	const locked = body.locked ?? lockNetlistFromSchematic(schematicText);
	const all = applyLockedPinNets(body.placements ?? [], locked);
	const components = componentPlacementsOnly(all);
	const routeGridMm = body.routeGridMm && body.routeGridMm > 0
		? body.routeGridMm
		: FINE_GRID_MM;
	const clearWires = body.connectivity === 'clear-wires';

	const pinsForLib = (libId: string): PinLocal[] =>
		pinsForLockedLib(libId, locked.pinsByLib);

	/** Largest non-passive pin set — legacy icPins for score fallbacks. */
	let icPins: PinLocal[] = [];
	for (const pins of Object.values(locked.pinsByLib)) {
		if (pins.length > icPins.length) {
			icPins = pins;
		}
	}

	let segments: WireSegment[] = [];
	let invalidNets: string[] = [];
	let unroutedNets: string[] = [];
	let floatingNets: string[] = [];
	let stubNets: string[] = [];
	const warnings: string[] = [...locked.warnings];

	if (!clearWires) {
		const route = autoroute({
			placements: components,
			icPins,
			pinsForLib,
			gridMm: routeGridMm,
			gndNets: locked.gndNets,
			// Preserved global/hier labels + power rails become routing targets
			// so a moved rail is wired (never deleted).
			fixedTerminals: collectFixedTerminals(schematicText, locked.gndNets)
		});
		segments = route.segments;
		invalidNets = route.invalidNets;
		unroutedNets = route.unroutedNets;
		floatingNets = route.floatingNets;
		stubNets = route.stubNets;
		warnings.push(...route.warnings);
		if (invalidNets.length) {
			warnings.push(`${ invalidNets.length } net(s) need attention (red): ${ invalidNets.join(', ') }`);
		}
	}

	// Full regenerate: rebuild wires + junctions + GND symbols + labels from the
	// locked netlist. 'labels' mode (clear-wires) stubs every pin to a label/GND.
	const conn = emitConnectivity({
		components,
		pinsForLib,
		mode: clearWires ? 'labels' : 'wires-with-label-fallback',
		wires: segments,
		unroutedNets,
		floatingNets,
		stubNets,
		gndNets: locked.gndNets,
		gndLibByNet: locked.gndLibByNet
	});

	const kicadSchFull = replaceConnectivityGraphics(schematicText, conn.block);

	const score = scoreLayout({
		placements: components,
		icPins,
		segments,
		unroutedNets: [],
		pinsForLib
	});

	return {
		kicadSchFull,
		score,
		placements: all,
		locked,
		invalidNets,
		segments,
		warnings
	};
}
