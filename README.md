# KiCadLayout

Pure TypeScript schematic **place / Manhattan autoroute / score** engine for circuit layout. No build step — consumers import `.ts` sources and provide TypeScript path aliases.

## Peer dependency

Requires [KiCadParser](https://github.com/kaminaris/KiCadParser) (`@kicad-io/...`) for symbol parsing and Device:* passive libraries.

## Consumer setup

```json
{
  "compilerOptions": {
    "paths": {
      "@kicad-io/*": ["../shared/kicad-io/src/*"],
      "@kicad-layout/*": ["../shared/kicad-layout/*"]
    }
  }
}
```

## Usage

```ts
import { seedFromInputs, reroute, autoroute } from '@kicad-layout/index';

const seed = seedFromInputs({
  recipe,
  icSymbolText: kicadSymFileText,
});

const result = reroute({
  recipe,
  icSymbolText: kicadSymFileText,
  placements: editedPlacements,
});
// result.kicadSchFull → load into KicadRenderSession
```

## Scope

| Owns | Does not own |
|------|----------------|
| Geometry, seed/emit, autoroute, score, recipe/placement types | DOM, Angular, LM recipe generation, PDF, DB sessions |

Paint / camera / drag visuals live in [KiCadRenderer](https://github.com/kaminaris/KiCadRenderer).
