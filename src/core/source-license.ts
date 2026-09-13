import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DomainError } from './types.js';
import type { CompanyStore } from '../storage/store.js';

const deny=()=>{throw new DomainError('license_review_required','Managed imports accept only plain MIT sources without additional restrictions. Choose and inspect a compatible source; retained source records and earlier inspection receipts do not establish license eligibility. Historical records remain unchanged.');};
export function assertSourceLicense(content:string,license:string){
 const frontmatter=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
 const declarations=frontmatter?.matchAll(/^[ \t]*license\s*:\s*(.*)$/gmi)??[];
 for(const declaration of declarations){const value=declaration[1]!.trim().replace(/^(['"])(.*)\1$/,'$2');if(value!=='MIT')deny();}
 if(!license.includes('MIT License')||!license.includes('Permission is hereby granted, free of charge')||/Commons\s+Clause|non[- ]commercial|not\s+(?:permitted|allowed)\s+to\s+sell|commercial\s+use\s+(?:is\s+)?prohibited/i.test(license))deny();
}
/** Recheck owned immutable bytes; never modify historical records or inspection receipts. */
export function assertRetainedSourceLicense(store:CompanyStore,source:any){
 if(typeof source.id!=='string'||!/^([a-f0-9]{64})$/.test(source.id))deny();
 const directory=join(store.dataRoot,'skills','vendor',source.id),path=join(directory,'SOURCE.md'),licensePath=join(directory,'LICENSE');
 if(source.kind!=='skill-source'||source.sourcePath!==path)deny();
 try{
  for(const item of [directory,path,licensePath])if(lstatSync(item).isSymbolicLink()||realpathSync(item)!==join(realpathSync(store.dataRoot),relative(store.dataRoot,item)))deny();
  const content=readFileSync(path,'utf8'),license=readFileSync(licensePath,'utf8');
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  if(hash(content)!==source.sha256||hash(license)!==source.licenseHash)throw new DomainError('source_changed','Imported source or license hash changed; preserve and investigate');
  assertSourceLicense(content,license);
 }catch(error){if(error instanceof DomainError)throw error;deny();}
}
