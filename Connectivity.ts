import { KicadParser } from '@kicad-io/KicadParser';
import { KicadElement } from '@kicad-io/KicadElement';
import { KicadElementLibSymbols } from '@kicad-io/KicadElementLibSymbols';
import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadElementPin, KicadPinElectricalType } from '@kicad-io/KicadElementPin';
import { KicadElementWire } from '@kicad-io/KicadElementWire';
import { KicadElementJunction } from '@kicad-io/KicadElementJunction';
import { KicadElementNoConnect } from '@kicad-io/KicadElementNoConnect';
import { KicadElementGlobalLabel } from '@kicad-io/KicadElementGlobalLabel';
import { KicadElementHierarchicalLabel } from '@kicad-io/KicadElementHierarchicalLabel';
import { KicadElementSheet } from '@kicad-io/KicadElementSheet';
import { KicadElementAt } from '@kicad-io/KicadElementAt';

export interface ConnectivityPinSummary {
	number: string;
	name: string;
	type: KicadPinElectricalType;
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

type Pt = { x: number; y: number };

type NodeTag =
	| { kind: 'pin'; ref: string; number: string; name: string; type: KicadPinElectricalType; isPowerSymbol: boolean; isPwrFlag?: boolean; powerNetName?: string }
	| { kind: 'global'; name: string }
	| { kind: 'local'; name: string }
	| { kind: 'hier'; name: string }
	| { kind: 'sheet_pin'; name: string }
	| { kind: 'nc' }
	| { kind: 'junction' }
	| { kind: 'wire' };

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

const SNAP_MM = 0.05;

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

