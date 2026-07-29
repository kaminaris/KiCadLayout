const randomUUID = (): string => globalThis.crypto.randomUUID();

import { KicadParser } from '@kicad-io/KicadParser';
import { KicadElement } from '@kicad-io/KicadElement';
import { KicadElementPin } from '@kicad-io/KicadElementPin';
import { KicadElementAt } from '@kicad-io/KicadElementAt';

import type {
	CircuitDesignComponent,
	CircuitDesignRecipe,
	CircuitComponentType,
	CircuitPlacement,
	PlacementAlgorithm
} from './Types';
import { CircuitLayoutError } from './Types';
import {
	HORIZONTAL_DIODE_PINS,
	PASSIVE_LIB_BY_ID,
	PassiveLibId,
	VERTICAL_2PIN
} from '@kicad-io/Catalog/DevicePassiveSymbols';
import {
	DEFAULT_GRID_MM,
	PIN_STUB_LEN_MM,
	POWER_GND_PIN,
	PinLocal,
	Point2,
	aabbsOverlap,
	bodyAabbForPlacement,
	escapeSexpr,
	fmtMm,
	gndInstanceRotation,
	gndStubFromPin,
	gndStubToCustomPos,
	graphicLocalAabb,
	libPinWorldRotation,
	localToWorld,
	normalizeRot,
	snapToGrid,
	stubAwayFromBody
} from './Geometry';
import type { WireSegment } from './Router';
import { collectGndPowerPlacements, emitWiresSexpr } from './Router';

const GRID = DEFAULT_GRID_MM;
/** Stub from pin tip to label / power-symbol attach (mm) — clear pin names + GND glyph. */
const STUB_LEN_MM = PIN_STUB_LEN_MM;
/** Sheet origin for the IC (mm). */
const IC_X = 127;
const IC_Y = 101.6;

/** True for editable power:GND / #PWR rows (not recipe seed components). */
export function isEditablePowerPlacement(p: {
	libId?: string;
	ref?: string;
	role?: string;
}): boolean {
	return p.libId === 'power:GND'
		|| (typeof p.ref === 'string' && p.ref.startsWith('#PWR'))
		|| p.role === 'GND';
}

/** Recipe/component poses only — strips editable #PWR rows for seed matching. */
export function componentPlacementsOnly(
	placements: CircuitPlacement[]
): CircuitPlacement[] {
	return placements.filter(p => !isEditablePowerPlacement(p));
}

/**
 * Append (or refresh) editable power:GND placements derived from component
 * GND pins. Honors existing #PWR x/y overrides when present in `placements`.
 */
export function withEditableGndPlacements(
	placements: CircuitPlacement[],
	icPins: PinLocal[]
): CircuitPlacement[] {
	const components = componentPlacementsOnly(placements).map(clonePlacement);
	const powerOverrides = placements.filter(isEditablePowerPlacement);
	const gnd = collectGndPowerPlacements(
		[...components, ...powerOverrides],
		(libId) => pinsForLib(libId, icPins)
	);
	const gndRows: CircuitPlacement[] = gnd.map(g => ({
		ref: g.ref,
		role: 'GND',
		libId: 'power:GND',
		x: g.x,
		y: g.y,
		rotation: gndInstanceRotation(),
		value: 'GND',
		nets: ['GND'],
		pinNets: { '1': 'GND' },
		ownerRef: g.ownerRef
	}));
	return [...components, ...gndRows];
}

export interface CircuitDesignPlaceResult {
	kicadSchFragment: string;
	placements: CircuitPlacement[];
	/** IC's own pins, local (library Y-up) coords — for editor hit-testing/overlap on the client. */
	icPins: PinLocal[];
	warnings: string[];
}

export interface CircuitDesignSeedResult {
	recipe: CircuitDesignRecipe;
	placements: CircuitPlacement[];
	libNeeded: Map<string, string>;
	icPins: PinLocal[];
	footprintByRef: Record<string, string>;
	mpnByRef: Record<string, string>;
	datasheet: string;
	warnings: string[];
}

export type ConnectivityMode = 'labels' | 'wires' | 'wires-with-label-fallback';

interface LibSymbolInfo {
	libId: string;
	innerSymbol: string;
	pins: PinLocal[];
}

export function pinsForPlacementLib(libId: string, icPins: PinLocal[]): PinLocal[] {
	return pinsForLib(libId, icPins);
}

export interface SeedInputs {
	recipe: CircuitDesignRecipe;
	icSymbolText: string;
	/** IC value / MPN fallback when recipe.ic.mpn empty. */
	icMpnFallback?: string;
	packageHint?: string;
	kicadFootprint?: string;
	datasheet?: string;
	placementAlgorithm?: PlacementAlgorithm;
}

/**
 * Autoplace seed from an in-memory recipe + IC symbol text (no DB).
 */
export function seedFromInputs(body: SeedInputs): CircuitDesignSeedResult {
	const recipe = body.recipe;
	if (!recipe || recipe.schemaVersion !== 1) {
		throw new CircuitLayoutError('recipe is required (schemaVersion 1)', 400);
	}

	const symbolText = body.icSymbolText?.trim() ?? '';
	if (!symbolText) {
		throw new CircuitLayoutError(
			'icSymbolText is required — attach a KiCad symbol (.kicad_sym).',
			400
		);
	}

	const warnings: string[] = [];
	const icLib = parseIcLibSymbol(symbolText, warnings);
	const icRef = recipe.ic.ref?.trim() || 'U1';

	const roleToPin = recipe.ic.pins ?? {};
	const icPinNets = mergePinNets(
		buildIcPinNets(roleToPin, warnings),
		pinNetsFromRecipeNets(recipe, icRef),
		warnings,
		icRef
	);

	const placements: CircuitPlacement[] = [];
	const libNeeded = new Map<string, string>();
	libNeeded.set(icLib.libId, icLib.innerSymbol);

	placements.push({
		ref: icRef,
		role: 'IC',
		libId: icLib.libId,
		x: IC_X,
		y: IC_Y,
		rotation: 0,
		value: recipe.ic.mpn || body.icMpnFallback || 'IC',
		nets: Object.values(icPinNets),
		pinNets: icPinNets
	});

	const components = Array.isArray(recipe.components) ? recipe.components : [];
	const pending: PendingPassive[] = [];
	for (const comp of components) {
		const mapping = resolvePassiveMapping(comp);
		if (!mapping) {
			warnings.push(
				`Skipped ${comp.ref || '?'} (${comp.role || comp.type}): no Device:* template`
			);
			continue;
		}

		libNeeded.set(mapping.libId, PASSIVE_LIB_BY_ID[mapping.libId]);

		const placedCount = placements.length + pending.length;
		const ref = sanitizeRef(comp.ref, mapping.defaultRef + String(placedCount));
		const fromComp = resolveComponentPinNets(comp, mapping.libId, warnings);
		const fromNets = pinNetsFromRecipeNets(recipe, ref, comp.role);
		const pinNets = mergePinNetsPreferPrimary(
			fromComp,
			fromNets,
			warnings,
			ref
		);
		const slot = classifySlot(comp.role, comp.type, pinNets);

		pending.push({
			ref,
			role: comp.role || comp.type,
			libId: mapping.libId,
			rotation: 0,
			value: formatPassiveValue(comp),
			nets: Object.values(pinNets),
			pinNets,
			slot
		});
	}

	placements.push(...(
		body.placementAlgorithm === 'side-bucket'
			? placePassivesAroundIc(pending, icLib.pins, icPinNets, icRef, icLib.libId)
			: forceDirectedPlace(pending, icLib.pins, icPinNets, icRef, icLib.libId)
	));

	const needsGnd = placements.some(p =>
		Object.values(p.pinNets).some(n => isGndNet(n))
	);
	if (needsGnd) {
		libNeeded.set('power:GND', PASSIVE_LIB_BY_ID['power:GND']);
	}

	logPinNetDebug(placements, icLib.pins);

	return {
		recipe,
		placements,
		libNeeded,
		icPins: icLib.pins,
		footprintByRef: buildFootprintHints(recipe, {
			packageHint: body.packageHint?.trim() || '',
			kicadFootprint: body.kicadFootprint?.trim() || '',
			kicadSymbol: symbolText
		}, warnings),
		mpnByRef: { [icRef]: recipe.ic.mpn || body.icMpnFallback || '' },
		datasheet: body.datasheet?.trim() || '~',
		warnings
	};
}

/** Place passives (labels-only connectivity). */
export function placeFromInputs(body: SeedInputs): CircuitDesignPlaceResult {
	const seed = seedFromInputs(body);
	const fragment = emitFragment({
		...seed,
		mode: 'labels'
	});
	return {
		kicadSchFragment: fragment,
		placements: withEditableGndPlacements(seed.placements, seed.icPins),
		icPins: seed.icPins,
		warnings: seed.warnings
	};
}

