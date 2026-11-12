import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseReceiptText} from '../tabloom/receipt-intake.js';
const none={tax:false,tip:false,discount:false};
function check(text,expected){
 const parsed=parseReceiptText(text);const {printedCharges}=parsed;
 assert.deepEqual(printedCharges,expected);
 return parsed;
}
test('absent charges differ from explicit printed zero',()=>{
 check('Soup 10.00\nTotal 10.00',none);
 const p=check('Soup 10.00\nTax 0.00\nTip 0.00\nDiscount 0.00\nTotal 10.00',{tax:true,tip:true,discount:true});
 assert.equal(p.ready,true);assert.equal(p.taxCents,0);assert.equal(p.tipCents,0);assert.equal(p.discountCents,0);
});
test('existing aliases and mixed charge presence are retained',()=>{
 check('Soup 10.00\nSales Tax (10%) 1.00\nGratuity 0.00\nTotal 11.00',{tax:true,tip:true,discount:false});
 check('Soup 10.00\nCoupon -0.00\nTotal 10.00',{tax:false,tip:false,discount:true});
});
test('missing amount labels and legitimate notes do not establish zero',()=>{
 check('Soup 10.00\nTax\nService charge\nNo onions\nThank you',none);
});
test('suggested tips and tender zero are not charged amounts',()=>{
 check('Soup 10.00\nSuggested tips\n0% 0.00\n15% 1.50\nCard ending 1234\nCash 0.00',none);
 check('Soup 10.00\nSuggested tips\n15% 1.50\nTip 0.00',{tax:false,tip:true,discount:false});
});
test('bordered summary remains unrecognized until explicit source repair',()=>{
 const before=check('Soup 10.00\n| Tax 0.00\nTotal 10.00',none);
 assert.equal(before.ready,false);assert(before.issues.some(i=>i.suggestion?.action==='replace'));
 assert.equal(check('Soup 10.00\nTax 0.00\nTotal 10.00',{tax:true,tip:false,discount:false}).ready,true);
});
test('currency and malformed amounts never become recognized zero',()=>{
 for(const line of ['Tax EUR 0.00','Tax £0.00','Tax $0','Tax 0.0']){
  assert.equal(check('Soup 10.00\n'+line,none).ready,false,line);
 }
});
test('duplicate and negative charges remain blocked',()=>{
 for(const suffix of ['Tax 0.00\nTax 1.00','Tax -0.00']){
  assert.equal(check('Soup 10.00\n'+suffix,{tax:true,tip:false,discount:false}).ready,false);
 }
});
test('zero presence never overrides mismatch or missing items',()=>{
 assert.equal(check('Soup 10.00\nTax 0.00\nTotal 12.00',{tax:true,tip:false,discount:false}).ready,false);
 assert.equal(check('Tax 0.00',{tax:true,tip:false,discount:false}).ready,false);
});

test('retained sample labels gain only tax presence after explicit repair; price still blocks',{skip:'uses a retained sample file that is not part of this repository'},()=>{
 const {text}=JSON.parse(readFileSync(new URL('../docs/evidence/receipt-photo-input/napoli-label-review/original-browser-ocr.json',import.meta.url),'utf8'));
 assert.equal(check(text,none).ready,false);
 const repaired=text.replace(/^\|\s+Subtotal/gm,'Subtotal').replace(/^\|\s+Tax/gm,'Tax');
 const p=check(repaired,{tax:true,tip:false,discount:false});
 assert.equal(p.taxCents,445);assert.equal(p.items[2].cents,51200);assert.equal(p.ready,false);
});
