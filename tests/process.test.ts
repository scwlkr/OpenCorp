import { describe, expect, it } from 'vitest';
import { checked, runProcess } from '../src/tools/process.js';

describe('bounded process output is never mistaken for complete source',()=>{
 it('retains an explicitly marked log tail and makes checked reject truncated stdout',async()=>{
  const args=['-e',"process.stdout.write('BEGIN_REQUIRED_EVIDENCE'+ 'x'.repeat(140000) + 'END_LOG')"],result=await runProcess(process.execPath,args);
  expect(result.code).toBe(0);expect(result.stdoutTruncated).toBe(true);expect(result.stdoutCharacters).toBe(140030);expect(result.stdout).toHaveLength(120000);expect(result.stdout).toMatch(/END_LOG$/);expect(result.stdout).not.toContain('BEGIN_REQUIRED_EVIDENCE');
  await expect(checked(process.execPath,args)).rejects.toThrow(/stdout truncated.*120000-character capture limit/);
 });
 it('preserves complete UTF-8 output across chunk boundaries and reports stderr truncation separately',async()=>{
  const unicode=await checked(process.execPath,['-e',"process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.end(Buffer.from([0x8c,0x8d])),10)"]);expect(unicode).toBe('🌍');
  const result=await runProcess(process.execPath,['-e',"process.stdout.write('complete');process.stderr.write('x'.repeat(5000))"],{maxOutput:100});expect(result).toMatchObject({stdout:'complete',stdoutTruncated:false,stdoutCharacters:8,stderrTruncated:true,stderrCharacters:5000});expect(result.stderr).toHaveLength(100);
 });
});
