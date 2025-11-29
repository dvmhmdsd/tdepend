# TDepend

TDepend is a JDepend-inspired dependency analysis tool for the TypeScript ecosystem.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 📊 Compute architectural metrics (Ca, Ce, Abstractness, Instability, Distance)
- 🔄 Detect circular dependencies
- 📏 Threshold-based quality gates for CI/CD
- 🎯 Scoped analysis (module/namespace/class)
- ⚙️ Fully config-driven with sensible defaults
- 🚀 CI mode with JSON output
- 📦 Zero runtime dependencies for analysis

## Installation

```bash
npm install -g tdepend
# or
pnpm add -g tdepend
# or
yarn global add tdepend
```

## Quick Start

```bash
# Analyze your TypeScript project
tdepend analyze

# Use custom config file
tdepend analyze --config my-config.json

# CI mode with JSON output
tdepend analyze --ci
```

## Configuration

TDepend looks for `tdepend.config.json` in the current directory.

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
- **ci.failOnCycle**: Exit with code 1 when cycles are detected (default: `false`)
- **ci.outputFormat**: Output format - `"console"` or `"json"` (default: `"console"`)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run tests
pnpm test

# Format code
pnpm format
```

## Project Structure
```
src/
  cli/           # CLI entry point
  config/        # Configuration loading and validation
  parser/        # TypeScript file parsing
  graph/         # Dependency graph and cycle detection
  metrics/       # Metric computation
  analysis/      # Reporting
  utils/         # Utilities
  tests/         # Test files
  types/         # Type definitions

dist/            # Compiled output
```

## License
MIT
