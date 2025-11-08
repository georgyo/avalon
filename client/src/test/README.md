# Testing Setup

## Running Tests

```bash
# Run all tests
yarn test

# Run tests in watch mode
yarn test

# Run tests with UI
yarn test:ui

# Run tests with coverage
yarn test:coverage
```

## Current Status

✅ **Vitest is configured and working**
✅ **Simple unit tests work** (see `simple.spec.ts`, `utils.spec.ts`)
⚠️ **Vue component tests have issues with Yarn PnP**

## Known Issue: Vue Component Testing with Yarn PnP

There's a known compatibility issue between:
- Vitest
- @vue/test-utils
- .vue file loading
- Yarn Plug'n'Play (PnP)

The error `EBADF: bad file descriptor, fstat` occurs when trying to import .vue files in tests.

### Workarounds

**Option 1: Use nodeLinker: node-modules (Recommended)**
In `.yarnrc.yml`:
```yaml
nodeLinker: node-modules
```
Then run `yarn install`. This uses traditional node_modules instead of PnP.

**Option 2: Test logic separately**
Extract logic from components into utility functions and test those instead:
```typescript
// src/lib/roleUtils.ts
export function filterRoles(roles, team) {
  return roles.filter(r => r.team === team)
}

// src/test/roleUtils.spec.ts
import { filterRoles } from '../lib/roleUtils'
// Test the utility function
```

**Option 3: Use E2E tests**
For comprehensive component testing, use Playwright or Cypress for E2E tests:
```bash
yarn add -D @playwright/test
```

### Current Test Files

- ✅ `simple.spec.ts` - Basic test examples (working)
- ✅ `utils.spec.ts` - Utility function tests (working)
- ⚠️ `RoleList.spec.ts.skip` - Vue component test (skipped due to PnP issue)
- `setup.ts` - Test setup file (not currently used)

### Adding New Tests

For now, focus on testing:
1. **Utility functions** - Pure JS/TS logic
2. **Store logic** - Pinia store actions/getters
3. **API helpers** - Request/response handling
4. **Game logic** - Rules, validations, calculations

Component testing can be added once the Yarn PnP issue is resolved or if you switch to node-modules.

## Test Structure

```
src/test/
├── README.md           # This file
├── setup.ts            # Test setup (optional)
├── simple.spec.ts      # Example tests
├── utils.spec.ts       # Utility function tests
└── RoleList.spec.ts.skip  # Skipped component test
```

## Future Improvements

- [ ] Resolve Yarn PnP + Vue component testing
- [ ] Add E2E tests with Playwright
- [ ] Increase test coverage
- [ ] Add CI/CD integration
- [ ] Test Pinia stores
- [ ] Test API calls with MSW (Mock Service Worker)
