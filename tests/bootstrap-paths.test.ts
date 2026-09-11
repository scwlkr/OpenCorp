import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('node:os', async importOriginal => ({...await importOriginal<typeof import('node:os')>(), homedir: () => '/Users/example-developer'}));
import { CompanyStore } from '../src/storage/store.js';

it('uses the current home for fresh product paths and preserves an existing company', () => {
  const root=mkdtempSync(join(tmpdir(),'opencorp-bootstrap-paths-'));
  const store=new CompanyStore(root);
  try {
    store.bootstrap();
    const paths=['WalkLang','paletteWOW','openjob'].map(name=>`/Users/example-developer/Desktop/dev/${name}`);
    expect(store.policy.allowedRepositories).toEqual(paths);
    expect(store.list('products').map(product=>product.repository)).toEqual(paths);
    const product=store.list('products')[0];
    store.update('products',product.id,{repository:'/custom/existing-repository'});
    store.bootstrap();
    expect(store.need('products',product.id).repository).toBe('/custom/existing-repository');
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});
