import test from 'node:test';
import assert from 'node:assert/strict';
import { storeSimulatedLead } from './inbox.mjs';
const fixture = {responseId:'resp-1',formId:'form-2',accountId:'acc-3',submittedAt:'2026-10-26T14:30:00Z',answers:[{key:'email',value:'fake@example.com'}]};
test('uses parameterized INSERT with tenant and idempotent unique key',async()=>{
 const calls=[];const db={query:async(sql,params)=>{calls.push([sql,params]);return {rowCount:1,rows:[{id:7}]}}};
 assert.deepEqual(await storeSimulatedLead(db,'tenant-A',fixture),{inserted:true});
 assert.match(calls[0][0],/ON CONFLICT \(tenant_id, ad_account_id, response_id\) DO NOTHING/);
 assert.equal(calls[0][1][0],'tenant-A');assert.equal(calls[0][1][2],'resp-1');
 assert.equal(calls[0][1].length,6);
});
test('returns duplicate when db insert conflicts',async()=>{
 assert.deepEqual(await storeSimulatedLead({query:async()=>({rowCount:0,rows:[]})},'tenant-A',fixture),{inserted:false});
});
test('never queries if trusted tenant missing or response invalid',async()=>{
 let called=false;const db={query:async()=>{called=true;}};
 await assert.rejects(storeSimulatedLead(db,'',fixture),/tenantId/);
 await assert.rejects(storeSimulatedLead(db,'tenant-A',{...fixture,responseId:''}),/responseId/);
 assert.equal(called,false);
});
