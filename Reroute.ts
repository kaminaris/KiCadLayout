/**
 * Re-route + re-score an exact placement (e.g. after a manual drag/rotate).
 * Pure TS — no DB / HTTP.
 */

import { FINE_GRID_MM, type PinLocal } from './Geometry';
import {
	componentPlacementsOnly,
	emitFragment,
	pinsForPlacementLib,
	seedFromInputs,
	withEditableGndPlacements,
	wrapFullSchematic,
	type SeedInputs,
} from './Place';
import type { CircuitPlacement } from './Types';
import { CircuitLayoutError } from './Types';
import { autoroute, type WireSegment } from './Router';
import { scoreLayout, type LayoutScore } from './Score';

function clonePlacement(p: CircuitPlacement): CircuitPlacement {
	return {
		...p,
		nets: [...(p.nets ?? [])],
		pinNets: { ...(p.pinNets ?? {}) },
	};
}

export interface RerouteInput {
	recipe: SeedInputs['recipe'];
	icSymbolText: string;
	placements: CircuitPlacement[];
	icMpnFallback?: string;
	packageHint?: string;
	kicadFootprint?: string;
	datasheet?: string;
	placementAlgorithm?: SeedInputs['placementAlgorithm'];
	routeGridMm?: number;
	/** 'autoroute' (default) or 'clear-wires' (stubs/labels only). */
	connectivity?: 'autoroute' | 'clear-wires';
}

export interface RerouteResult {
	kicadSchFragment: string;
	kicadSchFull: string;
	score: LayoutScore;
	iterations: number;
	placements: CircuitPlacement[];
	icPins: PinLocal[];
	warnings: string[];
}

export function reroute(body: RerouteInput): RerouteResult {
	const routeGridMm = body.routeGridMm && body.routeGridMm > 0
		? body.routeGridMm
		: FINE_GRID_MM;

	const seed = seedFromInputs({
		recipe: body.recipe,
		icSymbolText: body.icSymbolText,
		icMpnFallback: body.icMpnFallback,
		packageHint: body.packageHint,
		kicadFootprint: body.kicadFootprint,
		datasheet: body.datasheet,
		placementAlgorithm: body.placementAlgorithm,
	});

	const seedRefs = new Set(seed.placements.map(p => p.ref));
	const provided = body.placements ?? [];
	const providedComponents = componentPlacementsOnly(provided);
	const valid = providedComponents.length === seed.placements.length
		&& providedComponents.every(p => seedRefs.has(p.ref));
	if (!valid) {
		throw new CircuitLayoutError(
			'placements do not match the current recipe — reseed and try again',
			400
		);
	}

	const placements = provided.map(clonePlacement);
	const components = componentPlacementsOnly(placements);
	const clearWires = body.connectivity === 'clear-wires';

	let routeSegments: WireSegment[] = [];
	let unroutedNets: string[] = [];
	let floatingNets: string[] = [];
	let stubNets: string[] = [];
	const routeWarnings: string[] = [];

	if (!clearWires) {
		const route = autoroute({
			placements,
			icPins: seed.icPins,
			pinsForLib: (libId) => pinsForPlacementLib(libId, seed.icPins),
			gridMm: routeGridMm,
		});
		routeSegments = route.segments;
		unroutedNets = route.unroutedNets;
		floatingNets = route.floatingNets;
		stubNets = route.stubNets;
		routeWarnings.push(...route.warnings);
	}

	const score = scoreLayout({
		placements: components,
		icPins: seed.icPins,
		segments: routeSegments,
		unroutedNets,
		pinsForLib: (libId) => pinsForPlacementLib(libId, seed.icPins),
	});

	const fragment = emitFragment({
		libNeeded: seed.libNeeded,
		placements,
		icPins: seed.icPins,
		footprintByRef: seed.footprintByRef,
		mpnByRef: seed.mpnByRef,
		datasheet: seed.datasheet,
		warnings: [],
		mode: clearWires ? 'labels' : 'wires-with-label-fallback',
		wires: routeSegments,
		unroutedNets,
		floatingNets,
		stubNets,
	});

	const editPlacements = withEditableGndPlacements(placements, seed.icPins);
	const warnings: string[] = [...seed.warnings, ...routeWarnings];

	return {
		kicadSchFragment: fragment,
		kicadSchFull: wrapFullSchematic(fragment),
		score,
		iterations: 0,
		placements: editPlacements,
		icPins: seed.icPins,
		warnings,
	};
}
