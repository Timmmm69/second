import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { migrate } from "../server/migrate.js";
import { pool, tx } from "../server/db.js";
import { config } from "../server/config.js";
import { initialStore } from "../server/store-initial.js";
import { itemSnapshot } from "../server/inventory.js";

let app: Awaited<ReturnType<typeof buildApp>>, cookie: string;
const data = { title: "Дефектная тестовая вещь", category: "accessories", priceMinor: 1000 };
before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate(); app = await buildApp({ staticFiles: false });
  const r = await app.inject({ method: "POST", url: "/api/auth/dev", payload: { role: "STAFF" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
after(async () => { await app.close(); await pool.end(); });
const send = (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>) => app.inject({ method, url: "/api" + url, payload, headers: { cookie, "idempotency-key": randomUUID() } });

test("ordinary items default to no defect; active defects require meaningful description", async () => {
  const ordinary = await send("POST", "/staff/items", data);
  assert.equal(ordinary.statusCode, 200, ordinary.body);
  assert.equal(ordinary.json().hasDefect, false);
  assert.equal(ordinary.json().defectDescription, "");
  for (const defectDescription of ["", "  \n "]) {
    const bad = await send("POST", "/staff/items", { ...data, hasDefect: true, defectDescription });
    assert.equal(bad.statusCode, 422, bad.body);
  }
});

test("defect persists through API, snapshot is immutable, switching off clears description", async () => {
  const r = await send("POST", "/staff/items", { ...data, hasDefect: true, defectDescription: "  Небольшая затяжка на рукаве  " });
  assert.equal(r.statusCode, 200, r.body);
  const i = r.json();
  assert.equal(i.defectDescription, "Небольшая затяжка на рукаве");
  assert.equal((await app.inject("/api/items/" + i.id)).json().hasDefect, true);
  const snapshot = await tx(async c => itemSnapshot(c, (await c.query("SELECT * FROM items WHERE id=$1", [i.id])).rows[0]));
  assert.equal(snapshot.hasDefect, true);
  const edited = await send("PATCH", "/staff/items/" + i.id, { ...data, version: i.version, hasDefect: false, defectDescription: "Старый текст" });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().defectDescription, "");
  assert.equal((await app.inject("/api/items/" + i.id)).json().defectDescription, "");
  assert.equal(snapshot.defectDescription, "Небольшая затяжка на рукаве");
  assert.equal((await pool.query("SELECT defect_description FROM items WHERE id=$1", [i.id])).rows[0].defect_description, "");
});

test("order history freezes defect disclosure, including after cancellation and catalog edits", async () => {
  const b=await app.inject({method:"POST",url:"/api/auth/dev",payload:{role:"BUYER"}});
  const buyerCookie=String(b.headers["set-cookie"]).split(";")[0];
  await pool.query("UPDATE store_settings SET value=jsonb_set(value,'{acceptingOrders}','true') WHERE id=true");
  const i=(await send("POST","/staff/items",{...data,hasDefect:true,defectDescription:"Маленькая затяжка справа"})).json();
  await pool.query("UPDATE items SET publication='PUBLISHED',physical='AVAILABLE' WHERE id=$1",[i.id]);
  const command=(url:string,payload:Record<string,unknown>)=>app.inject({method:"POST",url:"/api"+url,payload,headers:{cookie:buyerCookie,"idempotency-key":randomUUID()}});
  const lease=await command("/checkout/leases",{itemIds:[i.id]});assert.equal(lease.statusCode,200,lease.body);
  assert.equal(lease.json().items[0].defectDescription,"Маленькая затяжка справа");
  const order=await command("/orders",{leaseId:lease.json().id,method:"PICKUP",phone:"+375291234567",termsAccepted:true});assert.equal(order.statusCode,200,order.body);
  assert.equal(order.json().lines[0].hasDefect,true);
  const cancel=await command(`/orders/${order.json().id}/cancel`,{version:order.json().version});assert.equal(cancel.statusCode,200,cancel.body);
  const current=(await app.inject({url:"/api/staff/items/"+i.id,headers:{cookie}})).json();
  const edit=await send("PATCH","/staff/items/"+i.id,{...data,hasDefect:false,version:current.version});assert.equal(edit.statusCode,200,edit.body);
  const history=await app.inject({url:"/api/orders/"+order.json().id,headers:{cookie:buyerCookie}});assert.equal(history.statusCode,200,history.body);
  assert.equal(history.json().lines[0].defectDescription,"Маленькая затяжка справа");
  assert.equal(history.json().lines[0].hasDefect,true);
});

test("Europost requires a pickup point address, stores it in encrypted server draft",async()=>{
 const b=await app.inject({method:"POST",url:"/api/auth/dev",payload:{role:"BUYER"}});const h={cookie:String(b.headers["set-cookie"]).split(";")[0],"idempotency-key":randomUUID()};
 const invalid=await app.inject({method:"POST",url:"/api/orders",headers:h,payload:{leaseId:randomUUID(),method:"EUROPOST",phone:"+375291234567",fullName:"Тест Получатель",city:"Минск",office:"Пункт 1",termsAccepted:true}});
 assert.equal(invalid.statusCode,422,invalid.body);assert.equal(invalid.json().code,"OFFICE_ADDRESS_REQUIRED");
 const meta=(await app.inject({url:"/api/me/checkout-draft",headers:h})).json();
 const patch=await app.inject({method:"PATCH",url:"/api/me/checkout-draft",headers:h,payload:{draftToken:meta.draftToken,draftRevision:meta.draftRevision+1,method:"EUROPOST",office:"Пункт 1",officeAddress:"Синтетическая улица, 2"}});assert.equal(patch.statusCode,200,patch.body);
 const restored=await app.inject({url:"/api/me/checkout-draft",headers:h});assert.equal(restored.json().officeAddress,"Синтетическая улица, 2");
});


test("production rejects drafts/test contacts when a legacy acceptingOrders flag is still true",async()=>{
 const login=await app.inject({method:"POST",url:"/api/auth/dev",payload:{role:"BUYER"}});
 const buyerCookie=String(login.headers["set-cookie"]).split(";")[0];
 const item=(await send("POST","/staff/items",data)).json();
 await pool.query("UPDATE items SET publication='PUBLISHED',physical='AVAILABLE' WHERE id=$1",[item.id]);
 const old=(await pool.query("SELECT value FROM store_settings WHERE id=true")).rows[0].value;
 const ready={...old,...initialStore,acceptingOrders:true,phone:"+375291234567",phoneIsTest:false,seller:"Синтетические реквизиты",telegramUsername:"test_support",documentStatus:"APPROVED"};
 config.production=true;
 try {
  for(const patch of [{documentStatus:"DRAFT"},{phoneIsTest:true},{phone:"+375337777777"},{documents:{...ready.documents,privacy:""}}]) {
   await pool.query("UPDATE store_settings SET value=$1 WHERE id=true",[{...ready,...patch}]);
   const r=await app.inject({method:"POST",url:"/api/checkout/leases",headers:{cookie:buyerCookie,origin:config.origin,"idempotency-key":randomUUID()},payload:{itemIds:[item.id]}});
   assert.equal(r.statusCode,503,r.body);assert.equal(r.json().code,"LAUNCH_SETTINGS");
  }
 }finally{config.production=false;await pool.query("UPDATE store_settings SET value=$1 WHERE id=true",[old]);}
});

test("checkout discloses public rules and rejects a changed rules version before creating an order", async () => {
 const login=await app.inject({method:"POST",url:"/api/auth/dev",payload:{role:"BUYER"}});
 const buyer=String(login.headers["set-cookie"]).split(";")[0];
 const original=(await pool.query("SELECT value FROM store_settings WHERE id=true")).rows[0].value;
 const configured={...original, acceptingOrders:true, carriers:{...original.carriers, EUROPOST:{...original.carriers.EUROPOST,contract:"PRIVATE CONTRACT",paymentScheme:"PRIVATE PAYMENT"}}};
 await pool.query("UPDATE store_settings SET value=$1 WHERE id=true",[configured]);
 const item=(await send("POST","/staff/items",data)).json();
 await pool.query("UPDATE items SET publication='PUBLISHED',physical='AVAILABLE' WHERE id=$1",[item.id]);
 const cmd=(url:string,payload:Record<string,unknown>)=>app.inject({method:"POST",url:"/api"+url,payload,headers:{cookie:buyer,"idempotency-key":randomUUID()}});
 try {
  const held=await cmd("/checkout/leases",{itemIds:[item.id]});assert.equal(held.statusCode,200,held.body);
  const lease=held.json();assert.ok(lease.rules.buyerGuide.pickup.includes("уведомления"));
  assert.equal(lease.rules.carriers.EUROPOST.contract,undefined);assert.equal(lease.rules.carriers.EUROPOST.paymentScheme,undefined);
  await pool.query("UPDATE store_settings SET version=version+1 WHERE id=true");
  const stale=await cmd("/orders",{leaseId:lease.id,settingsVersion:lease.rules.version,method:"PICKUP",phone:"+375291234567",termsAccepted:true});
  assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().code,"RULES_CHANGED");
  assert.equal((await pool.query("SELECT 1 FROM order_lines WHERE item_id=$1",[item.id])).rowCount,0);
  await app.inject({method:"DELETE",url:"/api/checkout/leases/"+lease.id,headers:{cookie:buyer,"idempotency-key":randomUUID()}});
  const fresh=(await cmd("/checkout/leases",{itemIds:[item.id]})).json();
  const order=await cmd("/orders",{leaseId:fresh.id,settingsVersion:fresh.rules.version,method:"PICKUP",phone:"+375291234567",termsAccepted:true});
  assert.equal(order.statusCode,200,order.body);assert.equal(order.json().ruleSnapshot.version,fresh.rules.version);
 } finally { await pool.query("UPDATE store_settings SET value=$1 WHERE id=true",[original]); }
});
