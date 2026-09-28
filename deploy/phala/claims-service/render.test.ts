import { test, expect } from 'bun:test';
import { renderClaimsCompose } from '../../../scripts/phala-claims-service.ts';
test('claims service persists public results and budgets on existing disk with protected configuration',()=>{
 const x=Bun.YAML.parse(renderClaimsCompose('a'.repeat(40),'b'.repeat(64))) as any;const s=x.services['claims-research'];
 expect(s.volumes).toEqual(['claims-data:/data']);expect(x.volumes['claims-data'].name).toBe('mochi-claims-data');expect(s.restart).toBe('unless-stopped');expect(s.environment.MOCHI_CLAIMS_DAILY_ACTIONS).toBe('40');expect(s.environment.PHALA_API_KEY).toContain('${PHALA_API_KEY:');expect(s.command[2]).toContain('/claims-service/assets/claims-service.br');expect(s.command[2]).toContain('Artifact digest mismatch');expect(s.mem_limit).toBe('1g');expect(s.cap_drop).toEqual(['ALL']);expect(s.environment.MOCHI_WEB_CONFIG).toBeUndefined();
 const jurors=JSON.parse(s.environment.MOCHI_CLAIMS_JURORS);expect(jurors).toHaveLength(3);expect(jurors.every((x:any)=>x.transport==='phala-aci'&&x.baseUrl==='https://inference.phala.com/v1')).toBe(true);
});
