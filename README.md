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
MVP Phase 1: Project bootstrap with CLI skeleton.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run CLI help
npx tdepend analyze --help

# Or via node
node dist/cli/index.js analyze --help

# Test
npm test
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

types/
tests/
dist/
```

## License
MIT
