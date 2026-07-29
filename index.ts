/**
 * KiCadLayout — pure TypeScript place / autoroute / score for schematic
 * circuit layout. Peer dependency: KiCadParser (`@kicad-io/*`).
 */

export * from './Types';
export * from './Geometry';
export * from './Router';
export * from './Score';
export {
	seedFromInputs,
	placeFromInputs,
	emitFragment,
	emitCircuitFragment,
	wrapFullSchematic,
	isEditablePowerPlacement,
	componentPlacementsOnly,
	withEditableGndPlacements,
	pinsForPlacementLib,
	overlayPosesFromSchematic,
	parseSymbolPosesFromFragment,
	resolvePassiveLibForPlace,
	resolvePlacedPassivePinNets,
} from './Place';
export type {
	SeedInputs,
	CircuitDesignSeedResult,
	CircuitDesignPlaceResult,
	ConnectivityMode,
} from './Place';
export { reroute } from './Reroute';
export type { RerouteInput, RerouteResult } from './Reroute';
