const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const fee = require('../utils/platformFee');
async function run({subtotal=200, scope='city', items, userId={id:'user-1'}, missingUser=false, missingStore=false}={}) {
  const stored={Platform_Fee:3,Platform_Fee_Fixed:30};
  let offerCalls=0;
  const cart=items??[{storeId:'store-1',price:200,quantity:1}];
  const ctx={exports:{},console,require(name){
    if(name==='../utils/platformFee')return fee;
    if(name==='../modals/setting')return {SettingAdmin:{findOne:()=>({lean:async()=>stored})}};
    if(name==='../modals/User')return {findById:(id)=>{assert.equal(id,'user-1');return {lean:async()=>missingUser?null:{mobileNumber:'test'}};}};
    if(name==='../modals/pages')return {find:()=>({lean:async()=>[]})};
    if(name==='../modals/cart')return {Cart:{find:(filter)=>{assert.deepEqual(JSON.parse(JSON.stringify(filter)),{userId:'user-1'});return {lean:async()=>cart};}}};
    if(name==='../modals/store')return {findById:()=>({select:()=>({lean:async()=>missingStore?null:{serviceScope:scope}})})};
    if(name==='../utils/globalDelivery')return {withGlobalSettingDefaults:s=>({...s})};
    if(name==='../utils/storeOffer')return {getAppliedOfferContext:async regular=>{offerCalls++;assert.ok(regular.every(i=>!i.isFreeProduct));return {cartDiscount:{finalSubtotal:subtotal}};}};
    return {};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controlers/settingControler.js'),'utf8'),ctx);
  const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await ctx.exports.settings({user:userId},res);
  assert.equal(stored.Platform_Fee,3,'must not change saved rate');
  return {res,offerCalls};
}
test('local cart returns combined percentage in existing field',async()=>{
 const {res}=await run();assert.equal(res.code,200);assert.equal(res.body.settings.Platform_Fee,18);assert.equal(res.body.settings.Platform_Fee_Fixed,30);
});
test('cart subtotal changes recompute percentage',async()=>assert.equal((await run({subtotal:100})).res.body.settings.Platform_Fee,33));
test('discounted subtotal and free-item exclusion match checkout',async()=>assert.equal((await run({subtotal:80,items:[{storeId:'store-1'},{storeId:'store-1',isFreeProduct:true}]})).res.body.settings.Platform_Fee,40.5));
test('global cart keeps saved percentage',async()=>{const {res,offerCalls}=await run({scope:'global'});assert.equal(res.body.settings.Platform_Fee,3);assert.equal(offerCalls,0);});
test('empty cart preserves settings',async()=>assert.equal((await run({items:[]})).res.body.settings.Platform_Fee,3));
test('zero local subtotal returns finite zero percentage',async()=>assert.equal((await run({subtotal:0})).res.body.settings.Platform_Fee,0));
test('mixed-store cart never combines unrelated subtotals',async()=>assert.equal((await run({items:[{storeId:'a'},{storeId:'b'}]})).res.body.settings.Platform_Fee,3));
test('deleted store preserves settings',async()=>assert.equal((await run({missingStore:true})).res.body.settings.Platform_Fee,3));
test('supports authenticated _id and scalar user ids',async()=>{await run({userId:{_id:'user-1'}});await run({userId:'user-1'});});
test('missing user still returns 404',async()=>assert.equal((await run({missingUser:true})).res.code,404));