export function emitCircuitFragment(opts: {
	libNeeded: Map<string, string>;
	placements: CircuitPlacement[];
	icPins: import('./Geometry').PinLocal[];
	footprintByRef: Record<string, string>;
	mpnByRef: Record<string, string>;
	datasheet: string;
	warnings: string[];
	mode?: ConnectivityMode;
	wires?: import('./Router').WireSegment[];
	unroutedNets?: string[];
	floatingNets?: string[];
	stubNets?: string[];
}): string {
	return emitFragment({
		libNeeded: opts.libNeeded,
		placements: opts.placements,
		icPins: opts.icPins,
		footprintByRef: opts.footprintByRef,
		mpnByRef: opts.mpnByRef,
		datasheet: opts.datasheet,
		warnings: opts.warnings,
		mode: opts.mode ?? 'labels',
		wires: opts.wires ?? [],
		unroutedNets: opts.unroutedNets ?? [],
		floatingNets: opts.floatingNets ?? [],
		stubNets: opts.stubNets ?? []
	});
}

export function emitFragment(opts: {
	libNeeded: Map<string, string>;
	placements: CircuitPlacement[];
	icPins: PinLocal[];
	footprintByRef: Record<string, string>;
	mpnByRef: Record<string, string>;
	datasheet: string;
	warnings: string[];
	mode?: ConnectivityMode;
	wires?: WireSegment[];
	unroutedNets?: string[];
	floatingNets?: string[];
	stubNets?: string[];
}): string {
	const mode = opts.mode ?? 'labels';
	const wires = opts.wires ?? [];
	const unrouted = new Set(opts.unroutedNets ?? []);
	const floating = new Set(opts.floatingNets ?? []);
	const stub = new Set(opts.stubNets ?? []);
	const labelNets = new Set([...unrouted, ...floating, ...stub]);
	const libs = [...opts.libNeeded.values()].join('\n');
	const parts: string[] = [];
	parts.push(`(lib_symbols\n${ libs }\n)`);

	const components = componentPlacementsOnly(opts.placements);
	const gndOverrideByRef = new Map(
		opts.placements
			.filter(isEditablePowerPlacement)
			.map(p => [p.ref, p] as const)
	);

	let pwrIndex = 1;
	const seenPowerLabels = new Set<string>();
	const stubWires: WireSegment[] = [];
	/** Labels mode always stubs every pin tip; wire modes stub only fallback/floating. */
	const attachStubs = mode === 'labels' || mode === 'wires-with-label-fallback';

	for (const p of components) {
		const uuid = randomUUID();
		const fp = opts.footprintByRef[p.ref] ?? '';
		const mpn = opts.mpnByRef[p.ref] ?? '';
		const pins = pinsForLib(p.libId, opts.icPins);
		parts.push(emitSymbolInstance({
			libId: p.libId,
			ref: p.ref,
			value: p.value,
			x: p.x,
			y: p.y,
			rotation: p.rotation,
			uuid,
			footprint: fp,
			datasheet: p.role === 'IC' ? opts.datasheet : '~',
			mpn,
			pins: p.role === 'IC' ? opts.icPins : undefined
		}));

		if (attachStubs) {
			for (const pin of pins) {
				const net = p.pinNets[pin.number];
				if (!net) {
					continue;
				}
				// When wires are primary, only stub+label unrouted / floating nets.
				if (mode === 'wires-with-label-fallback' && !labelNets.has(net)) {
					continue;
				}
				const tip = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
				const towardBody = libPinWorldRotation(pin.rotation, p.rotation);

				if (isGndNet(net)) {
					// First segment from power:GND must leave straight up (−Y).
					const gndRef = `#PWR${ String(pwrIndex++).padStart(2, '0') }`;
					const override = gndOverrideByRef.get(gndRef);
					const geom = override
						? gndStubToCustomPos(tip, { x: override.x, y: override.y }, STUB_LEN_MM)
						: gndStubFromPin({ x: p.x, y: p.y }, tip, STUB_LEN_MM, towardBody);
					for (const s of geom.segments) {
						stubWires.push({
							net,
							x1: s.x1,
							y1: s.y1,
							x2: s.x2,
							y2: s.y2
						});
					}
					const gndUuid = randomUUID();
					const gndRot = gndInstanceRotation();
					parts.push(emitPowerGndInstance({
						ref: gndRef,
						x: geom.gndPos.x,
						y: geom.gndPos.y,
						rotation: gndRot,
						uuid: gndUuid
					}));
					continue;
				}

				const { stubEnd, outwardRot } = stubAwayFromBody(
					{ x: p.x, y: p.y },
					tip,
					STUB_LEN_MM,
					towardBody
				);

				// Stub from electrical pin tip → label / power symbol attach point.
				stubWires.push({
					net,
					x1: tip.x,
					y1: tip.y,
					x2: stubEnd.x,
					y2: stubEnd.y
				});

				if (isPowerLikeNet(net)) {
					const key = `${ net }@${ fmtMm(stubEnd.x) },${ fmtMm(stubEnd.y) }`;
					if (!seenPowerLabels.has(key)) {
						seenPowerLabels.add(key);
						parts.push(emitGlobalLabel(
							net,
							stubEnd.x,
							stubEnd.y,
							labelRotationForOutward(outwardRot)
						));
					}
				}
				else {
					parts.push(emitLocalLabel(
						net,
						stubEnd.x,
						stubEnd.y,
						labelRotationForOutward(outwardRot)
					));
				}
			}
		}
	}

	if (isCircuitDesignDebug()) {
		logEmitPinDebug(components, opts.icPins);
	}

	const allWires = [...stubWires, ...wires];
	if (allWires.length) {
		parts.push(emitWiresSexpr(allWires));
	}

	if (mode === 'labels') {
		opts.warnings.push(
			'Connectivity: short stub wires from each pin tip to net labels / GND power symbols. '
			+ 'Paste into an open KiCad schematic (Ctrl+V), then rearrange as needed.'
		);
	}
	else {
		opts.warnings.push(
			`Connectivity: Manhattan wires (${ wires.length } segments)`
			+ (stubWires.length ? ` + ${ stubWires.length } pin stubs` : '')
			+ (stub.size
				? `; power stubs for ${ [...stub].join(', ') }`
				: '')
			+ (unrouted.size
				? `; label fallback for ${ [...unrouted].join(', ') }`
				: '')
			+ (floating.size
				? `; floating labels for ${ [...floating].join(', ') }`
				: '')
			+ '. Paste into KiCad with Ctrl+V.'
		);
	}

	return parts.join('\n\n') + '\n';
}

export function wrapFullSchematic(fragment: string): string {
	const uuid = randomUUID();
	const body = fragment.trim();
	return `
(kicad_sch
  (version 20250114)
  (generator "bommanager")
  (generator_version "9.0")
  (uuid "${ uuid }")
  (paper "A3")
  (title_block
    (title "Circuit Design Optimize")
  )
${ body }
  (sheet_instances
    (path "/"
      (page "1")
    )
  )
  (embedded_fonts no)
)
`.trim() + '\n';
}

function emitSymbolInstance(opts: {
	libId: string;
	ref: string;
	value: string;
	x: number;
	y: number;
	rotation: number;
	uuid: string;
	footprint: string;
	datasheet: string;
	mpn: string;
	/** IC pin locals — used to place Ref/Value clear of the body. */
	pins?: PinLocal[];
}): string {
	const { libId, ref, value, x, y, rotation, uuid, footprint, datasheet, mpn } = opts;
	const fields = symbolFieldLayout(libId, x, y, rotation, opts.pins);
	const justifyFx = fields.justify === 'left'
		? ' (justify left)'
		: '';
	return `
(symbol (lib_id "${ escapeSexpr(libId) }") (at ${ fmtMm(x) } ${ fmtMm(y) } ${ rotation }) (unit 1)
  (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes)
  (uuid "${ uuid }")
  (property "Reference" "${ escapeSexpr(ref) }" (at ${ fmtMm(fields.refX) } ${ fmtMm(fields.refY) } ${ fields.fieldRot })
    (effects (font (size 1.27 1.27))${ justifyFx })
  )
  (property "Value" "${ escapeSexpr(value) }" (at ${ fmtMm(fields.valX) } ${ fmtMm(fields.valY) } ${ fields.fieldRot })
    (effects (font (size 1.27 1.27))${ justifyFx })
  )
  (property "Footprint" "${ escapeSexpr(footprint) }" (at ${ fmtMm(x) } ${ fmtMm(y) } ${ rotation })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "Datasheet" "${ escapeSexpr(datasheet) }" (at ${ fmtMm(x) } ${ fmtMm(y) } ${ rotation })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "Description" "" (at ${ fmtMm(x) } ${ fmtMm(y) } ${ rotation })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "MPN" "${ escapeSexpr(mpn) }" (at ${ fmtMm(x) } ${ fmtMm(y) } ${ rotation })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
)
`.trim();
}

/**
 * Reference/Value world anchors for a placed instance.
 *
 * Device:* passives place labels beside the body (clear of plates). ICs place
 * Reference above and Value below the pin/body graphic extent. Field rotation
 * is 0 for upright symbols and 90 for odd quarter-turns so KiCad keep-upright
 * draws text upright — storing 0° on a 90° symbol flips draw angle to vertical
 * and parks labels on the body.
 */
