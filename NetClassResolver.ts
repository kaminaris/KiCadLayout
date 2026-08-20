/**
 * Net-class resolution for the interactive router — matches a net name
 * against the project's `.kicad_pro` `net_settings` (direct assignments,
 * then wildcard patterns, then the Default class), the same precedence
 * real KiCad's implicit netclass rules use (DRC_ENGINE::loadImplicitRules()
 * synthesizes one rule per net class from these same fields before any
 * `.kicad_dru` custom rule is layered on top — that override layer is out
 * of scope here; this module only resolves the netclass-implicit baseline).
 *
 * Field names mirror apps/kicad-viewer/src/project-setup/
 * ProjectSettingsDraft.ts's NetClassRecord/NetClassPattern exactly (that
 * file owns the Project Setup "Net Classes" UI's draft model) so a project
 * saved via that UI round-trips through here without any field mapping.
 */

export interface NetClassRecord extends Record<string, unknown> {
	name: string;
	priority?: number;
	clearance?: number;
	track_width?: number;
	via_diameter?: number;
	via_drill?: number;
	microvia_diameter?: number;
	microvia_drill?: number;
	diff_pair_width?: number;
	diff_pair_gap?: number;
	diff_pair_via_gap?: number;
}

export interface NetClassPattern extends Record<string, unknown> {
	pattern: string;
	netclass: string;
}

export interface NetClassRules {
	classes: NetClassRecord[];
	patterns: NetClassPattern[];
	/** net name -> net class name(s); first entry wins when more than one. */
	assignments: Record<string, string[]>;
}

/** Real KiCad's own stock defaults (board_design_settings.cpp) — used as
 *  the fallback "Default" class when a project has none at all (shouldn't
 *  normally happen; every real project has exactly one Default class, but
 *  a synthetic/partial board loaded outside the full project flow might). */
export const DEFAULT_NET_CLASS: NetClassRecord = {
	name: 'Default',
	priority: 2147483647,
	clearance: 0.2,
	track_width: 0.25,
	via_diameter: 0.8,
	via_drill: 0.4,
	microvia_diameter: 0.3,
	microvia_drill: 0.1,
	diff_pair_width: 0.2,
	diff_pair_gap: 0.25,
	diff_pair_via_gap: 0.25,
};

/** KiCad netclass patterns use simple shell-style wildcards (`*`, `?`), not
 *  full regex — confirmed against real project files and panel_setup_
 *  netclasses.cpp's own pattern matching (wxString::Matches, glob-style). */
function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp(`^${ escaped }$`);
}

const patternRegexCache = new Map<string, RegExp>();
function cachedGlobToRegExp(glob: string): RegExp {
	let re = patternRegexCache.get(glob);
	if (!re) {
		re = globToRegExp(glob);
		patternRegexCache.set(glob, re);
	}
	return re;
}

/**
 * Resolves the effective net class for a net name: direct
 * netclass_assignments entries first, then the first-matching
 * netclass_patterns wildcard (by real KiCad's own "which class does this
 * net belong to" precedence, both compete on the class's own `priority`
 * field — LOWER priority number wins; see ProjectSettingsDraft.addNetClass,
 * which hands out 0, 1, 2... to user-created classes while the mandatory
 * Default class is pinned at INT_MAX so it only wins as the last resort),
 * falling back to the Default class when nothing matches.
 */
export function resolveNetClass(netName: string, rules: NetClassRules): NetClassRecord {
	const byName = new Map(rules.classes.map(c => [c.name, c]));
	const defaultClass = byName.get('Default') ?? DEFAULT_NET_CLASS;
	if (!netName) {
		return defaultClass;
	}

	let best: NetClassRecord | null = null;
	const consider = (className: string) => {
		const cls = byName.get(className);
		if (!cls) {
			return;
		}
		if (!best || (cls.priority ?? 0) < (best.priority ?? 0)) {
			best = cls;
		}
	};

	for (const className of rules.assignments[netName] ?? []) {
		consider(className);
	}
	for (const pattern of rules.patterns) {
		if (cachedGlobToRegExp(pattern.pattern).test(netName)) {
			consider(pattern.netclass);
		}
	}

	return best ?? defaultClass;
}

/** Copper-to-copper clearance between two (possibly differently-named)
 *  nets — real KiCad's netclass-implicit rule takes the LARGER of the two
 *  nets' own class clearances (a rule only constrains once both sides are
 *  known, and the stricter of the two always applies). Same net never
 *  needs a clearance check (a track/pad never collides with itself). */
export function resolveClearanceMm(netAName: string, netBName: string, rules: NetClassRules): number {
	const a = resolveNetClass(netAName, rules);
	const b = resolveNetClass(netBName, rules);
	const clearanceA = a.clearance ?? DEFAULT_NET_CLASS.clearance!;
	const clearanceB = b.clearance ?? DEFAULT_NET_CLASS.clearance!;
	return Math.max(clearanceA, clearanceB);
}

/** Builds NetClassRules from a `.kicad_pro`'s raw parsed JSON
 *  (KicadProjectFile.raw) — the same `net_settings` shape
 *  ProjectSettingsDraft.ts reads/writes for the Project Setup UI. */
export function buildNetClassRules(projectRaw: Record<string, unknown> | null | undefined): NetClassRules {
	const settings = projectRaw && typeof projectRaw === 'object'
		? (projectRaw as { net_settings?: unknown }).net_settings
		: null;
	const settingsRecord = settings && typeof settings === 'object' ? settings as Record<string, unknown> : null;

	const classes = Array.isArray(settingsRecord?.classes)
		? settingsRecord.classes as NetClassRecord[]
		: [{ ...DEFAULT_NET_CLASS }];

	const patterns = Array.isArray(settingsRecord?.netclass_patterns)
		? settingsRecord.netclass_patterns as NetClassPattern[]
		: [];

	const assignments: Record<string, string[]> = {};
	const assignmentsRaw = settingsRecord?.netclass_assignments;
	if (assignmentsRaw && typeof assignmentsRaw === 'object') {
		for (const [net, value] of Object.entries(assignmentsRaw as Record<string, unknown>)) {
			assignments[net] = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
		}
	}

	return { classes, patterns, assignments };
}
