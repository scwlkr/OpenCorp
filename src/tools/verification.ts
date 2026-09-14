import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DomainError } from '../core/types.js';
import { safeChild } from './workspaces.js';

/** Use each repository's actual canonical check sequence at the artifact being checked. */
export function canonicalVerification(productName: string, workspace: string, baseCommit?: string, registeredCommand?: string): string {
  const configPath = join(workspace, '.opencorp', 'product.json');
  if (existsSync(configPath)) registeredCommand = JSON.parse(readFileSync(safeChild(workspace, configPath), 'utf8')).verificationCommand ?? registeredCommand;
  if (registeredCommand !== undefined) {
    if (typeof registeredCommand !== 'string' || !registeredCommand.trim() || registeredCommand.length > 4000 || registeredCommand.includes('\0')) throw new DomainError('invalid_verifier', 'Registered verification command must be bounded nonempty text.');
    return registeredCommand;
  }
  switch (productName) {
    case 'WalkLang': {
      const workflow = parse(readFileSync(safeChild(workspace, join(workspace, '.github/workflows/ci.yml')), 'utf8'));
      const version = workflow?.jobs?.test?.env?.WALK_RELEASE_VERSION ?? workflow?.env?.WALK_RELEASE_VERSION;
      if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
        throw new DomainError('verifier_version_unresolved', 'WalkLang canonical workflow must declare a concrete WALK_RELEASE_VERSION before same-version verification.', 409);
      }
      return `export WALK_VERSION='${version}'; make clean && make -j4 walk test && make conformance && WALK_BIN="$PWD/build/walk" scripts/stress-compatibility.sh && scripts/check-docs-site.sh && make release VERSION="$WALK_VERSION" OUT=dist`;
    }
    case 'paletteWOW': return 'bin/brakeman --no-pager && bin/bundler-audit && bin/importmap audit && bin/rubocop -f github';
    case 'OpenJob': {
      if (!baseCommit || !/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new DomainError('verifier_base_required', 'OpenJob merge verification requires the recorded project base commit.', 409);
      return `npm run verify -- merge --base '${baseCommit}'`;
    }
    default: throw new DomainError('verifier_unavailable', 'No canonical verifier registered for this product.', 409);
  }
}
