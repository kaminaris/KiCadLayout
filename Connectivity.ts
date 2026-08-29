import { parseSchematic } from '@kicad-model/src/schematic/sch_io';
import type { Schematic } from '@kicad-model/src/schematic/Schematic';
import { SchematicSymbol } from '@kicad-model/src/schematic/SchematicSymbol';
import { SchPin } from '@kicad-model/src/schematic/SchPin';
import { SchWire } from '@kicad-model/src/schematic/SchWire';
import { SchJunction } from '@kicad-model/src/schematic/SchJunction';
import { SchNoConnect } from '@kicad-model/src/schematic/SchNoConnect';
import { SchGlobalLabel, SchHierLabel, SchLabel } from '@kicad-model/src/schematic/SchLabel';
import { SchematicSheet } from '@kicad-model/src/schematic/SchematicSheet';
import { SchematicSheetPin } from '@kicad-model/src/schematic/SchematicSheetPin';
import { SchematicSheetPath } from '@kicad-model/src/schematic/SheetPath';
import { buildSheetConnectionGraph } from '@kicad-model/src/schematic/ConnectionGraph';
import { busAliasResolverFor } from '@kicad-model/src/schematic/HierarchicalConnectionGraph';
import type { GraphItem } from '@kicad-model/src/schematic/ConnectionGraphBuilder';
import type { ConnectionSubgraph } from '@kicad-model/src/schematic/ConnectionSubgraph';

export interface ConnectivityPinSummary {
	number: string;
	name: string;
	type: string;
	/** Set after net assignment — e.g. `"U1.3"` or `"IMU/U1.3"`. */
	net?: string;
}

export interface ConnectivityComponent {
	ref: string;
	value: string;
	libId: string;
	pins: ConnectivityPinSummary[];
	isPower?: boolean;
	dnp?: boolean;
	/** Hierarchy path segment(s), empty for root sheet. */
	sheetPath?: string;
}

export interface ConnectivityNet {
	name: string;
	pins: string[];
	power?: boolean;
	labels?: string[];
	/**
	 * True when the island has a name (label / sheet pin / power) but no
	 * component pins snapped onto it — typically a label-only stub or a
	 * failed pin↔wire snap. Useful for UI debugging; excluded from LM nets.
	 */
	labelOnly?: boolean;
}

export interface ConnectivityHeuristic {
	severity: 'error' | 'warning' | 'info';
	category: string;
	refs?: string[];
	net?: string;
	message: string;
}

export interface ConnectivitySheetInfo {
	/** Hierarchy path ("" = root, "IMU", "IMU/ADC"). */
	path: string;
	name: string;
	file: string;
}

/** Compact netlist-like summary for LM validation. */
export interface SchematicConnectivitySummary {
	componentCount: number;
	netCount: number;
	components: ConnectivityComponent[];
	nets: ConnectivityNet[];
	powerNets: string[];
	heuristics: ConnectivityHeuristic[];
	limits: string[];
	sheetPinsNoted: number;
	/** Present when a multi-sheet tree was loaded. */
	sheets?: ConnectivitySheetInfo[];
}

/** One schematic file in a loaded hierarchy (from disk or paste root). */
export interface LoadedSchematicNode {
	absolutePath: string;
	/** "" for root; "SheetName" or "Parent/Child" for nested sheets. */
	hierarchyPath: string;
	sheetName: string;
	text: string;
	children: LoadedSchematicNode[];
}

interface SheetIsland {
	id: string;
	nameHint: string;
	isPower: boolean;
	/** Real component pins only (excludes #PWR / #FLG / power-lib clutter). */
	pinKeys: string[];
	/** Power / PWR_FLAG pins — used to assign pin.net, omitted from net.pins. */
	powerPinKeys: string[];
	labelNames: string[];
	globalNames: string[];
	hierNames: string[];
	localNames: string[];
	/** Sheet-box pin names touching this island (parent side). */
	sheetPinNames: string[];
	/** Mergeable power net names only (never "PWR_FLAG"). */
	powerNames: string[];
	/** True when a PWR_FLAG marker sits on this island (ERC only; not a merge key). */
	hasPwrFlag: boolean;
	hasNc: boolean;
}