function symbolFieldLayout(
	libId: string,
	x: number,
	y: number,
	rotation: number,
	pins?: PinLocal[]
): {
	refX: number;
	refY: number;
	valX: number;
	valY: number;
	fieldRot: number;
	justify: 'left' | 'middle';
} {
	const rot = normalizeRot(rotation);
	const odd = rot === 90 || rot === 270;
	// Store 90° when the symbol is on an odd quarter-turn so KiCad keep-upright
	// (fieldDrawRotation) draws the text upright (0°).
	const fieldRot = odd ? 90 : 0;
	const gap = 1.27;
	const stack = 1.27;

	if (!libId.startsWith('Device:')) {
		// IC / custom: Ref above body, Value below — never on the rectangle.
		const aabb = bodyAabbForPlacement(
			{ ref: '', libId, x, y, rotation: rot },
			pins,
			0
		);
		const midX = (aabb.xmin + aabb.xmax) / 2;
		return {
			refX: midX,
			refY: aabb.ymin - gap,
			valX: midX,
			valY: aabb.ymax + gap,
			fieldRot,
			justify: 'middle'
		};
	}

	// World extent of the graphic (no pad) so side offset clears plates/body.
	const local = graphicLocalAabb(libId, undefined);
	const corners = [
		localToWorld(x, y, rot, local.xmin, local.ymin),
		localToWorld(x, y, rot, local.xmin, local.ymax),
		localToWorld(x, y, rot, local.xmax, local.ymin),
		localToWorld(x, y, rot, local.xmax, local.ymax)
	];
	const xmax = Math.max(...corners.map(c => c.x));
	const ymax = Math.max(...corners.map(c => c.y));
	const ymin = Math.min(...corners.map(c => c.y));
	const sideGap = gap;
	if (odd) {
		// Pins left/right (C plates vertical): labels to the right of the body.
		const labelX = Math.max(x + 2.54, xmax + sideGap);
		return {
			refX: labelX,
			refY: y - stack,
			valX: labelX,
			valY: y + stack,
			fieldRot,
			justify: 'left'
		};
	}
	// Pins top/bottom: labels to the right of the tall body.
	const labelX = Math.max(x + 2.54, xmax + sideGap);
	return {
		refX: labelX,
		refY: Math.min(y - stack, ymin + stack),
		valX: labelX,
		valY: Math.max(y + stack, ymax - stack),
		fieldRot,
		justify: 'left'
	};
}

function emitPowerGndInstance(opts: {
	ref: string;
	x: number;
	y: number;
	rotation: number;
	uuid: string;
}): string {
	const rot = normalizeRot(opts.rotation);
	return `
(symbol (lib_id "power:GND") (at ${ fmtMm(opts.x) } ${ fmtMm(opts.y) } ${ rot }) (unit 1)
  (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes)
  (uuid "${ opts.uuid }")
  (property "Reference" "${ escapeSexpr(opts.ref) }" (at ${ fmtMm(opts.x) } ${ fmtMm(opts.y) } ${ rot })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "Value" "GND" (at ${ fmtMm(opts.x) } ${ fmtMm(opts.y) } ${ rot })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "Footprint" "" (at ${ fmtMm(opts.x) } ${ fmtMm(opts.y) } ${ rot })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "Datasheet" "" (at ${ fmtMm(opts.x) } ${ fmtMm(opts.y) } ${ rot })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
  (property "Description" "Power symbol creates a global label with name GND" (at ${ fmtMm(opts.x) } ${ fmtMm(opts.y) } ${ rot })
    (effects (font (size 1.27 1.27)) (hide yes))
  )
)
`.trim();
}

function emitLocalLabel(net: string, x: number, y: number, rotation: number): string {
	const r = normalizeRot(rotation);
	const justify = labelJustify(r);
	return `
(label "${ escapeSexpr(net) }"
  (at ${ fmtMm(x) } ${ fmtMm(y) } ${ r })
  (effects (font (size 1.27 1.27)) (justify ${ justify }))
  (uuid "${ randomUUID() }")
)
`.trim();
}

function emitGlobalLabel(net: string, x: number, y: number, rotation: number): string {
	const r = normalizeRot(rotation);
	const justify = labelJustify(r);
	return `
(global_label "${ escapeSexpr(net) }"
  (shape input)
  (at ${ fmtMm(x) } ${ fmtMm(y) } ${ r })
  (fields_autoplaced yes)
  (effects (font (size 1.27 1.27)) (justify ${ justify }))
  (uuid "${ randomUUID() }")
  (property "Intersheetrefs" "\${INTERSHEET_REFS}"
    (at ${ fmtMm(x) } ${ fmtMm(y) } 0)
    (effects (font (size 1.27 1.27)) (hide yes))
  )
)
`.trim();
}

/**
 * Label `at` angle faces the pin (inward). Text stays on the outward side.
 * Vertical stubs use 0/180 with a slight side bias via justify so text stays readable.
 */
function labelJustify(outwardRotation: number): string {
	const r = normalizeRot(outwardRotation);
	// outward 0 → label rot 0 → connection on left → text to the right of point
	if (r === 0) {
		return 'left';
	}
	if (r === 180) {
		return 'right';
	}
	// Vertical: keep left justify; KiCad draws text beside the wire.
	return 'left';
}

/**
 * Prefer readable horizontal labels even on vertical stubs (KiCad 0/180).
 * Connection still sits on the stub end; text extends away from the body.
 */
function labelRotationForOutward(outwardRot: number): number {
	const r = normalizeRot(outwardRot);
	if (r === 90 || r === 270) {
		// Vertical wire: use 0 so text is horizontal to the right of the attach point.
		return 0;
	}
	return r;
}

function pinsForLib(libId: string, icPins: PinLocal[]): PinLocal[] {
	if (libId === 'power:GND') {
		return [POWER_GND_PIN];
	}
	if (libId.startsWith('Device:D') || libId === 'Device:LED') {
		return HORIZONTAL_DIODE_PINS;
	}
	if (
		libId === 'Device:R'
		|| libId === 'Device:C'
		|| libId === 'Device:L'
		|| libId === 'Device:FerriteBead'
	) {
		return VERTICAL_2PIN;
	}
	return icPins;
}

