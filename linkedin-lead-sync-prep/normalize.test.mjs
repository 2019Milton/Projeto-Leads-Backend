import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLeadResponse, simulateImport } from './normalize.mjs';

const sample = { responseId:'r-100', formId:'form-9', accountId:'account-1', submittedAt:'2026-10-26T14:30:00Z', answers:[{key:'email',value:'teste@example.com'}, {key:'firstName',value:'Teste'}] };

test('normalizes a simulated response without mutating input', () => {
  const before=JSON.stringify(sample);
  const lead=normalizeLeadResponse(sample);
  assert.equal(lead.provider,'linkedin');
  assert.equal(lead.fields.email,'teste@example.com');
  assert.equal(JSON.stringify(sample),before);
});
test('ignores duplicate IDs in one ad account', () => {
  const result=simulateImport([sample,{...sample},{...sample,responseId:'r-101'}]);
  assert.equal(result.inserted.length,2);
  assert.equal(result.duplicates,1);
});
test('same response ID in a different account remains distinct',()=>{
  assert.equal(simulateImport([sample,{...sample,accountId:'account-2'}]).inserted.length,2);
});
test('rejects malformed responses',()=>{
  assert.throws(()=>normalizeLeadResponse({...sample,responseId:''}),/responseId/);
  assert.throws(()=>normalizeLeadResponse({...sample,submittedAt:'not a date'}),/submittedAt/);
  assert.throws(()=>normalizeLeadResponse({...sample,answers:[{key:'email',value:'a'},{key:'email',value:'b'}]}),/duplicate/);
});
