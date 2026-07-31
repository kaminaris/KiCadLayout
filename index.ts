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
	emitConnectivity,
	emitCircuitFragment,
	symbolFieldLayout,
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
	SymbolFieldLayout,
} from './Place';
export { reroute } from './Reroute';
export type { RerouteInput, RerouteResult } from './Reroute';
export {
	lockNetlistFromSchematic,
	pinsForLockedLib,
} from './LockNetlist';
export type { LockedNetlist } from './LockNetlist';
export { applyLockedPinNets, rewireSchematic } from './Rewire';
export type { RewireInput, RewireResult } from './Rewire';
export {
	replaceSchematicWires,
	replaceConnectivityGraphics,
	stripSchematicWiresAndJunctions,
	stripConnectivityGraphics,
} from './SchematicWirePatch';
export {
	SchematicConnectivityService,
	SchematicConnectivityError,
} from './Connectivity';
export type {
	SchematicConnectivitySummary,
	ConnectivityComponent,
	ConnectivityNet,
} from './Connectivity';
