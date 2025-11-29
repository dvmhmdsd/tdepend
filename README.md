# TDepend

TDepend is a JDepend-inspired dependency analysis tool for the TypeScript ecosystem.

## Goals
- Parse TypeScript projects
- Build module-level dependency graph
- Compute architectural metrics (Ca, Ce, Abstractness, Instability, Distance)
- Detect cycles
- Allow scoped analysis (module / namespace / class)
- Fully config-driven
- Supports CI mode

## Status
- ✅ Phase 1: Project bootstrap with CLI skeleton
- ✅ Phase 2: Config system with Zod validation

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run CLI help
pnpm exec tdepend analyze --help

# Analyze with default config
pnpm exec tdepend analyze

# Use custom config file
pnpm exec tdepend analyze --config my-config.json

# Test
pnpm test
```

## Configuration

TDepend looks for `tdepend.config.json` in the current directory. You can also specify a custom config path using the `--config` flag.

### Config File Example

```json
{
  "rootDir": "src",
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["**/*.test.ts", "**/*.spec.ts", "dist"],
  "metrics": {
    "enabled": ["coupling", "abstractness", "distance", "cycles"],
    "thresholds": {
      "distance": 0.6
    }
  },
  "analysis": {
    "target": null,
    "value": null
  },
  "ci": {
    "failOnThreshold": true,
    "outputFormat": "json"
  }
}
```

### Configuration Options

- **rootDir**: Root directory for analysis (default: `"src"`)
- **include**: Glob patterns for files to include (default: `["src/**/*.ts", "src/**/*.tsx"]`)
- **exclude**: Glob patterns for files to exclude (default: `["**/*.test.ts", "**/*.spec.ts", "dist"]`)
- **metrics.enabled**: Array of metrics to compute (options: `"coupling"`, `"abstractness"`, `"distance"`, `"cycles"`)
- **metrics.thresholds.distance**: Maximum allowed distance from main sequence (default: `0.6`)
- **analysis.target**: Scope analysis to `"module"`, `"class"`, or `"namespace"` (default: `null`)
- **analysis.value**: Value for the target scope (default: `null`)
- **ci.failOnThreshold**: Exit with code 1 on threshold violations (default: `true`)
- **ci.outputFormat**: Output format for CI mode (default: `"json"`)

### CLI Overrides

You can override config settings via CLI flags:

```bash
# Analyze a specific module
pnpm exec tdepend analyze src/utils/helper.ts

# Analyze a specific class
pnpm exec tdepend analyze --class UserService

# Analyze a specific namespace
pnpm exec tdepend analyze --namespace App.Services
```

## Project Structure
```
src/
  cli/
  config/
  parser/
  graph/
  metrics/
  analysis/
  utils/
  tests/

types/
dist/
```

## License
MIT