interface SheetExtract {
	hierarchyPath: string;
	sheetName: string;
	file: string;
	components: ConnectivityComponent[];
	islands: SheetIsland[];
	/** Hierarchical label name → island id (child side of sheet boundary). */
	hierLabelToIsland: Map<string, string>;
	/** Sheet-box pin name → island id (parent side of sheet boundary). */
	sheetPinToIsland: Map<string, string>;
	sheetPinCount: number;
	childSheetNames: string[];
}

export class SchematicConnectivityService {
	/**
	 * Parse a single `.kicad_sch` string into components + nets.
	 * Sheet boxes / hierarchical labels are tagged geometrically; child
	 * Sheetfile contents are not loaded (use {@link buildFromLoadedTree}).
	 */
	buildFromSchematicText(schematicText: string): SchematicConnectivitySummary {
		const text = schematicText?.trim() ?? '';
		if (!text) {
			throw new SchematicConnectivityError('schematicText is required', 400);
		}
		if (!text.includes('kicad_sch')) {
			throw new SchematicConnectivityError('Input does not look like a KiCad schematic (.kicad_sch)', 400);
		}

		const model = parseSchematic(text);
		const extract = this.extractSheet(model, {
			hierarchyPath: '',
			sheetName: 'root',
			file: '(paste)'
		});
		return this.finalizeFromExtracts([extract], {
			hierarchical: false,
			missingChildren: extract.childSheetNames.length > 0
		});
	}

	/**
	 * Build a project-wide netlist from a recursively loaded sheet tree
	 * (root + child Sheetfile contents). Cross-sheet connections:
	 * parent sheet pins ↔ child hierarchical labels (by name), plus
	 * global labels and power nets merged by name across all sheets.
	 */
	buildFromLoadedTree(tree: LoadedSchematicNode): SchematicConnectivitySummary {
		const extracts: SheetExtract[] = [];
		const walk = (node: LoadedSchematicNode) => {
			const text = node.text?.trim() ?? '';
			if (!text.includes('kicad_sch')) {
				throw new SchematicConnectivityError(
					`Sheet "${ node.sheetName }" (${ node.absolutePath }) is not a KiCad schematic`,
					400
				);
			}
			const model = parseSchematic(text);
			const file = basenameOf(node.absolutePath) || node.sheetName;
			extracts.push(this.extractSheet(model, {
				hierarchyPath: node.hierarchyPath,
				sheetName: node.sheetName,
				file
			}));
			for (const child of node.children) {
				walk(child);
			}
		};
		walk(tree);

		const links: Array<{ parentIsland: string; childIsland: string; pinName: string }> = [];
		const indexByPath = new Map(extracts.map(e => [e.hierarchyPath, e]));

		const walkLinks = (node: LoadedSchematicNode) => {
			const parent = indexByPath.get(node.hierarchyPath);
			if (!parent) {
				return;
			}
			for (const child of node.children) {
				const childExtract = indexByPath.get(child.hierarchyPath);
				if (!childExtract) {
					continue;
				}
				for (const [pinName, parentIsland] of parent.sheetPinToIsland) {
					const childIsland = childExtract.hierLabelToIsland.get(pinName);
					if (childIsland) {
						links.push({ parentIsland, childIsland, pinName });
					}
				}
				walkLinks(child);
			}
		};
		walkLinks(tree);

		return this.finalizeFromExtracts(extracts, {
			hierarchical: true,
			missingChildren: false,
			crossSheetLinks: links
		});
	}

