import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const data=JSON.parse(readFileSync('dist-preview/preview-data.json','utf8'));
assert.equal(data.items.length,8);
assert.equal(data.settings.name,'Лучок');
assert.equal(data.settings.acceptingOrders,false);
assert.equal(data.settings.telegramUsername,'');
for(const item of data.items) for(const m of item.media)
  for(const url of Object.values(m.variants)) assert.ok(existsSync('dist-preview'+url));
const window={fetch:async ()=>new Response(JSON.stringify(data))};
vm.runInNewContext(readFileSync('dist-preview/preview-api.js','utf8'),{
  window,location:{href:'https://preview.example/',origin:'https://preview.example'},URL,Response,DOMException,
});
const get=async path=>(await window.fetch('https://preview.example/api'+path)).json();
assert.equal((await get('/auth/me')).dev,false);
assert.equal((await get('/auth/me')).user,null);
assert.equal((await get('/catalog')).items.length,8);
assert.equal((await get('/catalog?category=bags')).items.length,1);
assert.equal((await get('/catalog?q=джинсы')).items.length,1);
assert.equal((await get('/catalog?minPrice=5000')).items.length,3);
assert.equal((await get('/items/'+data.items[0].id)).id,data.items[0].id);
assert.equal((await window.fetch('https://preview.example/api/orders',{method:'POST'})).status,403);
console.log('PASS: public seed only, 8 items, media, search, category/price filters, detail, no authentication or writes');

assert.equal(data.settings.phone, '');
assert.equal(data.settings.documentStatus, 'DRAFT');
assert.equal(data.settings.carriers.BELPOST.enabled, false);
assert.ok(data.settings.buyerGuide.shipping.includes('согласовать'));
for (const path of ['/orders','/me/checkout-draft','/auth/telegram','/staff/shipments']) {
 for (const method of ['POST','PATCH','PUT','DELETE']) {
  assert.equal((await window.fetch('https://preview.example/api'+path,{method,body:'synthetic'})).status,403);
 }
}
assert.equal((await window.fetch(new Request('https://preview.example/api/orders',{method:'POST',body:'synthetic'}))).status,403);
console.log('PASS: all writes including Request objects denied; contacts empty; no approved legal documents');
