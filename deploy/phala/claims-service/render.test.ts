import { test, expect } from 'bun:test';
import { renderClaimsCompose } from '../../../scripts/phala-claims-service.ts';
test('claims service persists public results and budgets on existing disk with protected configuration',()=>{
 const x=Bun.YAML.parse(renderClaimsCompose('a'.repeat(40),'b'.repeat(64))) as any;const s=x.services['claims-research'];
 expect(s.volumes).toEqual(['claims-data:/data','/var/run/dstack.sock:/var/run/dstack.sock']);expect(x.volumes['claims-data'].name).toBe('mochi-claims-data');expect(s.restart).toBe('unless-stopped');expect(s.environment.MOCHI_CLAIMS_DAILY_ACTIONS).toBe('40');expect(s.environment.PHALA_API_KEY).toContain('${PHALA_API_KEY:');expect(s.command[2]).toContain('/claims-service/assets/claims-service.br');expect(s.command[2]).toContain('Artifact digest mismatch');expect(s.mem_limit).toBe('1g');expect(s.cap_drop).toEqual(['ALL']);expect(s.environment.MOCHI_WEB_CONFIG).toBeUndefined();
 expect(s.environment.TEE_KEYS).toBe('kms');expect(s.environment.QUOTE_VERIFIER).toBe('dcap');
 const jurors=JSON.parse(s.environment.MOCHI_CLAIMS_JURORS);expect(jurors).toHaveLength(3);expect(jurors.every((x:any)=>x.transport==='phala-aci'&&x.baseUrl==='https://inference.phala.com/v1')).toBe(true);
});

test('production bundle shares existing CVM with protected database and no public database port',()=>{
 const x=Bun.YAML.parse(renderClaimsCompose('a'.repeat(40),'b'.repeat(64),'c'.repeat(64))) as any;
 const app=x.services['claims-research'], db=x.services['production-db'];
 expect(app.command[2]).toContain('Runtime digest mismatch');
 expect(app.command[2]).toContain('/deploy/production/assets/runtime.br');
 expect(app.command[2]).toContain('await import("/tmp/mochi-claims.mjs")');
 expect(app.mem_limit).toBe('1400m');expect(db.mem_limit).toBe('384m');
 expect(db.image).toMatch(/@sha256:[a-f0-9]{64}$/);
 expect(db.ports).toBeUndefined();
 expect(db.environment.POSTGRES_PASSWORD).toContain(':?protected database password required');
 expect(app.environment.MOCHI_PRODUCTION_CONFIG_JSON).toBe('${MOCHI_PRODUCTION_CONFIG_JSON:-}');
 expect(x.volumes['production-db'].name).toBe('mochi-production-db');
 expect(app.volumes).toContain('claims-data:/data');expect(app.volumes).toContain('/var/run/dstack.sock:/var/run/dstack.sock');
});
