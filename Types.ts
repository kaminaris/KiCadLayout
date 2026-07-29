/**
 * Shared circuit-layout recipe / placement types (no LM / DB deps).
 */

export type CircuitDesignConfidence = 'high' | 'medium' | 'low';

export type CircuitComponentType =
	| 'capacitor'
	| 'resistor'
	| 'inductor'
	| 'diode'
	| 'ferrite'
	| 'connector'
	| 'other';

export interface SymbolPinInfo {
	number: string;
	name: string;
}

export interface CircuitBomSuggestion {
	bomItemId?: number;
	mpn?: string;
	value?: string;
	notes?: string;
}

export interface CircuitDesignComponent {
	role: string;
	ref: string;
	type: CircuitComponentType;
	value: string;
	nets: string[];
	pinNets?: Record<string, string>;
	tolerance?: string;
	voltageRating?: string;
	currentRating?: string;
	bomSuggestion?: CircuitBomSuggestion;
	notes?: string;
}

export interface CircuitDesignNet {
	name: string;
	members: string[];
}

export interface CircuitDesignIc {
	bomItemId: number;
	mpn: string;
	ref: string;
	pins: Record<string, string>;
	pinList: SymbolPinInfo[];
}

export interface CircuitDesignRecipe {
	schemaVersion: 1;
	ic: CircuitDesignIc;
	constraints: {
		constraintsText?: string;
		vin?: number;
		vinMin?: number;
		vinMax?: number;
		vout?: number;
		ioutMin?: number;
		notes?: string;
	};
	components: CircuitDesignComponent[];
	nets: CircuitDesignNet[];
	calculations: Record<string, string>;
	notes: string[];
	confidence: CircuitDesignConfidence;
	datasheetUrl?: string;
}

export type PlacementAlgorithm = 'force-directed' | 'side-bucket';

export interface CircuitPlacement {
	ref: string;
	role: string;
	libId: string;
	x: number;
	y: number;
	rotation: number;
	value: string;
	nets: string[];
	pinNets: Record<string, string>;
	/** For power:GND edit poses — owning component ref (pin stub target). */
	ownerRef?: string;
}

export class CircuitLayoutError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number = 400
	) {
		super(message);
		this.name = 'CircuitLayoutError';
	}
}