	protected extractSheet(
		model: Schematic,
		opts: { hierarchyPath: string; sheetName: string; file: string }
	): SheetExtract {
		const screen = model.allScreens()[0];
		const items = screen?.items ?? [];
		const placed = items.filter((i): i is SchematicSymbol => i instanceof SchematicSymbol);
		const wires = items.filter((i): i is SchWire => i instanceof SchWire);
		const junctions = items.filter((i): i is SchJunction => i instanceof SchJunction);
		const noConnects = items.filter((i): i is SchNoConnect => i instanceof SchNoConnect);
		const globals = items.filter((i): i is SchGlobalLabel => i instanceof SchGlobalLabel);
		const hiers = items.filter((i): i is SchHierLabel => i instanceof SchHierLabel);
		const locals = items.filter((i): i is SchLabel => i instanceof SchLabel);
		const sheets = items.filter((i): i is SchematicSheet => i instanceof SchematicSheet);

		let sheetPinCount = 0;
		const childSheetNames: string[] = [];
		const sheetPinItems: SchematicSheetPin[] = [];
		for (const sheet of sheets) {
			const sheetName = sheet.getName().trim();
			if (sheetName) {
				childSheetNames.push(sheetName);
			}
			for (const pin of sheet.pins) {
				if (!pin.getText().trim()) {
					continue;
				}
				sheetPinCount++;
				sheetPinItems.push(pin);
			}
		}

		const components: ConnectivityComponent[] = [];
		const refPrefix = opts.hierarchyPath ? `${ opts.hierarchyPath }/` : '';
		/** Per-item pin metadata, since the real connectivity engine's items
		 *  are the actual placed `SchPin` objects, not geometric tags. */
		const pinMeta = new Map<SchPin, { ref: string; number: string; name: string; type: string; isPowerSymbol: boolean; isPwrFlag: boolean; powerNetName?: string }>();
		const graphPins: SchPin[] = [];

		for (const instance of placed) {
			const libId = instance.getLibId() ?? '';
			const rawRef = instance.getReference() ?? '';
			const value = instance.getProperties().find(f => f.getName() === 'Value')?.getText() ?? '';
			if (!rawRef) {
				continue;
			}

			const isPwrFlag = isPwrFlagSymbol(libId, value, rawRef);
			const isPower = isPwrFlag
				|| rawRef.startsWith('#PWR')
				|| rawRef.startsWith('#FLG')
				|| libId.startsWith('power:');
			// Power / flag refs stay unprefixed (global by nature); real parts get path prefix.
			const ref = isPower || !refPrefix ? rawRef : `${ refPrefix }${ rawRef }`;
			const placedUnit = instance.getUnitId() || 1;
			const pinSummaries: ConnectivityPinSummary[] = [];

			// A derived symbol (`derivedFrom`, e.g. AMS1117-3.3 extending a
			// shared AMS1117 base) has no pins of its own in the library —
			// `instance.pins` (`SchematicSymbol.updatePins()`) is therefore
			// empty too, since it only ever copies `instance.libSymbol.pins`
			// with no derivedFrom fallback. Synthesize instance-owned pin
			// copies from the resolved base here (parented to `instance`, not
			// the base LibSymbol, so `ConnectionGraphBuilder`'s
			// `pinWorldPosition()` transforms them by this placement).
			let instancePins = instance.pins;
			if (instancePins.length === 0 && instance.libSymbol?.isDerived() && instance.libSymbol.derivedFrom) {
				const base = model.getLibSymbol(instance.libSymbol.derivedFrom);
				instancePins = (base?.pins ?? []).map(libPin => {
					const p = new SchPin(instance, libPin.uuid);
					p.name = libPin.name;
					p.number = libPin.number;
					p.electricalType = libPin.electricalType;
					p.hidden = libPin.hidden;
					p.unit = libPin.unit;
					p.setPosition(libPin.getPos());
					return p;
				});
			}

			// Placed, per-instance pins — the same objects the real
			// connectivity engine's adjacency graph matches by world point
			// (`ConnectionGraphBuilder`'s `pinWorldPosition()` transforms
			// them by this instance's own placement, so no manual transform
			// is needed here the way the old geometric snap required).
			for (const pin of instancePins) {
				if (pin.unit !== 0 && pin.unit !== placedUnit) {
					continue;
				}
				// Invisible POWER pins (e.g. the pin inside a power:GND / +3.3V
				// symbol) are still electrically connected in KiCad — skipping
				// them fragments ground/rail nets and loses the "GND" name.
				// Regular component hidden pins keep the original skip.
				if (pin.isHidden() && !isPower) {
					continue;
				}
				const name = pin.name;
				const number = pin.number;
				const electricalType = pin.getTypeString();
				graphPins.push(pin);
				// PWR_FLAG attaches to whichever net it sits on for ERC — it must
				// NOT contribute a mergeable power net name (Value is always
				// "PWR_FLAG", which would short every flagged net together).
				pinMeta.set(pin, {
					ref, number, name, type: electricalType,
					isPowerSymbol: isPower,
					isPwrFlag,
					powerNetName: isPower && !isPwrFlag ? value : undefined
				});
				pinSummaries.push({ number, name, type: electricalType });
			}

			components.push({
				ref,
				value,
				libId,
				pins: pinSummaries,
				isPower: isPower || undefined,
				dnp: instance.isDnp() || undefined,
				sheetPath: opts.hierarchyPath || undefined
			});
		}

		// Real KiCad-priority connectivity: exact-point adjacency graph +
		// flood-fill into subgraphs (`ConnectionGraphBuilder`), then
		// real driver-priority resolution + same-name merge
		// (`ConnectionGraph`'s `buildSheetConnectionGraph`) — replaces the
		// ±0.05mm geometric-snap union-find this method used to run.
		const graphItems: GraphItem[] = [
			...wires, ...junctions, ...noConnects, ...globals, ...hiers, ...locals, ...sheetPinItems, ...graphPins
		];
		const sheetPath = new SchematicSheetPath();
		const { subgraphs } = buildSheetConnectionGraph(graphItems, sheetPath, busAliasResolverFor(model));

		const islands: SheetIsland[] = [];
		const hierLabelToIsland = new Map<string, string>();
		const sheetPinToIsland = new Map<string, string>();
		let islandSeq = 0;

		for (const subgraph of subgraphs) {
			const island = islandFromSubgraph(subgraph, pinMeta, `${ opts.hierarchyPath || '/' }#${ islandSeq++ }`);
			islands.push(island);

			for (const hn of island.hierNames) {
				if (!hierLabelToIsland.has(hn)) {
					hierLabelToIsland.set(hn, island.id);
				}
			}
			for (const sp of island.sheetPinNames) {
				if (!sheetPinToIsland.has(sp)) {
					sheetPinToIsland.set(sp, island.id);
				}
			}
		}

		return {
			hierarchyPath: opts.hierarchyPath,
			sheetName: opts.sheetName,
			file: opts.file,
			components,
			islands,
			hierLabelToIsland,
			sheetPinToIsland,
			sheetPinCount,
			childSheetNames
		};
	}

