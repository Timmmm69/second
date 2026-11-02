import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { migrate } from "../server/migrate.js";
import { pool } from "../server/db.js";
import { initializeStore, initialStore } from "../server/store-initial.js";
let app: Awaited<ReturnType<typeof buildApp>>, cookie: string;
before(async()=>{assert.match(process.env.DATABASE_URL??"",/_test$/);await migrate();app=await buildApp({staticFiles:false});const r=await app.inject({method:"POST",url:"/api/auth/dev",payload:{role:"OWNER"}});cookie=String(r.headers["set-cookie"]).split(";")[0];});
after(async()=>{await app.close();await pool.end();});
const save=(payload:any)=>app.inject({method:"PATCH",url:"/api/owner/settings",headers:{cookie},payload});
const read=async()=> (await app.inject({url:"/api/owner/settings",headers:{cookie}})).json();
test("new-store initialization is explicit, once-only, seven days; owner changes are preserved",async()=>{
 const c=await pool.connect();await c.query("BEGIN");
 try {
  for (const table of ["store_settings","items","orders","rule_versions","audit_events"])
    await c.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
  const blank={name:"Лучок",address:"",phone:"",seller:"",acceptingOrders:false,carriers:{BELPOST:{enabled:false},EUROPOST:{enabled:false}}};
  await c.query("INSERT INTO store_settings(id,version,value) VALUES(true,2,$1)",[blank]);
  const first=await initializeStore(c);
  assert.equal(first.phoneIsTest,true);assert.equal(first.documentStatus,"DRAFT");assert.equal(first.acceptingOrders,false);
  assert.equal(Object.keys(first.calendar.week).length,7);
  assert.ok(Object.values(first.calendar.week).every(h=>JSON.stringify(h)==='["10:00","20:00"]'));
  await c.query("UPDATE store_settings SET value=jsonb_set(value,'{name}','\"Название владельца\"')");
  const second=await initializeStore(c);assert.equal(second.name,"Название владельца");assert.equal(second.version,first.version);
  await c.query("UPDATE store_settings SET version=2,value=$1",[blank]);
  await c.query("INSERT INTO items(sku,title,category,price_minor) VALUES('PRESERVE','Существующая вещь','accessories',100)");
  await assert.rejects(()=>initializeStore(c),/новой|неизменённой/);
 }finally{await c.query("ROLLBACK");c.release();}
});
test("drafts and test phone cannot open ordering; editing documents resets approval",async()=>{
 const original=await read();const s={...original,...initialStore,seller:"Проверенные реквизиты для теста",telegramUsername:"test_support",carriers:{BELPOST:{enabled:false,terms:"",contract:""},EUROPOST:{enabled:false,terms:"",contract:""}}};
 const draft=await save(s);assert.equal(draft.statusCode,200,draft.body);
 let current=draft.json();assert.equal(current.documentStatus,"DRAFT");
 assert.equal((await save({...current,acceptingOrders:true})).statusCode,422);
 const approved=await save({...current,documentStatus:"APPROVED"});assert.equal(approved.statusCode,200,approved.body);current=approved.json();
 assert.equal((await save({...current,acceptingOrders:true})).statusCode,422);
 assert.equal((await save({...current,phoneIsTest:false,acceptingOrders:true})).statusCode,422,"known test number is blocked even if flag cleared");
 const active=await save({...current,phone:"+375291234567",phoneIsTest:false,acceptingOrders:true});assert.equal(active.statusCode,200,active.body);
 current=active.json();
 const changed={...current,documents:{...current.documents,privacy:"Новый текст для проверки владельцем"}};
 assert.equal((await save(changed)).statusCode,422,"new text cannot inherit old approval");
 const saved=await save({...changed,documentStatus:"DRAFT",acceptingOrders:false,about:"Текст владельца",address:"Адрес владельца"});assert.equal(saved.statusCode,200,saved.body);
 const next=(await app.inject("/api/settings")).json();assert.equal(next.about,"Текст владельца");assert.equal(next.address,"Адрес владельца");assert.equal(next.documentStatus,"DRAFT");
});


test("buyer guidance is editable, versioned and cannot inherit document approval", async () => {
 const original = await read();
 const nextGuide = {...original.buyerGuide, pickup: "Дождитесь уведомления о готовности и приезжайте на примерку в часы магазина."};
 const rejected = await save({...original, buyerGuide:nextGuide, documentStatus:"APPROVED"});
 assert.equal(rejected.statusCode,422,rejected.body);
 const saved = await save({...original, buyerGuide:nextGuide, documentStatus:"DRAFT", acceptingOrders:false});
 assert.equal(saved.statusCode,200,saved.body);
 assert.equal((await app.inject("/api/settings")).json().buyerGuide.pickup,nextGuide.pickup);
 assert.ok((await pool.query("SELECT 1 FROM rule_versions WHERE settings_version=$1",[original.version])).rowCount);
 assert.equal((await save({...saved.json(), documentStatus:"APPROVED"})).statusCode,200,"separate approval keeps JSONB key order irrelevant");
 assert.equal((await save({...saved.json(), buyerGuide:{...nextGuide,pickup:""}})).statusCode,422);
});
