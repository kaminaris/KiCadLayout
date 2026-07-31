/**
 * Build a locked pin↔net map + per-lib pin locals from a loaded `.kicad_sch`
 * so autoroute-on-drag works without a Circuit Design recipe.
 */

import { KicadParser } from '@kicad-io/KicadParser';
import { KicadElement } from '@kicad-io/KicadElement';
import { KicadElementLibSymbols } from '@kicad-io/KicadElementLibSymbols';
import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadElementPin } from '@kicad-io/KicadElementPin';
import { KicadElementAt } from '@kicad-io/KicadElementAt';

import {
	SchematicConnectivityService,
	type SchematicConnectivitySummary,
} from './Connectivity';
import { POWER_GND_PIN, type PinLocal } from './Geometry';
import { isGndNetName } from './Router';
import {
	HORIZONTAL_DIODE_PINS,
	VERTICAL_2PIN,
} from '@kicad-io/Catalog/DevicePassiveSymbols';

export interface LockedNetlist {
	/** Ref → pin number → net name (frozen for the edit session). */
	pinNetsByRef: Record<string, Record<string, string>>;
	/** Lib id → library-local pin poses. */
	pinsByLib: Record<string, PinLocal[]>;
	/**
	 * Net names that are GROUND — a `power:GND*` symbol sits on them (∪ a name
	 * heuristic). Authoritative over net names, so a ground net renamed by a
	 * global label (labels outrank power symbols in naming) is still grounded
	 * with ground symbols rather than wired or labelled.
	 */
	gndNets: Set<string>;
	/** Ground net → the ground glyph lib id (`power:GND`, `power:GNDA`, …). */
	gndLibByNet: Record<string, string>;
	/** Connectivity summary (debug / UI). */
	summary: SchematicConnectivitySummary;
	warnings: string[];
}

/**
 * Flood-fill connectivity from schematic text and extract pin geometry from
 * embedded `lib_symbols`. Call once on load; keep the result while dragging.
 */
export function lockNetlistFromSchematic(schematicText: string): LockedNetlist {
	const warnings: string[] = [];
	const connectivity = new SchematicConnectivityService();
	const summary = connectivity.buildFromSchematicText(schematicText);

	const pinNetsByRef: Record<string, Record<string, string>> = {};
	for (const comp of summary.components) {
		const pinNets: Record<string, string> = {};
		for (const pin of comp.pins) {
			const net = pin.net?.trim();
			if (!net) {
				continue;
			}
			pinNets[pin.number] = net;
		}
		pinNetsByRef[comp.ref] = pinNets;
	}

	const pinsByLib = extractPinsByLibFromSchematic(schematicText, warnings);
	// Ensure every placed lib has an entry (fall back to catalog passives / empty).
	for (const comp of summary.components) {
		if (!comp.libId || pinsByLib[comp.libId]) {
			continue;
		}
		const fallback = catalogPinsForLib(comp.libId);
		if (fallback) {
			pinsByLib[comp.libId] = fallback;
		}
		else {
			warnings.push(`No pin geometry for lib "${comp.libId}" — routing may miss terminals`);
			pinsByLib[comp.libId] = [];
		}
	}

	const withNets = Object.values(pinNetsByRef).filter(p => Object.keys(p).length > 0).length;
	if (withNets === 0) {
		warnings.push('Locked netlist has no pin↔net assignments — schematic may have no wires');
	}

	// Ground nets: any net a power:GND* symbol sits on (reliable, name-agnostic),
	// plus the name heuristic for grounds expressed by a "GND" label / bare name.
	const gndNets = new Set<string>();
	const gndLibByNet: Record<string, string> = {};
	for (const comp of summary.components) {
		if (!comp.libId.startsWith('power:GND')) {
			continue;
		}
		for (const pin of comp.pins) {
			if (pin.net) {
				gndNets.add(pin.net);
				gndLibByNet[pin.net] ??= comp.libId;
			}
		}
	}
	for (const net of summary.nets) {
		if (isGndNetName(net.name)) {
			gndNets.add(net.name);
		}
	}

	return { pinNetsByRef, pinsByLib, gndNets, gndLibByNet, summary, warnings };
}

export function pinsForLockedLib(
	libId: string,
	pinsByLib: Record<string, PinLocal[]>
): PinLocal[] {
	if (libId === 'power:GND') {
		return [POWER_GND_PIN];
	}
	const catalog = catalogPinsForLib(libId);
	if (catalog) {
		return pinsByLib[libId]?.length ? pinsByLib[libId]! : catalog;
	}
	return pinsByLib[libId] ?? [];
}

function catalogPinsForLib(libId: string): PinLocal[] | null {
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
	return null;
}

function extractPinsByLibFromSchematic(
	schematicText: string,
	warnings: string[]
): Record<string, PinLocal[]> {
	const out: Record<string, PinLocal[]> = {};
	let root: KicadElement;
	try {
		root = new KicadParser().parse(schematicText);
	}
	catch (e: unknown) {
		warnings.push(`Failed to parse schematic for pin geometry: ${(e as Error)?.message ?? e}`);
		return out;
	}

	const libSymbols = root.findFirstChildByClass(KicadElementLibSymbols);
	if (!libSymbols) {
		warnings.push('Schematic has no lib_symbols — using catalog pin layouts only');
		return out;
	}

	for (const sym of libSymbols.findChildrenByClass(KicadElementSymbol)) {
		const name = String(sym.symbolName ?? '').trim();
		if (!name) {
			continue;
		}
		// KiCad stores unit bodies as siblings: "Device:C_0_1" → fold into "Device:C".
		const libId = name.replace(/_\d+_\d+$/, '');
		const pins = extractPinLocals(sym);
		if (!pins.length) {
			continue;
		}
		const existing = out[libId] ?? [];
		const seen = new Set(existing.map(p => p.number));
		for (const pin of pins) {
			if (seen.has(pin.number)) {
				continue;
			}
			seen.add(pin.number);
			existing.push(pin);
		}
		out[libId] = existing;
	}
	return out;
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
				rotation: at?.rotation ?? 0,
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