		const root = new KicadParser().parse(text);
		const extract = this.extractSheet(root, {
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
			const root = new KicadParser().parse(text);
			const file = basenameOf(node.absolutePath) || node.sheetName;
			extracts.push(this.extractSheet(root, {
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
		root: KicadElement,
		opts: { hierarchyPath: string; sheetName: string; file: string }
	): SheetExtract {
		const libSymbols = root.findFirstChildByClass(KicadElementLibSymbols);
		const placed = root.findChildrenByClass(KicadElementSymbol);
		const wires = root.findChildrenByClass(KicadElementWire);
		const junctions = root.findChildrenByClass(KicadElementJunction);
		const noConnects = root.findChildrenByClass(KicadElementNoConnect);
		const globals = root.findChildrenByClass(KicadElementGlobalLabel);
		const hiers = root.findChildrenByClass(KicadElementHierarchicalLabel);
		const locals = root.findChildrenByName('label');
		const sheets = root.findChildrenByClass(KicadElementSheet);

		const uf = new UnionFind();
		const tagsByNode = new Map<number, NodeTag[]>();
		/** Wire segment endpoints in world space — used to attach mid-wire pins/labels. */
		const wireSegments: Array<{ ax: number; ay: number; bx: number; by: number; aId: number; bId: number }> = [];

		const tagNode = (node: number, tag: NodeTag) => {
			const list = tagsByNode.get(node) ?? [];
			list.push(tag);
			tagsByNode.set(node, list);
		};

		const ensurePoint = (p: Pt): number => {
			const key = snapKey(p.x, p.y);
			return uf.add(key);
		};

		/** Attach a schematic point to any wire segment it lies on (KiCad mid-wire labels/pins). */
		const attachToWires = (p: Pt, nodeId: number) => {
			for (const seg of wireSegments) {
				if (pointOnSegment(p.x, p.y, seg.ax, seg.ay, seg.bx, seg.by, SNAP_MM)) {
					uf.union(nodeId, seg.aId);
					uf.union(nodeId, seg.bId);
				}
			}
		};

		for (const wire of wires) {
			const pts = wire.getPoints();
			if (pts.length < 2) {
				continue;
			}
			let prev = ensurePoint(pts[0]!);
			tagNode(prev, { kind: 'wire' });
			for (let i = 1; i < pts.length; i++) {
				const pt = pts[i]!;
				const next = ensurePoint(pt);
				tagNode(next, { kind: 'wire' });
				uf.union(prev, next);
				const prevPt = pts[i - 1]!;
				wireSegments.push({
					ax: prevPt.x, ay: prevPt.y,
					bx: pt.x, by: pt.y,
					aId: prev, bId: next
				});
				prev = next;
			}
		}

		for (const j of junctions) {
			const o = j.getOrigin();
			const p = { x: o.x, y: o.y };
			const n = ensurePoint(p);
			attachToWires(p, n);
			tagNode(n, { kind: 'junction' });
		}

		for (const nc of noConnects) {
			const o = nc.getOrigin();
			const p = { x: o.x, y: o.y };
			const n = ensurePoint(p);
			attachToWires(p, n);
			tagNode(n, { kind: 'nc' });
		}

		for (const g of globals) {
			const o = g.getOrigin();
			const p = { x: o.x, y: o.y };
			const n = ensurePoint(p);
			attachToWires(p, n);
			tagNode(n, { kind: 'global', name: g.getName() });
		}

		for (const h of hiers) {
			const o = h.getOrigin();
			const p = { x: o.x, y: o.y };
			const n = ensurePoint(p);
			attachToWires(p, n);
			tagNode(n, { kind: 'hier', name: h.getName() });
		}

		for (const label of locals) {
			const name = String(label.attributes?.[0]?.value ?? '').trim();
			if (!name) {
				continue;
			}
			const at = label.findFirstChildByClass(KicadElementAt);
			if (!at) {
				continue;
			}
			const p = { x: at.x, y: at.y };
			const n = ensurePoint(p);
			attachToWires(p, n);
			tagNode(n, { kind: 'local', name });
		}

		let sheetPinCount = 0;
		const childSheetNames: string[] = [];
		for (const sheet of sheets) {
			const props = sheet.getAllProperties?.() ?? {};
			const sheetName = String(props['Sheetname'] ?? '').trim();
			if (sheetName) {
				childSheetNames.push(sheetName);
			}
			// Sheet pins reuse KicadElementPin with name in attributes[0], shape in [1].
			for (const pin of sheet.findChildrenByClass(KicadElementPin)) {
				const pinName = String(pin.attributes?.[0]?.value ?? '').trim();
				if (!pinName) {
					continue;
				}
				sheetPinCount++;
				const o = pin.getOrigin();
				const p = { x: o.x, y: o.y };
				const n = ensurePoint(p);
				attachToWires(p, n);
				tagNode(n, { kind: 'sheet_pin', name: pinName });
			}
		}

		const components: ConnectivityComponent[] = [];
		const refPrefix = opts.hierarchyPath ? `${ opts.hierarchyPath }/` : '';

		for (const instance of placed) {
			const libId = instance.getLibId() ?? '';
			const props = instance.getAllProperties();
			const rawRef = props['Reference'] ?? instance.getReference() ?? '';
			const value = props['Value'] ?? '';
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
			const origin = instance.getOrigin();
			const mirror = readMirror(instance);
			const placedUnit = instance.getUnitId() || 1;
			// (lib_name "X") overrides the lib_symbols lookup key when
			// present — see SchematicPainter.buildSymbolInstance's identical
			// fix for why. Without this, a symbol like this (real files:
			// commonly power:GND placed multiple times, each getting its own
			// "GND_1"/"GND_2" cached copy) resolves no pins at all here,
			// silently dropping it from the connectivity graph entirely.
			const libLookupName = instance.getLibName?.() ?? libId;
			const libDef = libSymbols?.findSymbolByName(libLookupName) ?? null;
			const pinSummaries: ConnectivityPinSummary[] = [];

			if (libDef) {
				for (const sub of relevantSubUnits(libDef, placedUnit, libSymbols)) {
					for (const pin of sub.findChildrenByClass(KicadElementPin)) {
						// Invisible POWER pins (e.g. the pin inside a power:GND / +3.3V
						// symbol) are still electrically connected in KiCad — skipping
						// them fragments ground/rail nets and loses the "GND" name.
						// Regular component hidden pins keep the original skip.
						if (pin.isHidden() && !isPower) {
							continue;
						}
						const { name, number } = pin.getPin();
						const { electricalType } = pin.getType();
						const pinOrigin = pin.getOrigin();
						const world = flippedTransform(
							origin.x,
							origin.y,
							origin.rotation ?? 0,
							mirror,
							pinOrigin.x,
							pinOrigin.y
						);
						const node = ensurePoint(world);
						attachToWires(world, node);
						// PWR_FLAG attaches to whichever net it sits on for ERC — it must
						// NOT contribute a mergeable power net name (Value is always
						// "PWR_FLAG", which would short every flagged net together).
						tagNode(node, {
							kind: 'pin',
							ref,
							number,
							name,
							type: electricalType,
							isPowerSymbol: isPower,
							isPwrFlag: isPwrFlag || undefined,
							powerNetName: isPower && !isPwrFlag ? value : undefined
						});
						pinSummaries.push({ number, name, type: electricalType });
					}
				}
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

		const membersByRoot = new Map<number, number[]>();
		for (const id of uf.allIds()) {
			const rootId = uf.find(id);
			const list = membersByRoot.get(rootId) ?? [];
			list.push(id);
			membersByRoot.set(rootId, list);
		}

		const islands: SheetIsland[] = [];
		const hierLabelToIsland = new Map<string, string>();
		const sheetPinToIsland = new Map<string, string>();
		let anonCounter = 1;
		let islandSeq = 0;

		for (const [, memberIds] of membersByRoot) {
			const tags: NodeTag[] = [];
			for (const id of memberIds) {
				const t = tagsByNode.get(id);
				if (t) {
					tags.push(...t);
				}
			}

			const pinTags = tags.filter((t): t is Extract<NodeTag, { kind: 'pin' }> => t.kind === 'pin');
			const globalNames = tags.filter((t): t is Extract<NodeTag, { kind: 'global' }> => t.kind === 'global').map(t => t.name);
			const localNames = tags.filter((t): t is Extract<NodeTag, { kind: 'local' }> => t.kind === 'local').map(t => t.name);
			const hierNames = tags.filter((t): t is Extract<NodeTag, { kind: 'hier' }> => t.kind === 'hier').map(t => t.name);
			const sheetPinNames = tags.filter((t): t is Extract<NodeTag, { kind: 'sheet_pin' }> => t.kind === 'sheet_pin').map(t => t.name);
			const powerNames = pinTags
				.filter(t => t.isPowerSymbol && t.powerNetName && !isPwrFlagNetName(t.powerNetName))
				.map(t => t.powerNetName!);
			const hasPwrFlag = pinTags.some(t => t.isPwrFlag === true);
			const hasNc = tags.some(t => t.kind === 'nc');

			if (pinTags.length === 0 && globalNames.length === 0 && localNames.length === 0
				&& hierNames.length === 0 && powerNames.length === 0 && sheetPinNames.length === 0) {
				continue;
			}

			let nameHint = '';
			let isPower = false;
			if (globalNames.length > 0) {
				nameHint = globalNames[0]!;
			}
			else if (powerNames.length > 0) {
				nameHint = powerNames[0]!;
				isPower = true;
			}
			else if (hierNames.length > 0) {
				nameHint = hierNames[0]!;
			}
			else if (sheetPinNames.length > 0) {
				nameHint = sheetPinNames[0]!;
			}
			else if (localNames.length > 0) {
				nameHint = localNames[0]!;
			}
			else if (pinTags.length > 0) {
				const p = pinTags[0]!;
				nameHint = `Net-(${ p.ref }-Pad${ p.number })`;
			}
			else {
				nameHint = `Net-anon-${ anonCounter++ }`;
			}

			if (powerNames.length > 0 || looksLikePowerNetName(nameHint)) {
				isPower = true;
			}
			if (hasPwrFlag) {
				isPower = true;
			}

			const islandId = `${ opts.hierarchyPath || '/' }#${ islandSeq++ }`;
			// Report only real-part pins on nets; power/flag pins still participate in
			// geometry + power-name merge via tags, but omit #PWR/#FLG clutter from pin lists.
			const pinKeys = [...new Set(
				pinTags
					.filter(t => !t.isPowerSymbol)
					.map(t => `${ t.ref }.${ t.number }`)
			)];
			const powerPinKeys = [...new Set(
				pinTags
					.filter(t => t.isPowerSymbol)
					.map(t => `${ t.ref }.${ t.number }`)
			)];
			const labelNames = [...new Set([
				...globalNames, ...localNames, ...hierNames, ...powerNames, ...sheetPinNames
			])];

			const island: SheetIsland = {
				id: islandId,
				nameHint,
				isPower,
				pinKeys,
				powerPinKeys,
				labelNames,
				globalNames: [...new Set(globalNames)],
				hierNames: [...new Set(hierNames)],
				localNames: [...new Set(localNames)],
				powerNames: [...new Set(powerNames)],
				hasPwrFlag,
				hasNc
			};
			islands.push(island);

			for (const hn of island.hierNames) {
				if (!hierLabelToIsland.has(hn)) {
					hierLabelToIsland.set(hn, islandId);
				}
			}
			for (const sp of [...new Set(sheetPinNames)]) {
				if (!sheetPinToIsland.has(sp)) {
					sheetPinToIsland.set(sp, islandId);
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

function snapKey(x: number, y: number): string {
	return `${ Math.round(x / SNAP_MM) },${ Math.round(y / SNAP_MM) }`;
}

/** True if (px,py) lies on segment AB within tol (axis-aligned or diagonal). */
function pointOnSegment(
	px: number, py: number,
	ax: number, ay: number,
	bx: number, by: number,
	tol: number
): boolean {
	const minX = Math.min(ax, bx) - tol;
	const maxX = Math.max(ax, bx) + tol;
	const minY = Math.min(ay, by) - tol;
	const maxY = Math.max(ay, by) + tol;
	if (px < minX || px > maxX || py < minY || py > maxY) {
		return false;
	}
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-12) {
		return Math.hypot(px - ax, py - ay) <= tol;
	}
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy) <= tol;
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

/** Was its own hand-rolled attribute/children scan — went stale when
 *  KicadElementMirror got properly registered (KicadElementLiteral's
 *  afterParse() consumes `(mirror y)`'s bareword attribute into `.value`
 *  and clears `.attributes`, so this always returned null afterward,
 *  silently dropping every mirrored symbol's pins out of the connectivity
 *  graph — see [[kicad-viewer-mirror-rotation-order]] for the render-side
 *  history of this exact class of bug). Delegates to
 *  KicadElementSymbol.getMirror(), the one already kept correct for
 *  rendering, instead of maintaining a second implementation. */
function readMirror(instance: KicadElementSymbol): 'x' | 'y' | null {
	return instance.getMirror();
}

/** A derived symbol (`(extends "Base")`, e.g. AMS1117-3.3 extending a
 *  shared AMS1117 base) has no sub-unit children of its own — all pins live
 *  only on the base. Without resolving that chain, the old
 *  `subUnits.length === 0` fallback (`return [libDef]`) returned a symbol
 *  with NO pins at all, so every one of its pads failed net matching (`no
 *  pin N in symbol`) even though the base clearly has them. Mirrors
 *  SchematicPainter.relevantSubUnits's identical fix for the same class of
 *  symbol (there for rendering; here for connectivity) — resolved one level
 *  by name within the SAME lib_symbols block the placed instance's own
 *  libId resolved against. */
function relevantSubUnits(libDef: KicadElementSymbol, placedUnit: number, libSymbols?: { findSymbolByName(name: string): KicadElementSymbol | undefined } | null): KicadElementSymbol[] {
	let graphicsSource = libDef;
	if (libDef.isDerived() && libDef.getLayers().length === 0) {
		const base = libSymbols?.findSymbolByName(libDef.getExtends() ?? '');
		if (base) {
			graphicsSource = base;
		}
	}
	const subUnits = graphicsSource.getLayers();
	if (subUnits.length === 0) {
		return [graphicsSource];
	}
	return subUnits.filter(s => {
		const { unit, deMorgan } = s.deconstructSymbolName();
		return (unit === 0 || unit === placedUnit) && (deMorgan === 0 || deMorgan === 1);
	});
}

/** Library-local → schematic world (Y-flip + mirror + rotate + translate). Matches SchematicPainter. */
function flippedTransform(
	instX: number,
	instY: number,
	rotationDeg: number,
	mirror: 'x' | 'y' | null,
	localX: number,
	localY: number
): Pt {
	let x = localX;
	let y = -localY;
	if (mirror === 'x') {
		y = -y;
	}
	else if (mirror === 'y') {
		x = -x;
	}
	const rad = (rotationDeg * Math.PI) / 180;
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const rx = x * c - y * s;
	const ry = x * s + y * c;
	return { x: rx + instX, y: ry + instY };
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

class UnionFind {
	private parent = new Map<number, number>();
	private keyToId = new Map<string, number>();
	private nextId = 1;

	add(key: string): number {
		const existing = this.keyToId.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const id = this.nextId++;
		this.keyToId.set(key, id);
		this.parent.set(id, id);
		return id;
	}

	find(id: number): number {
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

	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) {
			this.parent.set(rb, ra);
		}
	}

	allIds(): number[] {
		return [...this.parent.keys()];
	}
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