	protected finalizeFromExtracts(
		extracts: SheetExtract[],
		opts: {
			hierarchical: boolean;
			missingChildren: boolean;
			crossSheetLinks?: Array<{ parentIsland: string; childIsland: string; pinName: string }>;
		}
	): SchematicConnectivitySummary {
		const limits: string[] = [
			'Buses / bus entries / bus aliases are not expanded.',
			'Pin connection uses geometric snap (±0.05 mm) of wire endpoints and mid-segment hits to pin outer ends / labels.',
			'Same-name local and hierarchical labels are merged within each sheet (KiCad net-by-name).',
			'Power symbols (power:GND, power:+3V3, …) merge globally by identical Value / net name only.',
			'PWR_FLAG is a passive ERC marker on its attached net only — it never unions differently named power nets.',
			'Named islands with zero component pins are kept as labelOnly for debugging; they are not treated as connected nets.'
		];

		if (opts.hierarchical) {
			limits.push(
				'Hierarchical netlist: child sheets loaded from Sheetfile; parent sheet pins linked to child hierarchical labels by name.'
			);
			limits.push(
				'Component refs on child sheets are path-prefixed (e.g. IMU/R1). Power/flag symbols stay unprefixed.'
			);
			limits.push(
				'Symbol instance path maps (instances / sheet_instances) are not used for ref resolution — file Reference + sheet path only.'
			);
			limits.push(
				'If the same Sheetfile is placed more than once, each instance gets its own path prefix; cyclic Sheetfile references are skipped.'
			);
		}
		else {
			limits.push('Single schematic blob — child hierarchical sheets are not loaded unless a project/path tree is provided.');
			if (opts.missingChildren) {
				const names = extracts[0]?.childSheetNames ?? [];
				limits.push(
					`Found sheet instance(s) [${ names.join(', ') || '…' }] but child Sheetfile contents were not loaded (paste mode). `
						+ 'Pin membership for nets that leave the root sheet (e.g. connector pins on a child sheet) will look empty/label-only. '
						+ 'Use projectId or schematicPath so the sheet tree is loaded from disk.'
				);
			}
		}

		const islandById = new Map<string, SheetIsland>();
		for (const ex of extracts) {
			for (const island of ex.islands) {
				islandById.set(island.id, island);
			}
		}

		const uf = new UnionFindString();
		for (const id of islandById.keys()) {
			uf.add(id);
		}

		// Within each sheet: merge islands that share local or hierarchical label
		// names (KiCad connects same-name labels on one sheet without a continuous wire).
		for (const ex of extracts) {
			const byLocal = new Map<string, string[]>();
			const byHier = new Map<string, string[]>();
			for (const island of ex.islands) {
				for (const n of island.localNames) {
					const list = byLocal.get(n) ?? [];
					list.push(island.id);
					byLocal.set(n, list);
				}
				for (const n of island.hierNames) {
					const list = byHier.get(n) ?? [];
					list.push(island.id);
					byHier.set(n, list);
				}
			}
			for (const ids of byLocal.values()) {
				for (let i = 1; i < ids.length; i++) {
					uf.union(ids[0]!, ids[i]!);
				}
			}
			for (const ids of byHier.values()) {
				for (let i = 1; i < ids.length; i++) {
					uf.union(ids[0]!, ids[i]!);
				}
			}
		}

		// Cross-sheet: parent sheet pin ↔ child hierarchical label (same name)
		for (const link of opts.crossSheetLinks ?? []) {
			if (islandById.has(link.parentIsland) && islandById.has(link.childIsland)) {
				uf.union(link.parentIsland, link.childIsland);
			}
		}

		// Project-wide: merge by global label name and identical power net name
		// (GND↔GND, +3V3↔+3V3). Never merge on "PWR_FLAG".
		const byGlobal = new Map<string, string[]>();
		const byPower = new Map<string, string[]>();
		for (const island of islandById.values()) {
			for (const g of island.globalNames) {
				const list = byGlobal.get(g) ?? [];
				list.push(island.id);
				byGlobal.set(g, list);
			}
			for (const p of island.powerNames) {
				if (isPwrFlagNetName(p)) {
					continue;
				}
				const list = byPower.get(p) ?? [];
				list.push(island.id);
				byPower.set(p, list);
			}
			if (
				island.isPower
				&& looksLikePowerNetName(island.nameHint)
				&& !isPwrFlagNetName(island.nameHint)
			) {
				const list = byPower.get(island.nameHint) ?? [];
				list.push(island.id);
				byPower.set(island.nameHint, list);
			}
		}
		for (const ids of byGlobal.values()) {
			for (let i = 1; i < ids.length; i++) {
				uf.union(ids[0]!, ids[i]!);
			}
		}
		for (const ids of byPower.values()) {
			for (let i = 1; i < ids.length; i++) {
				uf.union(ids[0]!, ids[i]!);
			}
		}

		const groups = new Map<string, SheetIsland[]>();
		for (const id of islandById.keys()) {
			const root = uf.find(id);
			const list = groups.get(root) ?? [];
			list.push(islandById.get(id)!);
			groups.set(root, list);
		}

		const components = extracts.flatMap(e => e.components);
		const nets: ConnectivityNet[] = [];
		const powerNetSet = new Set<string>();
		const pinToNet = new Map<string, string>();
		const ncPinKeys = new Set<string>();
		let anonCounter = 1;

		for (const group of groups.values()) {
			const pinKeys = [...new Set(group.flatMap(g => g.pinKeys))];
			const powerPinKeys = [...new Set(group.flatMap(g => g.powerPinKeys))];
			const labelNames = [...new Set(group.flatMap(g => g.labelNames))];
			const globalNames = [...new Set(group.flatMap(g => g.globalNames))];
			const hierNames = [...new Set(group.flatMap(g => g.hierNames))];
			const localNames = [...new Set(group.flatMap(g => g.localNames))];
			const powerNames = [...new Set(group.flatMap(g => g.powerNames).filter(n => !isPwrFlagNetName(n)))];
			const hasNc = group.some(g => g.hasNc);
			const hasPwrFlag = group.some(g => g.hasPwrFlag);
			let isPower = group.some(g => g.isPower) || powerNames.length > 0;

			let name = '';
			if (globalNames.length > 0) {
				name = globalNames[0]!;
			}
			else if (powerNames.length > 0) {
				name = powerNames[0]!;
				isPower = true;
			}
			else if (hierNames.length > 0) {
				name = hierNames[0]!;
			}
			else if (localNames.length > 0) {
				name = localNames[0]!;
			}
			else if (group[0]?.nameHint && !isPwrFlagNetName(group[0].nameHint)) {
				name = group[0].nameHint;
			}
			else if (pinKeys.length > 0) {
				name = `Net-(${ pinKeys[0] })`;
			}
			else {
				name = `Net-anon-${ anonCounter++ }`;
			}

			// Named power rails (and PWR_FLAG-marked nets) are power for ERC heuristics.
			// Only identical rail names go into powerNets / cross-sheet merge keys.
			if (powerNames.length > 0 || looksLikePowerNetName(name)) {
				isPower = true;
				powerNetSet.add(name);
			}
			else if (hasPwrFlag) {
				isPower = true;
			}

			for (const key of pinKeys) {
				pinToNet.set(key, name);
			}
			for (const key of powerPinKeys) {
				pinToNet.set(key, name);
			}
			if (hasNc) {
				for (const key of pinKeys) {
					ncPinKeys.add(key);
				}
			}

			const labelOnly = pinKeys.length === 0;
			nets.push({
				name,
				pins: pinKeys,
				power: isPower || undefined,
				labels: labelNames.length ? labelNames : undefined,
				labelOnly: labelOnly || undefined
			});
		}

		for (const comp of components) {
			for (const pin of comp.pins) {
				const key = `${ comp.ref }.${ pin.number }`;
				const net = pinToNet.get(key);
				if (net) {
					pin.net = net;
				}
			}
		}

		const heuristics = buildHeuristics(components, nets, ncPinKeys, {
			missingChildren: opts.missingChildren
		});
		const sheetPinsNoted = extracts.reduce((sum, e) => sum + e.sheetPinCount, 0);

		components.sort((a, b) => {
			const ap = a.isPower ? 1 : 0;
			const bp = b.isPower ? 1 : 0;
			if (ap !== bp) {
				return ap - bp;
			}
			return a.ref.localeCompare(b.ref, undefined, { numeric: true });
		});
		nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

		const sheets: ConnectivitySheetInfo[] | undefined = opts.hierarchical
			? extracts.map(e => ({
				path: e.hierarchyPath,
				name: e.sheetName,
				file: e.file
			}))
			: undefined;

		return {
			componentCount: components.filter(c => !c.isPower).length,
			netCount: nets.length,
			components,
			nets,
			powerNets: [...powerNetSet].sort(),
			heuristics,
			limits,
			sheetPinsNoted,
			sheets
		};
	}
}