function parseIcLibSymbol(sexp: string, warnings: string[]): LibSymbolInfo {
	let root: KicadElement;
	try {
		root = new KicadParser().parse(sexp);
	}
	catch (e: unknown) {
		const msg = (e as { message?: string })?.message ?? String(e);
		throw new CircuitLayoutError(`Failed to parse kicadSymbol: ${ msg }`, 400);
	}

	const libId = extractLibId(sexp) || 'Device:IC';
	const pins = extractPinLocals(root);
	if (!pins.length) {
		warnings.push('IC symbol has no parseable pin positions — labels may be incomplete');
	}

	let innerSymbol = sexp.trim();
	if (/^\(\s*lib_symbols\b/i.test(innerSymbol)) {
		innerSymbol = stripOuterLibSymbols(innerSymbol);
	}
	else if (/^\(\s*kicad_symbol_lib\b/i.test(innerSymbol)) {
		innerSymbol = stripOuterSymbolLib(innerSymbol);
	}

	// Drop clipboard instance forms: (symbol (lib_id …) …)
	innerSymbol = collectTopLevelSymbols(innerSymbol)
		.filter(s => !/\(\s*symbol\s*\(\s*lib_id\b/i.test(s))
		.join('\n')
		.trim() || innerSymbol;

	// Ensure the top-level symbol name matches libId for paste.
	innerSymbol = ensureSymbolLibId(innerSymbol, libId);

	return { libId, innerSymbol, pins };
}

function extractLibId(sexp: string): string | null {
	const m = sexp.match(/\(\s*symbol\s+"([^"]+)"/);
	if (!m) {
		return null;
	}
	const name = m[1];
	// Nested unit symbols look like "TPS5430_0_1" — prefer first with colon or without _N_N.
	if (/_\d+_\d+$/.test(name) && !name.includes(':')) {
		const all = [...sexp.matchAll(/\(\s*symbol\s+"([^"]+)"/g)].map(x => x[1]);
		const top = all.find(n => n && !/_\d+_\d+$/.test(n));
		return top || name;
	}
	return name;
}

function stripOuterLibSymbols(text: string): string {
	const open = text.indexOf('(lib_symbols');
	if (open < 0) {
		return text;
	}
	let i = open + '(lib_symbols'.length;
	while (i < text.length && /\s/.test(text[i]!)) {
		i++;
	}
	const innerStart = i;
	let depth = 1;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (ch === '(') {
			depth++;
		}
		else if (ch === ')') {
			depth--;
			if (depth === 0) {
				return text.slice(innerStart, i).trim();
			}
		}
	}
	return text;
}

function stripOuterSymbolLib(text: string): string {
	const open = text.search(/\(\s*kicad_symbol_lib\b/);
	if (open < 0) {
		return text;
	}
	const symbolStart = text.indexOf('(symbol', open);
	if (symbolStart < 0) {
		return text;
	}
	return collectTopLevelSymbols(text.slice(symbolStart)).join('\n');
}

function collectTopLevelSymbols(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf('(symbol', i);
		if (start < 0) {
			break;
		}
		let depth = 0;
		let j = start;
		for (; j < text.length; j++) {
			if (text[j] === '(') {
				depth++;
			}
			else if (text[j] === ')') {
				depth--;
				if (depth === 0) {
					j++;
					break;
				}
			}
		}
		out.push(text.slice(start, j).trim());
		i = j;
	}
	return out;
}

function ensureSymbolLibId(inner: string, libId: string): string {
	return inner.replace(/\(\s*symbol\s+"[^"]+"/, `(symbol "${ libId }"`);
}

function extractPinLocals(root: KicadElement): PinLocal[] {
	const pins: PinLocal[] = [];
	const seen = new Set<string>();

	const visit = (el: KicadElement) => {
		if (el instanceof KicadElementPin) {
			const { number } = el.getPin();
			const num = String(number ?? '').trim();
			if (!num || seen.has(num)) {
				return;
			}
			seen.add(num);
			const at = el.findFirstChildByClass(KicadElementAt);
			pins.push({
				number: num,
				x: at?.x ?? 0,
				y: at?.y ?? 0,
				rotation: at?.rotation ?? 0
			});
			return;
		}
		for (const child of el.children ?? []) {
			visit(child);
		}
	};

	visit(root);
	return pins;
}

function buildIcPinNets(
	roleToPin: Record<string, string>,
	warnings: string[]
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [role, pin] of Object.entries(roleToPin)) {
		const pinNum = String(pin).trim();
		const net = sanitizeNetName(role);
		if (!pinNum || !net) {
			continue;
		}
		if (out[pinNum] && out[pinNum] !== net) {
			warnings.push(
				`IC pin ${ pinNum } has multiple roles (${ out[pinNum] }, ${ net }) — using ${ net }`
			);
		}
		out[pinNum] = net;
	}
	return out;
}

/**
 * Build pin→net from recipe.nets members (`U1.6`, `CBST1.1`, `Cboot.1`).
 * Exact ref matches win over role aliases when both appear.
 */
function pinNetsFromRecipeNets(
	recipe: CircuitDesignRecipe,
	ref: string,
	role?: string
): Record<string, string> {
	const out: Record<string, string> = {};
	const refU = ref.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
	const roleAliases = refAliases('', role);
	roleAliases.delete(refU);
	if (!refU && !roleAliases.size) {
		return out;
	}

	const apply = (exactOnly: boolean) => {
		for (const net of recipe.nets ?? []) {
			const netName = sanitizeNetName(net.name);
			if (!netName) {
				continue;
			}
			for (const member of net.members ?? []) {
				const parsed = parseNetMember(String(member));
				if (!parsed || !parsed.pin) {
					continue;
				}
				const isExact = parsed.ref === refU;
				const isRole = roleAliases.has(parsed.ref);
				if (exactOnly) {
					if (!isExact) {
						continue;
					}
				}
				else if (!isRole || out[parsed.pin]) {
					// Role fill only; never overwrite exact-ref or earlier fill.
					continue;
				}
				out[parsed.pin] = netName;
			}
		}
	};

	apply(true);
	apply(false);
	return out;
}

/** Refs / roles that should match the same placed instance. */
function refAliases(ref: string, role?: string): Set<string> {
	const out = new Set<string>();
	const add = (raw: string) => {
		const t = raw.trim().toUpperCase();
		if (!t) {
			return;
		}
		out.add(t);
		// Strip non-alnum so "C-boot" / "C_boot" still match Cboot.
		const compact = t.replace(/[^A-Z0-9]/g, '');
		if (compact) {
			out.add(compact);
		}
	};
	add(ref);
	if (role) {
		add(role);
		// Short role token before spaces: "bootstrap cap …" → ignore; "Cboot" kept.
		const token = role.trim().split(/[\s(/]/)[0] ?? '';
		if (token && /^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
			add(token);
		}
	}
	return out;
}

/** `REF.pin` — allows C1, CBST1, C1a, and role tokens like Cboot (no digit). */
const NET_MEMBER_PARSE_RE = /^([A-Za-z][A-Za-z0-9_-]*)\.(.+)$/i;

function parseNetMember(member: string): { ref: string; pin: string } | null {
	const m = NET_MEMBER_PARSE_RE.exec(member.trim());
	if (!m) {
		return null;
	}
	return {
		ref: m[1]!.toUpperCase().replace(/[^A-Z0-9]/g, ''),
		pin: String(m[2]!).trim()
	};
}

/** Prefer recipe.nets (override) over role→pin fallbacks — used for the IC only. */
function mergePinNets(
	fallback: Record<string, string>,
	fromNets: Record<string, string>,
	warnings: string[],
	ref: string
): Record<string, string> {
	const out: Record<string, string> = { ...fallback };
	for (const [pin, net] of Object.entries(fromNets)) {
		const prev = out[pin];
		if (prev && prev !== net) {
			warnings.push(
				`${ ref }.${ pin }: netlist "${ net }" overrides fallback "${ prev }"`
			);
		}
		out[pin] = net;
	}
	return out;
}

/**
 * Passives: keep explicit components[].pinNets; fill missing pins from recipe.nets.
 * Never let a messy netlist overwrite a correct pinNets entry (Cboot→BST/SW).
 */
function mergePinNetsPreferPrimary(
	primary: Record<string, string>,
	secondary: Record<string, string>,
	warnings: string[],
	ref: string
): Record<string, string> {
	const out: Record<string, string> = { ...primary };
	for (const [pin, net] of Object.entries(secondary)) {
		const prev = out[pin];
		if (prev && prev !== net) {
			warnings.push(
				`${ ref }.${ pin }: keeping pinNets "${ prev }" (ignoring netlist "${ net }")`
			);
			continue;
		}
		if (!prev) {
			out[pin] = net;
		}
	}
	return out;
}

function resolveComponentPinNets(
	comp: CircuitDesignComponent,
	libId: string,
	warnings: string[]
): Record<string, string> {
	if (comp.pinNets && Object.keys(comp.pinNets).length) {
		const out: Record<string, string> = {};
		for (const [pin, net] of Object.entries(comp.pinNets)) {
			const n = sanitizeNetName(net);
			if (n) {
				out[String(pin).trim()] = n;
			}
		}
		return out;
	}

	const nets = (comp.nets ?? []).map(sanitizeNetName).filter(Boolean);
	if (nets.length >= 2) {
		const isDiode = libId.startsWith('Device:D') || libId === 'Device:LED';
		if (isDiode) {
			// Prefer anode on switching node / PH, cathode on VIN for catch diodes.
			const a = pickDiodeAnodeNet(nets, comp.role);
			const k = nets.find(n => n !== a) || nets[1]!;
			return { '1': k, '2': a };
		}
		// Vertical passives: non-GND on pin 1 (top), GND on pin 2 when present.
		const gnd = nets.find(isGndNet);
		if (gnd) {
			const other = nets.find(n => n !== gnd) || nets[0]!;
			return { '1': other, '2': gnd };
		}
		return { '1': nets[0]!, '2': nets[1]! };
	}

	if (nets.length === 1) {
		warnings.push(`${ comp.ref }: only one net listed — pin 2 unlabeled`);
		return { '1': nets[0]! };
	}

	warnings.push(`${ comp.ref }: no nets — placed without labels`);
	return {};
}

function pickDiodeAnodeNet(nets: string[], role: string): string {
	const roleL = role.toLowerCase();
	if (/catch|schottky|rect|freewheel|bootstrap/.test(roleL)) {
		const sw = nets.find(n => /^(PH|SW|LX|SWITCH)$/i.test(n));
		if (sw) {
			return sw;
		}
	}
	return nets[0]!;
}

type PlaceSlot =
	| 'cin'
	| 'cout'
	| 'inductor'
	| 'diode'
	| 'feedback'
	| 'boot'
	| 'ss'
	| 'comp'
	| 'other';

function classifySlot(
	role: string,
	type: CircuitComponentType,
	pinNets: Record<string, string>
): PlaceSlot {
	const r = role.toLowerCase();
	const nets = Object.values(pinNets).map(n => n.toUpperCase());

	if (/^cin\b|c_?in|cbulk.?in|input.?cap|bypass.?in/.test(r) || (type === 'capacitor' && nets.includes('VIN') && nets.some(isGndNet))) {
		return 'cin';
	}
	if (/^cout\b|c_?out|cbulk.?out|output.?cap/.test(r) || (type === 'capacitor' && nets.includes('VOUT') && nets.some(isGndNet))) {
		return 'cout';
	}
	if (type === 'inductor' || /^l\b|inductor|choke/.test(r)) {
		return 'inductor';
	}
	if (type === 'diode' || /schottky|catch|rect|freewheel|diode/.test(r)) {
		return 'diode';
	}
	if (/rfb|feedback|vsense|fb\b|rtop|rbot|divider/.test(r)) {
		return 'feedback';
	}
	if (/boot|cboot|bootstrap/.test(r)) {
		return 'boot';
	}
	if (/^ss\b|soft.?start|css|en\b|enable/.test(r)) {
		return 'ss';
	}
	if (/comp|rc|cc\b/.test(r)) {
		return 'comp';
	}
	return 'other';
}

interface PendingPassive {
	ref: string;
	role: string;
	libId: string;
	rotation: number;
	value: string;
	nets: string[];
	pinNets: Record<string, string>;
	slot: PlaceSlot;
}

type IcSide = 'left' | 'right' | 'top' | 'bottom';

/**
 * Outward clearance from the IC graphic edge to a passive's center (mm).
 * Must clear passive half-extent + BODY_PAD on both sides (Device:R ≈ 6.35
 * + IC pad 2.54 → ≥8.9); 6 coarse grids keeps a comfortable gap.
 */
const OUTWARD_MARGIN_MM = GRID * 6;
/**
 * Spacing between staggered siblings on the same IC edge (mm).
 * Padded Device:R/C height is 12.7 mm — need > that on the perpendicular axis.
 */
const SIDE_SPACING_MM = GRID * 6;

/**
 * Place each passive near the IC pin(s) it actually connects to, instead of
 * a fixed per-role offset table. GND is excluded from anchoring since nearly
 * every part touches it — it carries no positional information and would
 * pull every passive toward wherever the GND pin happens to sit. A passive
 * with no non-GND net shared with an IC pin (rare — e.g. a bottom feedback
 * resistor only wired to FB/GND when FB isn't a direct IC pin) falls back to
 * a role-based edge guess.
 */
function placePassivesAroundIc(
	pending: PendingPassive[],
	icPins: PinLocal[],
	icPinNets: Record<string, string>,
	icRef: string,
	icLibId: string
): CircuitPlacement[] {
	const icPinTips = new Map<string, Point2>();
	for (const pin of icPins) {
		icPinTips.set(pin.number, localToWorld(IC_X, IC_Y, 0, pin.x, pin.y));
	}
	const netToIcTips = new Map<string, Point2[]>();
	for (const [pinNum, net] of Object.entries(icPinNets)) {
		const tip = icPinTips.get(pinNum);
		if (!tip) {
			continue;
		}
		const list = netToIcTips.get(net) ?? [];
		list.push(tip);
		netToIcTips.set(net, list);
	}

	const icBody = bodyAabbForPlacement(
		{ ref: icRef, libId: icLibId, x: IC_X, y: IC_Y, rotation: 0 },
		icPins
		// default BODY_PAD_MM — seed must clear collision boxes, not bare graphics
	);
	const icHalfW = (icBody.xmax - icBody.xmin) / 2;
	const icHalfH = (icBody.ymax - icBody.ymin) / 2;

	interface Anchored {
		item: PendingPassive;
		side: IcSide;
		projCoord: number | null;
	}

	const anchored: Anchored[] = pending.map(item => {
		const seenNets = new Set<string>();
		const tips: Point2[] = [];
		for (const net of Object.values(item.pinNets)) {
			if (!net || seenNets.has(net) || isGndNet(net)) {
				continue;
			}
			seenNets.add(net);
			const t = netToIcTips.get(net);
			if (t) {
				tips.push(...t);
			}
		}
		if (tips.length) {
			const ax = tips.reduce((s, p) => s + p.x, 0) / tips.length;
			const ay = tips.reduce((s, p) => s + p.y, 0) / tips.length;
			const dx = ax - IC_X;
			const dy = ay - IC_Y;
			const horizontal = Math.abs(dx) >= Math.abs(dy);
			const side: IcSide = horizontal
				? (dx >= 0 ? 'right' : 'left')
				: (dy >= 0 ? 'bottom' : 'top');
			return { item, side, projCoord: side === 'left' || side === 'right' ? ay : ax };
		}
		return { item, side: fallbackSideForSlot(item.slot), projCoord: null };
	});

	const bySide = new Map<IcSide, Anchored[]>();
	for (const a of anchored) {
		const list = bySide.get(a.side) ?? [];
		list.push(a);
		bySide.set(a.side, list);
	}

	const posByRef = new Map<string, { x: number; y: number }>();
	for (const group of bySide.values()) {
		const ordered = [...group].sort((a, b) => {
			if (a.projCoord == null && b.projCoord == null) {
				return 0;
			}
			if (a.projCoord == null) {
				return 1;
			}
			if (b.projCoord == null) {
				return -1;
			}
			return a.projCoord - b.projCoord;
		});
		const anchoredCoords = ordered
			.map(a => a.projCoord)
			.filter((v): v is number => v != null);
		const side = ordered[0]!.side;
		const centerCoord = anchoredCoords.length
			? anchoredCoords.reduce((s, v) => s + v, 0) / anchoredCoords.length
			: (side === 'left' || side === 'right' ? IC_Y : IC_X);

		ordered.forEach((a, i) => {
			const perp = roundGrid(centerCoord + (i - (ordered.length - 1) / 2) * SIDE_SPACING_MM);
			let x: number;
			let y: number;
			switch (a.side) {
				case 'left':
					x = roundGrid(IC_X - icHalfW - OUTWARD_MARGIN_MM);
					y = perp;
					break;
				case 'right':
					x = roundGrid(IC_X + icHalfW + OUTWARD_MARGIN_MM);
					y = perp;
					break;
				case 'top':
					x = perp;
					y = roundGrid(IC_Y - icHalfH - OUTWARD_MARGIN_MM);
					break;
				default:
					x = perp;
					y = roundGrid(IC_Y + icHalfH + OUTWARD_MARGIN_MM);
					break;
			}
			posByRef.set(a.item.ref, { x, y });
		});
	}

	return pending.map(item => {
		const pos = posByRef.get(item.ref) ?? { x: IC_X, y: IC_Y };
		return {
			ref: item.ref,
			role: item.role,
			libId: item.libId,
			x: pos.x,
			y: pos.y,
			rotation: item.rotation,
			value: item.value,
			nets: item.nets,
			pinNets: item.pinNets
		};
	});
}

type FdNodeRef =
	| { kind: 'ic'; point: Point2 }
	| { kind: 'part'; ref: string };

/**
 * Force-directed (Fruchterman-Reingold style) placement: components sharing
 * a net attract each other (and any IC pin on that net); every pair of
 * components repels. GND is excluded — it touches nearly everything and
 * would just pull the whole layout toward one point. This is what the
 * side-bucket heuristic (placePassivesAroundIc) can't do: two passives that
 * share a private net with each other but not with the IC (e.g. a bootstrap
 * cap and its inductor on the SW node) only cluster together here, because
 * they're literally connected by a spring — not just independently classified
 * onto "the same side of the IC".
 */
function forceDirectedPlace(
	pending: PendingPassive[],
	icPins: PinLocal[],
	icPinNets: Record<string, string>,
	icRef: string,
	icLibId: string
): CircuitPlacement[] {
	if (!pending.length) {
		return [];
	}

	const icPinTips = new Map<string, Point2>();
	for (const pin of icPins) {
		icPinTips.set(pin.number, localToWorld(IC_X, IC_Y, 0, pin.x, pin.y));
	}

	const netNodes = new Map<string, FdNodeRef[]>();
	for (const [pinNum, net] of Object.entries(icPinNets)) {
		if (isGndNet(net)) {
			continue;
		}
		const tip = icPinTips.get(pinNum);
		if (!tip) {
			continue;
		}
		const list = netNodes.get(net) ?? [];
		list.push({ kind: 'ic', point: tip });
		netNodes.set(net, list);
	}
	for (const item of pending) {
		for (const net of new Set(Object.values(item.pinNets))) {
			if (!net || isGndNet(net)) {
				continue;
			}
			const list = netNodes.get(net) ?? [];
			list.push({ kind: 'part', ref: item.ref });
			netNodes.set(net, list);
		}
	}

	const edges: Array<[FdNodeRef, FdNodeRef]> = [];
	for (const nodes of netNodes.values()) {
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				if (nodes[i]!.kind === 'ic' && nodes[j]!.kind === 'ic') {
					continue;
				}
				edges.push([nodes[i]!, nodes[j]!]);
			}
		}
	}

	// Warm start from the side-bucket heuristic — converges faster and avoids
	// the pathological all-parts-start-on-the-IC-center symmetric case.
	const seedPlacements = placePassivesAroundIc(pending, icPins, icPinNets, icRef, icLibId);
	const pos = new Map<string, Point2>();
	for (const p of seedPlacements) {
		pos.set(p.ref, { x: p.x, y: p.y });
	}
	const pointOf = (n: FdNodeRef): Point2 => n.kind === 'ic' ? n.point : pos.get(n.ref)!;
	const allRefs = pending.map(p => p.ref);

	// k = natural inter-node spacing (mm); repulsion ~ k²/d, attraction ~ d²/k
	// (classic Fruchterman-Reingold). Must exceed padded passive height
	// (Device:R ≈ 12.7 mm with 2-grid body pad) so the seed is not born
	// permanently overlapping — optimize's applyMoves rejects every nudge
	// that cannot clear an overlap in one step.
	const k = 20;
	const GRAVITY_K = 0.03;
	const ITERS = 400;
	let temp = k * 0.6;

	const repulseTargets: Point2[] = [
		{ x: IC_X, y: IC_Y },
		...icPins.map(p => localToWorld(IC_X, IC_Y, 0, p.x, p.y))
	];

	for (let iter = 0; iter < ITERS; iter++) {
		const disp = new Map<string, Point2>();
		for (const ref of allRefs) {
			disp.set(ref, { x: 0, y: 0 });
		}

		for (let i = 0; i < allRefs.length; i++) {
			const refA = allRefs[i]!;
			const pa = pos.get(refA)!;
			for (let j = i + 1; j < allRefs.length; j++) {
				const refB = allRefs[j]!;
				const pb = pos.get(refB)!;
				const dx = pa.x - pb.x;
				const dy = pa.y - pb.y;
				const dist = Math.max(0.5, Math.hypot(dx, dy));
				const f = (k * k) / dist;
				const da = disp.get(refA)!;
				const db = disp.get(refB)!;
				da.x += (dx / dist) * f;
				da.y += (dy / dist) * f;
				db.x -= (dx / dist) * f;
				db.y -= (dy / dist) * f;
			}
			for (const t of repulseTargets) {
				const dx = pa.x - t.x;
				const dy = pa.y - t.y;
				const dist = Math.max(0.5, Math.hypot(dx, dy));
				const f = (k * k) / dist;
				const da = disp.get(refA)!;
				da.x += (dx / dist) * f;
				da.y += (dy / dist) * f;
			}
		}

		for (const [a, b] of edges) {
			const pa = pointOf(a);
			const pb = pointOf(b);
			const dx = pa.x - pb.x;
			const dy = pa.y - pb.y;
			const dist = Math.max(0.5, Math.hypot(dx, dy));
			const f = (dist * dist) / k;
			if (a.kind === 'part') {
				const da = disp.get(a.ref)!;
				da.x -= (dx / dist) * f;
				da.y -= (dy / dist) * f;
			}
			if (b.kind === 'part') {
				const db = disp.get(b.ref)!;
				db.x += (dx / dist) * f;
				db.y += (dy / dist) * f;
			}
		}

		// Mild direct pull toward the IC center, independent of nets. A part
		// that's only reachable via another part (e.g. a compensation cap
		// wired to a resistor that's wired to the IC — two hops, no net edge
		// of its own to any IC pin) has nothing anchoring the far end of that
		// chain; if repulsion in a crowded area pushes the near part out, it
		// drags the far one with it and nothing pulls it back. This is weak
		// enough to never fight a real net spring, it just stops chains from
		// drifting unboundedly.
		for (const ref of allRefs) {
			const p = pos.get(ref)!;
			const d = disp.get(ref)!;
			d.x += (IC_X - p.x) * GRAVITY_K;
			d.y += (IC_Y - p.y) * GRAVITY_K;
		}

		for (const ref of allRefs) {
			const d = disp.get(ref)!;
			const mag = Math.max(0.01, Math.hypot(d.x, d.y));
			const step = Math.min(mag, temp);
			const p = pos.get(ref)!;
			p.x += (d.x / mag) * step;
			p.y += (d.y / mag) * step;
		}

		temp *= 0.99;
	}

	// Per-net anchor points (excluding GND) for rotation choice below — same
	// idea as the edges above, but keyed by net with each contributor's
	// owner so a part can exclude its own contribution when facing itself.
	const netContributors = new Map<string, Array<{ owner: string | null; point: Point2 }>>();
	for (const [pinNum, net] of Object.entries(icPinNets)) {
		if (isGndNet(net)) {
			continue;
		}
		const tip = icPinTips.get(pinNum);
		if (!tip) {
			continue;
		}
		const list = netContributors.get(net) ?? [];
		list.push({ owner: null, point: tip });
		netContributors.set(net, list);
	}
	for (const item of pending) {
		const p = pos.get(item.ref)!;
		for (const net of new Set(Object.values(item.pinNets))) {
			if (!net || isGndNet(net)) {
				continue;
			}
			const list = netContributors.get(net) ?? [];
			list.push({ owner: item.ref, point: p });
			netContributors.set(net, list);
		}
	}
	const netAnchorExcluding = (net: string, excludeRef: string): Point2 | null => {
		const contributors = (netContributors.get(net) ?? []).filter(c => c.owner !== excludeRef);
		if (!contributors.length) {
			return null;
		}
		return {
			x: contributors.reduce((s, c) => s + c.point.x, 0) / contributors.length,
			y: contributors.reduce((s, c) => s + c.point.y, 0) / contributors.length
		};
	};

	const placements: CircuitPlacement[] = pending.map(item => {
		const p = pos.get(item.ref)!;
		const rotation = VERTICAL_2PIN_LIB_IDS.has(item.libId)
			? chooseTwoPinRotation(item, p, netAnchorExcluding)
			: item.rotation;
		return {
			ref: item.ref,
			role: item.role,
			libId: item.libId,
			x: roundGrid(p.x),
			y: roundGrid(p.y),
			rotation,
			value: item.value,
			nets: item.nets,
			pinNets: item.pinNets
		};
	});

	resolveResidualOverlaps(placements, icPins);
	return placements;
}

const VERTICAL_2PIN_LIB_IDS = new Set(['Device:R', 'Device:C', 'Device:L', 'Device:FerriteBead']);

/**
 * Try all 4 rotations of a 2-pin vertical passive (pin 1 local (0,3.81), pin
 * 2 local (0,-3.81)) and pick whichever makes pin 1 point toward its net's
 * anchor and pin 2 toward its own — e.g. an inductor between SW and VOUT
 * should have its SW-side pin actually facing the SW-side neighbors, not
 * facing away from them because of an arbitrary type-based default rotation.
 * A GND-side pin has no meaningful "direction" (GND is everywhere), so only
 * non-GND anchors count toward the score.
 */
function chooseTwoPinRotation(
	item: PendingPassive,
	pos: Point2,
	netAnchorExcluding: (net: string, excludeRef: string) => Point2 | null
): number {
	const net1 = item.pinNets['1'];
	const net2 = item.pinNets['2'];
	const anchor1 = net1 && !isGndNet(net1) ? netAnchorExcluding(net1, item.ref) : null;
	const anchor2 = net2 && !isGndNet(net2) ? netAnchorExcluding(net2, item.ref) : null;
	if (!anchor1 && !anchor2) {
		return item.rotation;
	}

	let bestRot = 0;
	let bestScore = -Infinity;
	for (const r of [0, 90, 180, 270]) {
		const p1 = localToWorld(0, 0, r, 0, 3.81);
		const p2 = localToWorld(0, 0, r, 0, -3.81);
		let score = 0;
		if (anchor1) {
			score += directionAlignment(p1, { x: anchor1.x - pos.x, y: anchor1.y - pos.y });
		}
		if (anchor2) {
			score += directionAlignment(p2, { x: anchor2.x - pos.x, y: anchor2.y - pos.y });
		}
		if (score > bestScore) {
			bestScore = score;
			bestRot = r;
		}
	}
	return bestRot;
}

/** Cosine similarity between two direction vectors (1 = same direction). */
function directionAlignment(a: Point2, b: Point2): number {
	const la = Math.hypot(a.x, a.y) || 1;
	const lb = Math.hypot(b.x, b.y) || 1;
	return (a.x * b.x + a.y * b.y) / (la * lb);
}

/**
 * Force-directed convergence packs parts to their natural equilibrium
 * distance, which can leave them body-to-body with no visual breathing
 * room, and grid-snapping afterward can collapse two parts that converged
 * very close together onto overlapping cells. Nudge any pair whose
 * graphic+2-grid AABBs overlap one grid step at a time along the axis with
 * more separation, until every pair has real clearance. The IC itself never
 * moves.
 */
function resolveResidualOverlaps(placements: CircuitPlacement[], icPins: PinLocal[]): void {
	for (let pass = 0; pass < 120; pass++) {
		let moved = false;
		const gndPlacements = collectGndPowerPlacements(
			placements,
			(libId) => pinsForLib(libId, icPins)
		);
		const bodies = [
			...placements.map(p => {
				const isPassive = p.libId.startsWith('Device:') || p.libId.startsWith('power:');
				return bodyAabbForPlacement(p, isPassive ? undefined : icPins);
			}),
			...gndPlacements.map(p => bodyAabbForPlacement(p, undefined))
		];
		const nParts = placements.length;
		for (let i = 0; i < bodies.length; i++) {
			for (let j = i + 1; j < bodies.length; j++) {
				// bodyAabbForPlacement already includes BODY_PAD_MM (2 grid).
				if (!aabbsOverlap(bodies[i]!, bodies[j]!)) {
					continue;
				}
				const aIsPart = i < nParts;
				const bIsPart = j < nParts;
				// GND↔GND: unavoidable on multi-GND ICs — do not push (symbols follow pins).
				if (!aIsPart && !bIsPart) {
					continue;
				}
				// Owner part ↔ its own GND stem — padded boxes touch; not a defect.
				if (aIsPart !== bIsPart) {
					const gnd = aIsPart
						? gndPlacements[j - nParts]!
						: gndPlacements[i - nParts]!;
					const part = aIsPart ? placements[i]! : placements[j]!;
					if (gnd.ownerRef === part.ref) {
						continue;
					}
				}
				const a = aIsPart ? placements[i]! : null;
				const b = bIsPart ? placements[j]! : null;
				const pushA = !!a && a.role !== 'IC';
				const pushB = !!b && b.role !== 'IC';
				if (!pushA && !pushB) {
					continue;
				}
				const ax = a?.x ?? gndPlacements[i - nParts]!.x;
				const ay = a?.y ?? gndPlacements[i - nParts]!.y;
				const bx = b?.x ?? gndPlacements[j - nParts]!.x;
				const by = b?.y ?? gndPlacements[j - nParts]!.y;
				const dx = bx - ax;
				const dy = by - ay;
				const horizontal = Math.abs(dx) >= Math.abs(dy);
				if (horizontal) {
					const sign = dx >= 0 ? 1 : -1;
					if (pushB && b) {
						b.x = roundGrid(b.x + sign * GRID);
					}
					if (pushA && a) {
						a.x = roundGrid(a.x - sign * GRID);
					}
				}
				else {
					const sign = dy >= 0 ? 1 : -1;
					if (pushB && b) {
						b.y = roundGrid(b.y + sign * GRID);
					}
					if (pushA && a) {
						a.y = roundGrid(a.y - sign * GRID);
					}
				}
				moved = true;
			}
		}
		if (!moved) {
			break;
		}
	}
}

function fallbackSideForSlot(slot: PlaceSlot): IcSide {
	switch (slot) {
		case 'cin':
		case 'boot':
		case 'ss':
			return 'left';
		case 'cout':
		case 'feedback':
			return 'right';
		case 'inductor':
		case 'diode':
			return 'top';
		default:
			return 'bottom';
	}
}

/** Exposed for smoke tests — which Device:* lib Place would pick (null = skipped). */
export function resolvePassiveLibForPlace(comp: CircuitDesignComponent): string | null {
	return resolvePassiveMapping(comp)?.libId ?? null;
}

/**
 * Resolve passive pin→net the same way seed() does (for smoke / debug).
 * Primary = components[].pinNets; secondary = recipe.nets (+ role alias).
 */
export function resolvePlacedPassivePinNets(
	recipe: CircuitDesignRecipe,
	comp: CircuitDesignComponent
): Record<string, string> {
	const mapping = resolvePassiveMapping(comp);
	const libId = mapping?.libId ?? 'Device:C';
	const warnings: string[] = [];
	const ref = sanitizeRef(
		comp.ref,
		(mapping?.defaultRef ?? 'C') + '1'
	);
	return mergePinNetsPreferPrimary(
		resolveComponentPinNets(comp, libId, warnings),
		pinNetsFromRecipeNets(recipe, ref, comp.role),
		warnings,
		ref
	);
}

function isCircuitDesignDebug(): boolean {
	try {
		const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
		return env?.['CIRCUIT_DESIGN_DEBUG'] === '1' || env?.['NODE_ENV'] === 'development';
	}
	catch {
		return false;
	}
}

function logPinNetDebug(
	placements: CircuitPlacement[],
	icPins: PinLocal[]
): void {
	if (!isCircuitDesignDebug()) {
		return;
	}
	for (const p of placements) {
		const pins = pinsForLib(p.libId, icPins);
		for (const pin of pins) {
			const net = p.pinNets[pin.number];
			if (!net) {
				continue;
			}
			const tip = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
			console.debug(
				`[circuit-design/place] ${ p.ref }.${ pin.number } → ${ net } tip(${ fmtMm(tip.x) },${ fmtMm(tip.y) })`
			);
		}
	}
}

function logEmitPinDebug(
	placements: CircuitPlacement[],
	icPins: PinLocal[]
): void {
	for (const p of placements) {
		const pins = pinsForLib(p.libId, icPins);
		for (const pin of pins) {
			const net = p.pinNets[pin.number];
			if (!net) {
				continue;
			}
			const tip = localToWorld(p.x, p.y, p.rotation, pin.x, pin.y);
			console.debug(
				`[circuit-design/emit] ${ p.ref }.${ pin.number } → ${ net } tip(${ fmtMm(tip.x) },${ fmtMm(tip.y) })`
			);
		}
	}
}

function resolvePassiveMapping(comp: CircuitDesignComponent): {
	libId: PassiveLibId;
	defaultRef: string;
} | null {
	const role = (comp.role || '').toLowerCase();
	const value = (comp.value || '').toLowerCase();
	const ref = (comp.ref || '').toLowerCase();
	let type = comp.type;
	// External LM leftovers: cap/res aliases or missing type with C*/R*/L* refs.
	if (type === 'other' || !type) {
		const rawType = String((comp as { type?: string }).type ?? '').toLowerCase();
		if (rawType === 'cap' || rawType === 'c' || /^c\d/i.test(ref) || /\d\s*[pnum]?f\b|uf|nf|pf/.test(value)) {
			type = 'capacitor';
		}
		else if (rawType === 'res' || rawType === 'r' || /^r\d/i.test(ref)) {
			type = 'resistor';
		}
		else if (rawType === 'ind' || rawType === 'l' || /^l\d/i.test(ref) || /uh|mh/.test(value)) {
			type = 'inductor';
		}
		else if (rawType === 'led' || /^d\d/i.test(ref)) {
			type = 'diode';
		}
	}

	if (type === 'resistor' || /^r\b|resistor|rfb|rt\b|pull/.test(role) || /^r\d/i.test(ref)) {
		return { libId: 'Device:R', defaultRef: 'R' };
	}
	if (type === 'capacitor' || /^c\b|cap|cin|cout|cboot|css|bypass/.test(role) || /^c\d/i.test(ref)) {
		return { libId: 'Device:C', defaultRef: 'C' };
	}
	if (type === 'inductor' || /^l\b|inductor|choke/.test(role) || /^l\d/i.test(ref)) {
		return { libId: 'Device:L', defaultRef: 'L' };
	}
	if (type === 'ferrite' || /ferrite|bead/.test(role)) {
		return { libId: 'Device:FerriteBead', defaultRef: 'FB' };
	}
	if (type === 'diode' || /diode|schottky|catch|rect|zener|led/.test(role) || /schottky|led|zener/.test(value) || /^d\d/i.test(ref)) {
		if (/led/.test(role) || /led/.test(value)) {
			return { libId: 'Device:LED', defaultRef: 'D' };
		}
		if (/schottky|catch|freewheel/.test(role) || /schottky/.test(value)) {
			return { libId: 'Device:D_Schottky', defaultRef: 'D' };
		}
		return { libId: 'Device:D', defaultRef: 'D' };
	}
	if (type === 'connector') {
		return null;
	}
	// Last-chance ref heuristic so Place does not drop unknown-typed passives.
	if (/^c\d/i.test(ref)) {
		return { libId: 'Device:C', defaultRef: 'C' };
	}
	if (/^r\d/i.test(ref)) {
		return { libId: 'Device:R', defaultRef: 'R' };
	}
	if (/^l\d/i.test(ref)) {
		return { libId: 'Device:L', defaultRef: 'L' };
	}
	if (/^d\d/i.test(ref)) {
		return { libId: 'Device:D', defaultRef: 'D' };
	}
	return null;
}

function formatPassiveValue(comp: CircuitDesignComponent): string {
	const fromBom = comp.bomSuggestion?.value?.trim();
	const raw = (fromBom || comp.value || '').trim();
	if (!raw) {
		return comp.ref;
	}
	if (comp.type === 'resistor') {
		return raw.replace(/Ω/g, '').trim() || raw;
	}
	if (comp.type === 'capacitor') {
		return (raw.split(/\s+/)[0] || raw).replace(/F$/i, '').trim() || raw;
	}
	if (comp.type === 'inductor') {
		return raw.replace(/H$/i, '').trim() || raw;
	}
	return raw;
}

function buildFootprintHints(
	recipe: CircuitDesignRecipe,
	sources: {
		packageHint: string;
		kicadFootprint: string;
		kicadSymbol: string;
	},
	warnings: string[]
): Record<string, string> {
	const out: Record<string, string> = {};
	const icRef = recipe.ic.ref || 'U1';
	const icFp = resolveFootprintLibId(
		{
			packageHint: sources.packageHint,
			kicadFootprint: sources.kicadFootprint,
			kicadSymbol: sources.kicadSymbol
		},
		warnings,
		icRef
	);
	if (icFp) {
		out[icRef] = icFp;
	}
	for (const c of recipe.components ?? []) {
		const notes = c.bomSuggestion?.notes?.trim() || '';
		const fpMatch = /footprint[:\s]+([^\s,;]+)/i.exec(notes);
		if (!fpMatch) {
			continue;
		}
		const passiveFp = resolveFootprintLibId(
			{ packageHint: fpMatch[1]!, kicadFootprint: fpMatch[1]!, kicadSymbol: '' },
			warnings,
			c.ref
		);
		if (passiveFp) {
			out[c.ref] = passiveFp;
		}
	}
	return out;
}

/** Schematic Footprint property must be a short lib_id (`Lib:Name`), never full .kicad_mod. */
function resolveFootprintLibId(
	sources: {
		packageHint?: string;
		kicadFootprint?: string;
		kicadSymbol?: string;
	},
	warnings: string[],
	ref: string
): string {
	const candidates: string[] = [];

	const pkg = sources.packageHint?.trim() || '';
	if (pkg && looksLikeFootprintLibId(pkg)) {
		candidates.push(pkg);
	}

	const fromMod = extractLibIdFromFootprintText(sources.kicadFootprint || '');
	if (fromMod) {
		candidates.push(fromMod);
	}

	// Bare lib_id accidentally stored in kicadFootprint (no sexp).
	const fpRaw = sources.kicadFootprint?.trim() || '';
	if (fpRaw && looksLikeFootprintLibId(fpRaw) && !fpRaw.includes('(')) {
		candidates.push(fpRaw);
	}

	const fromSymbol = extractFootprintPropertyFromSymbol(sources.kicadSymbol || '');
	if (fromSymbol) {
		candidates.push(fromSymbol);
	}

	let sawCorruption = false;
	for (const c of candidates) {
		const id = sanitizeFootprintLibId(c);
		if (!id) {
			continue;
		}
		if (looksCorruptedFootprintLibId(id)) {
			sawCorruption = true;
			continue;
		}
		return id;
	}

	if (sawCorruption) {
		warnings.push(
			`Footprint for ${ ref } looks corrupted (pads/newlines); omitting Footprint property`
		);
	}
	else if (fpRaw && (/\(\s*footprint\b/i.test(fpRaw) || /\(\s*kicad_mod\b/i.test(fpRaw) || /\(\s*pad\b/i.test(fpRaw))) {
		warnings.push(
			`Could not extract footprint lib_id for ${ ref } from kicadFootprint — Footprint property left empty`
		);
	}
	return '';
}

function looksLikeFootprintLibId(value: string): boolean {
	const v = value.trim();
	if (!v || v.includes('\n') || v.includes('\r') || v.includes('(')) {
		return false;
	}
	// Lib:Name — allow common KiCad footprint name chars.
	return /^[A-Za-z0-9][A-Za-z0-9_.+-]*:[A-Za-z0-9][A-Za-z0-9_./+-]*$/.test(v);
}

function extractLibIdFromFootprintText(text: string): string | null {
	const t = text.trim();
	if (!t) {
		return null;
	}
	const quoted = /^\(\s*(?:footprint|module|kicad_mod)\s+"([^"]+)"/i.exec(t);
	if (quoted?.[1]) {
		return quoted[1].trim();
	}
	const bare = /^\(\s*(?:footprint|module|kicad_mod)\s+([^\s()"]+)/i.exec(t);
	if (bare?.[1]) {
		return bare[1].trim();
	}
	return null;
}

function extractFootprintPropertyFromSymbol(symbolText: string): string | null {
	const t = symbolText.trim();
	if (!t) {
		return null;
	}
	const m = /\(\s*property\s+"Footprint"\s+"([^"]*)"/i.exec(t);
	if (!m) {
		return null;
	}
	const val = (m[1] || '').trim();
	return val && val !== '~' ? val : null;
}

function sanitizeFootprintLibId(raw: string): string {
	return raw.trim().replace(/^"+|"+$/g, '').trim();
}

function looksCorruptedFootprintLibId(id: string): boolean {
	return (
		id.includes('\n')
		|| id.includes('\r')
		|| /\(\s*pad\b/i.test(id)
		|| /\(\s*footprint\b/i.test(id)
		|| /\(\s*model\b/i.test(id)
		|| id.length > 200
	);
}

function roundGrid(n: number): number {
	return snapToGrid(n, GRID);
}

function isGndNet(name: string): boolean {
	return /^(GND|AGND|PGND|DGND|SGND|VSS|VSSA|0V|GNDA|GNDP)$/i.test(name.trim());
}

function isPowerLikeNet(name: string): boolean {
	const n = name.trim();
	if (isGndNet(n)) {
		return false;
	}
	return /^(VIN|VOUT|VCC|VDD|VBAT|VBUS|PVIN|AVIN|\+?-?\d+(\.\d+)?V|V[A-Z]?\d*)$/i.test(n)
		|| /^\+\d/.test(n);
}

/** Unicode space chars (avoid dense \\uXXXX char-class literals — they hang esbuild-plugin-ts-decorators' strip-it). */
const UNICODE_SPACE_RE = new RegExp(
	`[${ [
		'\u00A0', '\u1680',
		'\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
		'\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u200B',
		'\u202F', '\u205F', '\u3000', '\uFEFF',
	].join('') }]`,
	'g',
);

function sanitizeNetName(raw: string): string {
	return raw
		.replace(UNICODE_SPACE_RE, ' ')
		.trim()
		.replace(/\s+/g, '_')
		.slice(0, 64);
}

function sanitizeRef(raw: string, fallback: string): string {
	const t = raw.trim().toUpperCase();
	// Allow C1, R12, and letter-suffix banks (C1A).
	if (/^[A-Z]+\d+[A-Z0-9]*$/i.test(t)) {
		return t;
	}
	return fallback;
}

/**
 * Overlay x/y/rotation from a KiCad schematic fragment onto recipe seed
 * placements (pinNets/libId/role stay from the seed). Also restores editable
 * power:GND (#PWR) poses from the fragment when present.
 */
export function overlayPosesFromSchematic(
	seed: CircuitPlacement[],
	fragment: string
): CircuitPlacement[] {
	const poses = parseSymbolPosesFromFragment(fragment);
	if (!poses.size) {
		return seed.map(clonePlacement);
	}
	const components = seed.map(p => {
		const pose = poses.get(p.ref) ?? poses.get(p.ref.toUpperCase());
		if (!pose) {
			return clonePlacement(p);
		}
		return {
			...clonePlacement(p),
			x: pose.x,
			y: pose.y,
			rotation: pose.rotation
		};
	});
	const gndOverrides: CircuitPlacement[] = [];
	for (const [ref, pose] of poses) {
		if (!ref.startsWith('#PWR') && pose.libId !== 'power:GND') {
			continue;
		}
		gndOverrides.push({
			ref,
			role: 'GND',
			libId: 'power:GND',
			x: pose.x,
			y: pose.y,
			rotation: gndInstanceRotation(),
			value: 'GND',
			nets: ['GND'],
			pinNets: { '1': 'GND' }
		});
	}
	return [...components, ...gndOverrides];
}

interface SymbolPose {
	x: number;
	y: number;
	rotation: number;
	libId: string;
}

/**
 * Parse placed symbol instances from a KiCad sch fragment / full schematic.
 * Includes power:GND (#PWR) so edit-mode can restore moved GND poses.
 */
export function parseSymbolPosesFromFragment(text: string): Map<string, SymbolPose> {
	const out = new Map<string, SymbolPose>();
	if (!text?.trim()) {
		return out;
	}
	const re = /\(symbol\s+\(lib_id\s+"([^"]+)"\)\s+\(at\s+([-\d.]+)\s+([-\d.]+)\s+(\d+)\)([\s\S]*?)(?=\n\(symbol\s+\(lib_id|\n\(wire\b|\n\(label\b|\n\(global_label\b|\n\(junction\b|\n\(sheet_instances\b|\n\(embedded_fonts\b|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const libId = m[1] ?? '';
		const x = Number(m[2]);
		const y = Number(m[3]);
		const rotation = Number(m[4]);
		const body = m[5] ?? '';
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rotation)) {
			continue;
		}
		const refMatch = body.match(/\(property\s+"Reference"\s+"([^"]+)"/);
		const ref = refMatch?.[1]?.trim();
		if (!ref) {
			continue;
		}
		if (libId === 'power:GND' || ref.startsWith('#PWR')) {
			out.set(ref, {
				x,
				y,
				rotation: gndInstanceRotation(),
				libId: 'power:GND'
			});
			continue;
		}
		if (libId.startsWith('power:') || ref.startsWith('#')) {
			continue;
		}
		out.set(ref, {
			x,
			y,
			rotation: normalizeRot(rotation),
			libId
		});
	}
	return out;
}

function clonePlacement(p: CircuitPlacement): CircuitPlacement {
	return {
		...p,
		nets: [...p.nets],
		pinNets: { ...p.pinNets }
	};
}

