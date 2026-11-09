import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { migrate } from "../server/migrate.js";
import { pool } from "../server/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
const base = {name:"Одежда для собак", measurements:["chest","length"],sortOrder:1,archived:false};
const headers = () => ({cookie:cookies.OWNER,"idempotency-key":randomUUID()});
before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  app = await buildApp({staticFiles:false});
  for (const role of ["OWNER","STAFF","BUYER"]) {
    const r = await app.inject({method:"POST",url:"/api/auth/dev",payload:{role}});
    assert.equal(r.statusCode,200,r.body);
    cookies[role] = String(r.headers["set-cookie"]).split(";")[0];
  }
});
after(async () => {await app.close();await pool.end();});

test("category management is owner-only; public and staff reads are scoped",async () => {
  assert.equal((await app.inject("/api/categories")).statusCode,200);
  assert.equal((await app.inject("/api/owner/categories")).statusCode,401);
  for (const role of ["STAFF","BUYER"]) {
    const r=await app.inject({method:"POST",url:"/api/owner/categories",headers:{cookie:cookies[role]},payload:base});
    assert.equal(r.statusCode,403,r.body);
  }
});

test("owner creates a category without code; staff assigns items; rename/order persist and retry is safe",async () => {
  const h=headers();
  const created=await app.inject({method:"POST",url:"/api/owner/categories",headers:h,payload:base});
  assert.equal(created.statusCode,200,created.body);
  const category=created.json();
  const retry=await app.inject({method:"POST",url:"/api/owner/categories",headers:h,payload:base});
  assert.equal(retry.json().id,category.id);
  const item=await app.inject({method:"POST",url:"/api/staff/items",headers:{cookie:cookies.STAFF,"idempotency-key":randomUUID()},payload:{title:"Куртка для собаки",category:category.id,priceMinor:2500}});
  assert.equal(item.statusCode,200,item.body);
  assert.equal(item.json().category,category.id);
  const edited=await app.inject({method:"PATCH",url:"/api/owner/categories/"+category.id,headers:headers(),payload:{name:"Для собак",sortOrder:0,archived:false,version:category.version}});
  assert.equal(edited.statusCode,200,edited.body);
  const stale=await app.inject({method:"PATCH",url:"/api/owner/categories/"+category.id,headers:headers(),payload:{...base,version:category.version}});
  assert.equal(stale.statusCode,409,stale.body);
  const list=(await app.inject("/api/categories")).json();
  assert.equal(list[0].id,category.id);
  assert.equal(list[0].name,"Для собак");
  assert.deepEqual(list[0].measurements,["chest","length"]);
  const archive=await app.inject({method:"PATCH",url:"/api/owner/categories/"+category.id,headers:headers(),payload:{...base,archived:true,version:edited.json().version}});
  assert.equal(archive.statusCode,409,archive.body);
  assert.equal(archive.json().code,"CATEGORY_IN_USE");
  const second=await buildApp({staticFiles:false});
  try {assert.ok((await second.inject("/api/categories")).json().some((c:any)=>c.id===category.id));}
  finally {await second.close();}
  const bad=await app.inject({method:"POST",url:"/api/staff/items",headers:{cookie:cookies.STAFF,"idempotency-key":randomUUID()},payload:{title:"Неизвестная категория",category:randomUUID(),priceMinor:100}});
  assert.equal(bad.statusCode,422,bad.body);
});

test("empty category archive/restore updates public list and rejects new assignments; duplicates and invalid input fail",async () => {
  const b={name:"Архивируемая категория",sortOrder:1,archived:false};
  const r=await app.inject({method:"POST",url:"/api/owner/categories",headers:headers(),payload:b});
  assert.equal(r.statusCode,200,r.body);
  const created=r.json();
  const duplicate=await app.inject({method:"POST",url:"/api/owner/categories",headers:headers(),payload:{...b,name:"  АРХИВИРУЕМАЯ КАТЕГОРИЯ  "}});
  assert.equal(duplicate.statusCode,409,duplicate.body);
  const invalid=await app.inject({method:"POST",url:"/api/owner/categories",headers:headers(),payload:{...b,name:"",measurements:["not-a-measurement"]}});
  assert.equal(invalid.statusCode,422,invalid.body);
  const archived=await app.inject({method:"PATCH",url:"/api/owner/categories/"+created.id,headers:headers(),payload:{...b,version:created.version,archived:true}});
  assert.equal(archived.statusCode,200,archived.body);
  assert.ok(!(await app.inject("/api/categories")).json().some((c:any)=>c.id===created.id));
  assert.ok((await app.inject({url:"/api/staff/categories",headers:{cookie:cookies.STAFF}})).json().some((c:any)=>c.id===created.id&&c.archived));
  const item=await app.inject({method:"POST",url:"/api/staff/items",headers:{cookie:cookies.STAFF,"idempotency-key":randomUUID()},payload:{title:"Вещь в архив",category:created.id,priceMinor:100}});
  assert.equal(item.statusCode,422,item.body);
  const restored=await app.inject({method:"PATCH",url:"/api/owner/categories/"+created.id,headers:headers(),payload:{...b,version:archived.json().version,archived:false}});
  assert.equal(restored.statusCode,200,restored.body);
  assert.ok((await app.inject("/api/categories")).json().some((c:any)=>c.id===created.id));
});
