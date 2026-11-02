import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { buildApp } from "../server/app.js";
import { pool, tx } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { config } from "../server/config.js";
import { totp, ownerStepUp } from "../server/auth.js";
import { createFirstOwner } from "../scripts/owner.js";
import { issue } from "../server/inventory.js";
import { decrypt } from "../server/crypto.js";
let app: Awaited<ReturnType<typeof buildApp>>;
const firstId="991122334", secondId="991122335";
const secrets=["JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP","KRSXG5DSNFXGOIDBORSXG5DSNFXGOIDB"];
async function login(id: string) {
 const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:randomUUID(),user:JSON.stringify({id:Number(id),first_name:"Тест владельца"})});
 const check=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join("\n");
 p.set("hash",createHmac("sha256",createHmac("sha256","WebAppData").update(config.botToken).digest()).update(check).digest("hex"));
 const r=await app.inject({method:"POST",url:"/api/auth/telegram",payload:{initData:p.toString()}});assert.equal(r.statusCode,200,r.body);
 return {user:r.json().user,cookie:String(r.headers["set-cookie"]).split(";")[0]};
}
before(async()=>{assert.match(process.env.DATABASE_URL??"",/_test$/);await migrate();app=await buildApp({staticFiles:false});config.botToken="123:test-owner-authentication";});
after(async()=>{await app.close();await pool.end();});
test("second OWNER requires verified Telegram identity; secrets are personal, sessions revoked, audit retained",async()=>{
 // This test owns these synthetic identities only; it never changes real owners.
 const a=await login(firstId);await pool.query("UPDATE users SET role='OWNER' WHERE id=$1",[a.user.id]);
 await pool.query("INSERT INTO users(telegram_id) VALUES($1) ON CONFLICT DO NOTHING",[secondId]);
 const args=["--add-owner","--telegram-id",secondId,"--confirm-telegram-id",secondId,"--authorizing-telegram-id",firstId];
 const env={...process.env,OWNER_PERSONAL_TOTP_SECRET:secrets[1],OWNER_PERSONAL_TOTP_CODE:totp(secrets[1])};
 await assert.rejects(()=>createFirstOwner(args,env),/Telegram-вход/);
 const b=await login(secondId);
 await createFirstOwner(args,env);
 assert.equal((await pool.query("SELECT role FROM users WHERE id=$1",[b.user.id])).rows[0].role,"OWNER");
 assert.equal((await app.inject({url:"/api/owner/staff",headers:{cookie:b.cookie}})).statusCode,401,"old session revoked");
 await createFirstOwner(["--enroll-totp","--telegram-id",firstId,"--confirm-telegram-id",firstId],{...process.env,OWNER_PERSONAL_TOTP_SECRET:secrets[0],OWNER_PERSONAL_TOTP_CODE:totp(secrets[0])});
 const rows=(await pool.query("SELECT user_id,secret_enc FROM owner_credentials WHERE user_id=ANY($1::uuid[])",[[a.user.id,b.user.id]])).rows;
 assert.equal(rows.length,2);assert.notEqual(rows[0].secret_enc,rows[1].secret_enc);
 assert.equal(decrypt(rows.find(r=>r.user_id===b.user.id).secret_enc),secrets[1]);
 assert.equal((await pool.query("SELECT count(*) FROM audit_events WHERE entity_id=$1 AND command='ADD_OWNER_SERVER_CLI'",[b.user.id])).rows[0].count,"1");
 const fresh=await login(secondId);
 assert.equal((await app.inject({url:"/api/owner/staff",headers:{cookie:fresh.cookie}})).statusCode,200);
 const elevate=await app.inject({method:"POST",url:"/api/owner/staff/invites",headers:{cookie:fresh.cookie},payload:{telegramId:"998877665",role:"OWNER"}});
 assert.equal(elevate.statusCode,422);
});
test("personal step-up denies another owner's code, expired auth and TOTP replay in another session",async()=>{
 const b=await login(secondId);
 const session=(await pool.query("SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",[b.user.id])).rows[0].id;
 const request:any={actor:b.user,sessionId:session,authAt:new Date(),headers:{"x-owner-code":totp(secrets[0])}};
 // Enrollment consumed its code; force an unused step in this isolated test credential.
 await pool.query("UPDATE owner_credentials SET last_step=-1 WHERE user_id=$1",[b.user.id]);
 config.production=true;
 try {
  await assert.rejects(()=>ownerStepUp(request),/личного второго фактора/);
  request.headers["x-owner-code"]=totp(secrets[1]);await ownerStepUp(request);
  // A short step-up grant is bound to one session; retry within it succeeds.
  await ownerStepUp(request);
  request.authAt=new Date(Date.now()-6*60000);await assert.rejects(()=>ownerStepUp(request),/Переоткройте/);
  request.authAt=new Date();
  const other=(await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id",[b.user.id,randomUUID()])).rows[0].id;
  request.sessionId=other;await assert.rejects(()=>ownerStepUp(request),/личного второго фактора/);
 }finally{config.production=false;}
});
test("important issue reaches every OWNER exactly once, retries do not duplicate",async()=>{
 const entity=randomUUID();
 await tx(async c=>{await issue(c,entity,"TEST_OWNERS","Синтетическая проблема");await issue(c,entity,"TEST_OWNERS","Повтор");});
 const problem=(await pool.query("SELECT id FROM operation_issues WHERE entity_id=$1",[entity])).rows[0];
 const recipients=(await pool.query("SELECT recipient_id,count(*)::int n FROM outbox_events WHERE entity_id=$1 GROUP BY recipient_id",[problem.id])).rows;
 const owners=(await pool.query("SELECT id FROM users WHERE role='OWNER'")).rows;
 assert.equal(recipients.length,owners.length);assert.ok(recipients.every(r=>r.n===1));
});

test("a new pickup request notifies all owners once and contains no recipient data",async()=>{
 const buyer=await login("991122338");
 const item=(await pool.query("INSERT INTO items(sku,title,category,price_minor,publication,physical) VALUES($1,'Тест уведомлений','accessories',100,'PUBLISHED','AVAILABLE') RETURNING id",[randomUUID()])).rows[0];
 await pool.query("UPDATE store_settings SET value=jsonb_set(value,'{acceptingOrders}','true') WHERE id=true");
 const send=(url:string,payload:any,key=randomUUID())=>app.inject({method:"POST",url:"/api"+url,headers:{cookie:buyer.cookie,"idempotency-key":key},payload});
 const lease=await send("/checkout/leases",{itemIds:[item.id]});assert.equal(lease.statusCode,200,lease.body);
 const key=randomUUID(), payload={leaseId:lease.json().id,method:"PICKUP",phone:"+375291234567",termsAccepted:true};
 const order=await send("/orders",payload,key);assert.equal(order.statusCode,200,order.body);await send("/orders",payload,key);
 const owners=(await pool.query("SELECT id FROM users WHERE role='OWNER'")).rows;
 const events=(await pool.query("SELECT recipient_id,message FROM outbox_events WHERE entity_id=$1 AND event_type='OWNER_ORDER_REQUEST'",[order.json().id])).rows;
 assert.equal(events.length,owners.length);assert.equal(new Set(events.map(e=>e.recipient_id)).size,owners.length);assert.ok(events.every(e=>!e.message.includes(payload.phone)));
});