/** Aggregate one `ConnectionSubgraph`'s items into the geometric-era
 *  `SheetIsland` shape `finalizeFromExtracts()` already knows how to merge
 *  (by label name) and report on — the adapter between the real
 *  driver-priority connectivity engine and this file's existing
 *  cross-sheet/global merge + heuristics pipeline. */
function islandFromSubgraph(
	subgraph: ConnectionSubgraph,
	pinMeta: Map<SchPin, { ref: string; number: string; name: string; type: string; isPowerSymbol: boolean; isPwrFlag: boolean; powerNetName?: string }>,
	islandId: string
): SheetIsland {
	const globalNames: string[] = [];
	const hierNames: string[] = [];
	const localNames: string[] = [];
	const sheetPinNames: string[] = [];
	const powerNames: string[] = [];
	const pinKeys: string[] = [];
	const powerPinKeys: string[] = [];
	let hasPwrFlag = false;

	for (const item of subgraph.items) {
		if (item instanceof SchPin) {
			const meta = pinMeta.get(item);
			if (!meta) {
				continue;
			}
			const key = `${ meta.ref }.${ meta.number }`;
			if (meta.isPowerSymbol) {
				powerPinKeys.push(key);
				if (meta.powerNetName && !isPwrFlagNetName(meta.powerNetName)) {
					powerNames.push(meta.powerNetName);
				}
			}
			else {
				pinKeys.push(key);
			}
			if (meta.isPwrFlag) {
				hasPwrFlag = true;
			}
		}
		else if (item instanceof SchGlobalLabel) {
			globalNames.push(item.getName());
		}
		else if (item instanceof SchHierLabel) {
			hierNames.push(item.getName());
		}
		else if (item instanceof SchLabel) {
			const n = item.getName().trim();
			if (n) {
				localNames.push(n);
			}
		}
		else if (item instanceof SchematicSheetPin) {
			const n = item.getText().trim();
			if (n) {
				sheetPinNames.push(n);
			}
		}
	}

	// `getNetName()` is the real KiCad-priority-resolved name (pin < sheet-pin
	// < hier-label < local-label < power-pin < global — see
	// `ConnectionSubgraph.resolveDrivers()`), a strictly more correct
	// ordering than this file's old geometric-era name-hint priority list.
	let nameHint = subgraph.getNetName();
	if (!nameHint) {
		const firstKey = pinKeys[0] ?? powerPinKeys[0];
		nameHint = firstKey ? `Net-(${ firstKey })` : 'Net-anon';
	}

	let isPower = powerNames.length > 0;
	if (looksLikePowerNetName(nameHint)) {
		isPower = true;
	}
	if (hasPwrFlag) {
		isPower = true;
	}

	const uniq = (arr: string[]) => [...new Set(arr)];

	return {
		id: islandId,
		nameHint,
		isPower,
		pinKeys: uniq(pinKeys),
		powerPinKeys: uniq(powerPinKeys),
		labelNames: uniq([...globalNames, ...localNames, ...hierNames, ...powerNames, ...sheetPinNames]),
		globalNames: uniq(globalNames),
		hierNames: uniq(hierNames),
		localNames: uniq(localNames),
		sheetPinNames: uniq(sheetPinNames),
		powerNames: uniq(powerNames),
		hasPwrFlag,
		hasNc: subgraph.noConnect !== null
	};
}

