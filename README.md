# CsDecompileWorkflow

A TypeScript pipeline for automated repair, de-obfuscation preprocessing, and structured analysis of C# Visual Studio projects decompiled by ILSpy.  
It corrects obvious decompilation errors, eliminates common obfuscation noise, and produces clean C# output plus machine-readable JSON artifacts ready for downstream AI readability restoration.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Build](#build)
4. [Development Mode](#development-mode)
5. [Configuration](#configuration)
6. [CLI Usage](#cli-usage)
   - [Commands](#commands)
   - [Global Options](#global-options)
   - [Examples](#examples)
7. [Pipeline Phases](#pipeline-phases)
8. [Output Files](#output-files)
9. [JSON Output Schema (overview)](#json-output-schema-overview)
10. [Project Structure](#project-structure)

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20.0.0 |
| npm | ≥ 10 (bundled with Node 20) |

TypeScript is installed locally as a dev-dependency; no global install is needed.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Lumine2024/CsDecompileWorkflow.git
cd CsDecompileWorkflow

# Install all dependencies
npm install
```

---

## Build

Compile the TypeScript source under `src/` to JavaScript in `dist/`:

```bash
npm run build
```

Type-check without emitting files (useful in CI):

```bash
npm run typecheck
```

The compiled entry point is `dist/cli/index.js`.

---

## Development Mode

Run the pipeline directly from TypeScript source (no build step required) using [tsx](https://github.com/privatenumber/tsx):

```bash
npm run dev -- all --input ./my-decompiled-project --output ./output --verbose
```

`npm run dev` forwards all arguments after `--` to the CLI.

---

## Configuration

Copy the sample config and edit it to match your project:

```bash
cp deobfuscator.config.json my-project.config.json
```

| Field | Type | Default | Description |
|---|---|---|---|
| `inputPath` | `string` | `"./input"` | Path to the directory containing the `.sln` / `.csproj` / `.cs` files |
| `outputPath` | `string` | `"./output"` | Where repaired `.cs` files and reports are written |
| `cacheDir` | `string` | `"./.cache"` | Intermediate JSON cache (allows resuming from any phase) |
| `dryRun` | `boolean` | `false` | When `true`, analyse only — no files are written |
| `aggressiveMode` | `boolean` | `true` | Enable all cleanup passes |
| `phases.*` | `boolean` | all `true` | Toggle individual phases on/off |
| `repair.fixSetterValueParam` | `boolean` | `true` | Replace ILSpy's `invalidString` with `value` in setters |
| `repair.fixCompilerConventionMembers` | `boolean` | `true` | Fix `MoveNext`, `Current`, `Dispose`, `ToString`, etc. |
| `repair.fixDelegatePatterns` | `boolean` | `true` | Repair broken `Invoke`/`BeginInvoke`/`EndInvoke`/event patterns |
| `repair.fixConstructors` | `boolean` | `true` | Fix mangled constructors and static constructors |
| `cleanup.removeDoWhileFalse` | `boolean` | `true` | Unwrap `do { … } while(false)` obfuscation blocks |
| `cleanup.removeConstantConditions` | `boolean` | `true` | Fold `if(true)`/`if(false)`/`while(false)` |
| `cleanup.removeMeaninglessSwitches` | `boolean` | `true` | Mark goto-only switches as suspected junk |
| `cleanup.removeDeadCode` | `boolean` | `true` | Remove unreachable dead code blocks |
| `cleanup.removeUnreferencedLocals` | `boolean` | `true` | Remove locals that are declared but never read |
| `cleanup.removeEmptyBlocks` | `boolean` | `true` | Remove side-effect-free empty blocks |
| `cleanup.removeGotoLabelGarbage` | `boolean` | `true` | Remove labels that are never `goto`d |
| `cleanup.removeNoiseTryCatch` | `boolean` | `false` | Remove empty catch blocks (conservative — off by default) |
| `cleanup.minConfidence` | `number` | `0.75` | Transforms below this threshold go to `suspected-unsafe.json` instead of being applied |
| `clustering.minOccurrences` | `number` | `2` | Minimum occurrences for a name to appear in the cluster index |
| `clustering.enableRoleTagging` | `boolean` | `true` | Assign `probable_handler`, `probable_wrapper`, etc. role tags |

---

## CLI Usage

After building (`npm run build`), use the `csdeob` binary:

```bash
node dist/cli/index.js <command> [options]

# Or if installed globally / via npm link:
csdeob <command> [options]
```

### Commands

| Command | Phases run | Description |
|---|---|---|
| `scan` | A | Project discovery only (parse `.sln`/`.csproj`, enumerate `.cs` files) |
| `index` | A → B | Discovery + source indexing (symbols, hotspots, identifier frequency) |
| `repair` | A → B → C | + Deterministic repair (ILSpy artifacts, setter `value`, keyword escaping) |
| `cleanup` | A → B → C → D | + Aggressive obfuscation cleanup (dead code, constant folds, goto garbage) |
| `cluster` | A → B → C → D → E | + Global symbol clustering and role tagging |
| `all` | A → B → C → D → E → F | Full pipeline; writes repaired files and all reports |
| `report` | F | Regenerate output reports from cached phase data (no re-analysis) |

### Global Options

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to a `deobfuscator.config.json` file (defaults to `./deobfuscator.config.json`) |
| `-i, --input <path>` | Input directory — overrides `inputPath` in config |
| `-o, --output <path>` | Output directory — overrides `outputPath` in config |
| `--dry-run` | Analyse only; do not write any files |
| `--verbose` | Print debug-level messages |
| `-V, --version` | Print version |
| `-h, --help` | Print help |

### Examples

```bash
# Full pipeline, pointing directly at a decompiled solution directory
node dist/cli/index.js all --input ./decompiled-project --output ./output

# Dry run to preview what would be changed, with verbose logging
node dist/cli/index.js all --input ./decompiled-project --output ./output --dry-run --verbose

# Use a custom config file
node dist/cli/index.js all --config ./my-project.config.json

# Only run repair (phases A+B+C), skip cleanup and clustering
node dist/cli/index.js repair --input ./decompiled-project --output ./output

# Regenerate the reports from a previous run's cached data
node dist/cli/index.js report --config ./my-project.config.json
```

---

## Pipeline Phases

| Phase | Name | What it does |
|---|---|---|
| **A** | Project Discovery | Parses `.sln` and `.csproj` files; enumerates all `.cs` source files; records total size and structure; emits `phase-A-discovery.json` |
| **B** | Source Indexing | Extracts namespaces, types, methods, properties, events, fields via layered regex analysis; records reflection hotspots (`Type.GetType`, `GetMethod`, `Activator.CreateInstance`, …); categorises string literals (URL, file path, config key, exception message, …); builds cross-file obfuscated-name clusters; emits `phase-B-indexing.json` |
| **C** | Deterministic Repair | Applies only high-confidence, language-level fixes: replaces `invalidString` with `value` in setters, escapes C# reserved keywords used as identifiers, fixes broken ILSpy compiler-generated annotations and delegate/event patterns; emits `phase-C-repair.json` |
| **D** | Aggressive Cleanup | Removes common obfuscation noise — `do{…}while(false)` wrappers, constant `if`/`while` conditions, dead goto labels, unreferenced locals, empty catch blocks; anything below `minConfidence` is recorded in `suspected-unsafe.json` instead of being deleted; emits `phase-D-cleanup.json` |
| **E** | Global Clustering | Exploits the "consistent obfuscation mapping" property to cluster repeated obfuscated identifiers across all files; assigns role tags (`probable_handler`, `probable_wrapper`, `probable_dispatcher`, `probable_factory`, `probable_state_holder`, `probable_transformer`, `probable_callback`, `probable_utility`); builds signature buckets, wrapper chains, and dispatcher roots; emits `phase-E-clustering.json` |
| **F** | Output & Reporting | Writes repaired `.cs` files mirroring the original directory structure; writes all report JSONs (see below) |

Phase results are cached in `cacheDir` as JSON. Re-running a command that would repeat an already-cached phase will load from cache automatically, allowing quick resumption after a failure.

---

## Output Files

All output is written to `outputPath` (default `./output`):

```
output/
├── <mirrored source tree>/      # Repaired .cs files
│   └── MyProject/
│       └── SomeFile.cs
└── reports/
    ├── summary.json             # Overall run statistics
    ├── transform-log.json       # Every transform applied (file, line, old, new, confidence)
    ├── unresolved-issues.json   # Issues the pipeline could not fix automatically
    ├── suspected-unsafe.json    # Transforms skipped because confidence < minConfidence
    ├── reflection-hotspots.json # All detected reflection call sites
    ├── name-clusters.json       # Cross-file obfuscated name cluster index
    └── ai-metadata.json         # Consolidated artifact for downstream AI processing
```

Intermediate cache files are written to `cacheDir` (default `./.cache`):

```
.cache/
├── phase-A-discovery.json
├── phase-B-indexing.json
├── phase-C-repair.json
├── phase-D-cleanup.json
└── phase-E-clustering.json
```

---

## JSON Output Schema (overview)

### `summary.json`
```jsonc
{
  "inputPath": "./decompiled-project",
  "outputPath": "./output",
  "runAt": "2026-01-01T00:00:00.000Z",
  "phases": ["discovery", "indexing", "repair", "cleanup", "clustering", "output"],
  "totalFiles": 312,
  "totalTransforms": 1847,
  "appliedTransforms": 1820,
  "suspectedJunkCount": 27,
  "unresolvedIssueCount": 4,
  "obfuscatedSymbolCount": 583,
  "clusterCount": 198,
  "dryRun": false
}
```

### `transform-log.json` (array)
```jsonc
[
  {
    "id": "C-001",
    "phase": "C-repair",
    "filePath": "/abs/path/to/File.cs",
    "lineStart": 42,
    "transformType": "fix_setter_value_param",
    "oldContent": "invalidString",
    "newContent": "value",
    "confidence": 0.9,
    "safetyLevel": "likely_safe",  // "safe" | "likely_safe" | "uncertain" | "risky"
    "reason": "ILSpy exports setter implicit parameter as invalidString; should be value",
    "applied": true
  }
]
```

### `name-clusters.json` (object keyed by obfuscated name)
```jsonc
{
  "ABC123": {
    "name": "ABC123",
    "occurrences": 17,
    "files": ["File1.cs", "File2.cs"],
    "dominantKind": "method",
    "signatures": ["void(int,string)"],
    "coOccurringStrings": ["config.timeout"],
    "reflectionInvolvement": false,
    "roleTag": "probable_handler",
    "roleSupportingEvidence": ["appears after +=", "EventArgs parameter"]
  }
}
```

### `ai-metadata.json`

Consolidates `projectMeta`, `globalCluster`, `reflectionHotspots`, `stringAnnotations`, `unresolvedIssues`, `suspectedJunk`, and `transformLog` into a single file for easy AI consumption.

---

## Project Structure

```
src/
├── cli/index.ts              # CLI entry point (commander)
├── config/loader.ts          # Config file loader with defaults
├── types/index.ts            # All shared TypeScript interfaces & types
├── utils/
│   ├── fs.ts                 # Async filesystem helpers
│   ├── logger.ts             # Chalk-based logger
│   └── paths.ts              # Path normalisation + obfuscation heuristics
└── phases/
    ├── A-discovery/index.ts  # Phase A – project discovery
    ├── B-indexing/index.ts   # Phase B – source indexing
    ├── C-repair/index.ts     # Phase C – deterministic repair
    ├── D-cleanup/index.ts    # Phase D – aggressive cleanup
    ├── E-clustering/index.ts # Phase E – global clustering
    └── F-output/index.ts     # Phase F – output & reporting
```

---

## License

[MIT](LICENSE)
