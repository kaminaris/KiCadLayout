/**
 * Text-level strip/insert of top-level connectivity forms inside a `.kicad_sch`
 * document. Two granularities:
 *   - {@link stripSchematicWiresAndJunctions} — wires + junctions only.
 *   - {@link stripConnectivityGraphics} — wires + junctions + net labels +
 *     auto power-port symbols (#PWR…), for a full connectivity regenerate.
 * Both keep components, lib_symbols, sheets, no-connects, hierarchical labels,
 * text, etc.
 */

const WIRE_FORMS = new Set(['wire', 'junction']);
/**
 * Forms strippable by name alone (no content inspection). Only LOCAL `label`s
 * are regenerated — `global_label` / `hierarchical_label` are real, user-placed
 * net terminals (like components) and are preserved.
 */
const NAME_ONLY_CONNECTIVITY = new Set(['wire', 'junction', 'label']);

/**
 * Remove every top-level form (direct child of `(kicad_sch …)`) for which
 * `shouldStrip(name, sexprText)` returns true. Nested forms (e.g. the `symbol`
 * bodies inside `lib_symbols`) are never touched — only depth-1 children.
 */
function stripTopLevelForms(
	schematicText: string,
	shouldStrip: (name: string, sexpr: string) => boolean
): string {
	const text = schematicText;
	const open = text.indexOf('(kicad_sch');
	if (open < 0) {
		return text;
	}

	const out: string[] = [];
	out.push(text.slice(0, open));

	let i = open;
	let depth = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"') {
			const end = skipString(text, i);
			out.push(text.slice(i, end));
			i = end;
			continue;
		}
		if (ch === '(') {
			if (depth === 1) {
				const name = peekFormName(text, i + 1);
				if (name) {
					const end = skipSexpr(text, i);
					if (shouldStrip(name, text.slice(i, end))) {
						i = end;
						while (i < text.length && /\s/.test(text[i]!)) {
							i++;
						}
						continue;
					}
				}
			}
			depth++;
			out.push(ch);
			i++;
			continue;
		}
		if (ch === ')') {
			depth--;
			out.push(ch);
			i++;
			continue;
		}
		out.push(ch);
		i++;
	}
	return out.join('');
}

/**
 * Remove every top-level `(wire …)` and `(junction …)` under `(kicad_sch …)`.
 */
export function stripSchematicWiresAndJunctions(schematicText: string): string {
	return stripTopLevelForms(schematicText, name => WIRE_FORMS.has(name));
}

/**
 * Remove every top-level connectivity graphic: wires, junctions, net labels
 * (`label` / `global_label`), and auto power-port symbols (`#PWR…`). Used by
 * the rewire path to fully regenerate connectivity from the locked netlist so
 * grounds/labels follow their component instead of stranding.
 */
export function stripConnectivityGraphics(schematicText: string): string {
	return stripTopLevelForms(schematicText, (name, sexpr) => {
		if (NAME_ONLY_CONNECTIVITY.has(name)) {
			return true;
		}
		if (name === 'symbol') {
			return isRegeneratedGndSymbol(sexpr);
		}
		return false;
	});
}

/**
 * True for ground-glyph power symbols (`power:GND`, `power:GNDA`, `power:GNDPWR`,
 * …) — those are regenerated per-pin (KiCad convention, grounds follow their
 * component). Every OTHER power symbol (rails like +3.3V / +5V, PWR_FLAG) is a
 * real, user-placed terminal and is preserved, like a component or global label.
 */
function isRegeneratedGndSymbol(symbolSexpr: string): boolean {
	return /\(lib_id\s+"power:GND/.test(symbolSexpr);
}

/**
 * Replace all top-level wires/junctions with `wireBlock` (already sexpr text).
 * Empty `wireBlock` clears connectivity graphics only.
 */
export function replaceSchematicWires(
	schematicText: string,
	wireBlock: string
): string {
	return insertBeforeRootClose(stripSchematicWiresAndJunctions(schematicText), wireBlock);
}

/**
 * Replace ALL connectivity graphics (wires, junctions, labels, power symbols)
 * with a freshly generated `block`. The single entry point for the rewire path.
 */
export function replaceConnectivityGraphics(
	schematicText: string,
	block: string
): string {
	return insertBeforeRootClose(stripConnectivityGraphics(schematicText), block);
}

/**
 * Insert `block` immediately before the root `(kicad_sch …)` closing paren —
 * never via `lastIndexOf('(embedded_fonts')`, which can match nested lib_symbol
 * forms and bury content inside `lib_symbols` (invisible after parse).
 */
function insertBeforeRootClose(stripped: string, block: string): string {
	const insert = block.trim();
	if (!insert) {
		return stripped;
	}
	const close = findRootKicadSchClose(stripped);
	if (close < 0) {
		return `${stripped}\n${insert}\n`;
	}
	return `${stripped.slice(0, close).trimEnd()}\n\n${insert}\n${stripped.slice(close)}`;
}

/** Index of the `)` that closes the root `(kicad_sch …)` form. */
function findRootKicadSchClose(text: string): number {
	const open = text.indexOf('(kicad_sch');
	if (open < 0) {
		return -1;
	}
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '"') {
			i = skipString(text, i) - 1;
			continue;
		}
		if (ch === '(') {
			depth++;
		}
		else if (ch === ')') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

function peekFormName(text: string, start: number): string | null {
	let i = start;
	while (i < text.length && /\s/.test(text[i]!)) {
		i++;
	}
	const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
	return m ? m[0]! : null;
}

/** Skip one sexpr starting at `(`; returns index just after the matching `)`. */
function skipSexpr(text: string, openParen: number): number {
	let depth = 0;
	for (let i = openParen; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '"') {
			i = skipString(text, i) - 1;
			continue;
		}
		if (ch === '(') {
			depth++;
		}
		else if (ch === ')') {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return text.length;
}

/** `i` points at opening `"`; returns index just after the closing `"`. */
function skipString(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length) {
		if (text[j] === '\\') {
			j += 2;
			continue;
		}
		if (text[j] === '"') {
			return j + 1;
		}
		j++;
	}
	return text.length;
}