export class SchematicConnectivityError extends Error {
	constructor(message: string, readonly statusCode: 400 | 502 = 400) {
		super(message);
		this.name = 'SchematicConnectivityError';
	}
}

function basenameOf(filePath: string): string {
	const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
	return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

function looksLikePowerNetName(name: string): boolean {
	return /^(GND|AGND|DGND|VSS|VDD|VCC|VBAT|\+?\d+(\.\d+)?V|-\d+(\.\d+)?V)$/i.test(name.trim());
}

/** KiCad PWR_FLAG — ERC marker only; Value is always "PWR_FLAG" and must not merge nets. */
function isPwrFlagNetName(name: string): boolean {
	return name.trim().toUpperCase() === 'PWR_FLAG';
}

function isPwrFlagSymbol(libId: string, value: string, rawRef: string): boolean {
	if (rawRef.startsWith('#FLG')) {
		return true;
	}
	if (isPwrFlagNetName(value)) {
		return true;
	}
	const id = libId.trim();
	return id === 'power:PWR_FLAG' || id.endsWith(':PWR_FLAG');
}

function buildHeuristics(
	components: ConnectivityComponent[],
	nets: ConnectivityNet[],
	ncPinKeys: Set<string>,
	opts?: { missingChildren?: boolean }
): ConnectivityHeuristic[] {
	const out: ConnectivityHeuristic[] = [];
	const netByName = new Map(nets.map(n => [n.name, n]));

	for (const comp of components) {
		if (comp.isPower || comp.dnp) {
			continue;
		}
		for (const pin of comp.pins) {
			const key = `${ comp.ref }.${ pin.number }`;
			if (pin.type === 'no_connect' || ncPinKeys.has(key)) {
				continue;
			}
			if (!pin.net) {
				out.push({
					severity: pin.type === 'input' || pin.type === 'power_in' ? 'warning' : 'info',
					category: 'unconnected_pin',
					refs: [comp.ref],
					message: `${ comp.ref } pin ${ pin.number } (${ pin.name || pin.type }) appears unconnected.`
				});
			}
		}
	}

	for (const net of nets) {
		if (net.labelOnly || net.pins.length === 0) {
			const hasNamedLabel = (net.labels?.length ?? 0) > 0
				|| (!net.name.startsWith('Net-') && !net.name.startsWith('Net-anon-'));
			if (hasNamedLabel) {
				const hierarchyHint = opts?.missingChildren
					? ' Child Sheetfile sheets were not loaded (paste/root-only mode) — '
						+ 'pins on hierarchical child sheets will be missing until you validate via project path.'
					: '';
				out.push({
					severity: opts?.missingChildren ? 'warning' : 'info',
					category: 'label_only_net',
					net: net.name,
					message: `Net "${ net.name }" has a name/label but zero component pins `
						+ `(label-only island or pins failed to snap to wires). Labels: `
						+ `${ (net.labels ?? [net.name]).join(', ') }.`
						+ hierarchyHint
				});
			}
			continue;
		}

		const pinMetas: ConnectivityPinSummary[] = [];
		for (const key of net.pins) {
			const dot = key.lastIndexOf('.');
			if (dot < 0) {
				continue;
			}
			const ref = key.slice(0, dot);
			const number = key.slice(dot + 1);
			const comp = components.find(c => c.ref === ref);
			const pin = comp?.pins.find(p => p.number === number);
			if (pin) {
				pinMetas.push(pin);
			}
		}

		const drivers = pinMetas.filter(p =>
			p.type === 'output'
			|| p.type === 'bidirectional'
			|| p.type === 'power_out'
			|| p.type === 'open_collector'
			|| p.type === 'open_emitter'
			|| p.type === 'passive'
			|| p.type === 'tri_state'
		);
		const inputs = pinMetas.filter(p => p.type === 'input' || p.type === 'power_in');
		const onlyPowerSymbols = net.pins.every(key => {
			const ref = key.slice(0, key.lastIndexOf('.'));
			return components.find(c => c.ref === ref)?.isPower;
		});

		if (inputs.length > 0 && drivers.length === 0 && !net.power && !onlyPowerSymbols) {
			out.push({
				severity: 'warning',
				category: 'floating_input',
				net: net.name,
				refs: [...new Set(net.pins.map(k => k.slice(0, k.lastIndexOf('.'))))],
				message: `Net "${ net.name }" has input pin(s) but no obvious driver (output / bidirectional / power_out / passive).`
			});
		}

		const powerIns = pinMetas.filter(p => p.type === 'power_in');
		if (powerIns.length > 0 && !net.power && drivers.filter(p => p.type === 'power_out').length === 0) {
			const named = netByName.get(net.name);
			if (!named?.power && !looksLikePowerNetName(net.name)) {
				out.push({
					severity: 'warning',
					category: 'power_pin',
					net: net.name,
					message: `Net "${ net.name }" connects power_in pin(s) but is not identified as a power net.`
				});
			}
		}
	}

	return out;
}

class UnionFindString {
	private parent = new Map<string, string>();

	add(id: string): void {
		if (!this.parent.has(id)) {
			this.parent.set(id, id);
		}
	}

	find(id: string): string {
		let root = id;
		while (this.parent.get(root) !== root) {
			root = this.parent.get(root)!;
		}
		let cur = id;
		while (cur !== root) {
			const next = this.parent.get(cur)!;
			this.parent.set(cur, root);
			cur = next;
		}
		return root;
	}

	union(a: string, b: string): void {
		this.add(a);
		this.add(b);
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) {
			this.parent.set(rb, ra);
		}
	}
}
