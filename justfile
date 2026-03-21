# `just --list --unsorted`
default:
    @just --list --unsorted

# `yarn install`
install:
    yarn install

# `yarn storybook`
storybook: install
    yarn storybook

# `yarn build-storybook`
build-storybook: install
    yarn build-storybook

# `yarn test-storybook` - Run tests using Storybook test runner
test-storybook: install
    yarn test-storybook

# `yarn test:vitest` - Run tests using Vitest addon
test-vitest: install build-storybook
    yarn test:vitest

# Runs all precommit checks
precommit: test-vitest
