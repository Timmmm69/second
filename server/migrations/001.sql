CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), telegram_id bigint UNIQUE NOT NULL,
 role text NOT NULL DEFAULT 'BUYER' CHECK(role IN ('BUYER','STAFF','OWNER')), display_name text NOT NULL DEFAULT '', username text,
 allow_bot boolean NOT NULL DEFAULT false, auth_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text NOT NULL UNIQUE,user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),auth_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz, init_digest text);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_replays (digest text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),session_id uuid REFERENCES sessions(id),created_at timestamptz DEFAULT now());
CREATE TABLE staff_invites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text NOT NULL UNIQUE,telegram_id bigint NOT NULL, role text NOT NULL DEFAULT 'STAFF' CHECK(role='STAFF'), created_by uuid REFERENCES users(id), expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE store_settings (id boolean PRIMARY KEY DEFAULT true CHECK(id),value jsonb NOT NULL,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO store_settings(value) VALUES ('{"name":"Вещи","address":"","phone":"","telegramUsername":"","seller":"","acceptingOrders":false,"documents":{"privacy":"","reservation":"","shipping":"","returns":""},"calendar":{"week":{"1":["10:00","20:00"],"2":["10:00","20:00"],"3":["10:00","20:00"],"4":["10:00","20:00"],"5":["10:00","20:00"],"6":["10:00","18:00"]},"exceptions":{}},"carriers":{"BELPOST":{"enabled":false,"terms":"","contract":""},"EUROPOST":{"enabled":false,"terms":"","contract":""}}}');
CREATE TABLE rule_versions(id bigserial PRIMARY KEY,settings_version integer NOT NULL,value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE supply_batches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,supplier text NOT NULL DEFAULT '',documents jsonb NOT NULL DEFAULT '[]',created_at timestamptz DEFAULT now());
CREATE TABLE items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sku text NOT NULL UNIQUE,title text NOT NULL,category text NOT NULL,
 price_minor integer NOT NULL CHECK(price_minor>=0),currency text NOT NULL DEFAULT 'BYN' CHECK(currency='BYN'),
 publication text NOT NULL DEFAULT 'DRAFT' CHECK(publication IN ('DRAFT','PUBLISHED','HIDDEN','ARCHIVED')),
 physical text NOT NULL DEFAULT 'INTAKE' CHECK(physical IN ('INTAKE','AVAILABLE','PICKED','COUNTER_PROCESSING','HANDOVER_PROCESSING','PACKED','WITH_CARRIER','SOLD','INSPECTION','RETURN_IN_TRANSIT','WRITTEN_OFF')),
 version integer NOT NULL DEFAULT 1,attributes jsonb NOT NULL DEFAULT '{}',measurements jsonb NOT NULL DEFAULT '{}',storage_location text NOT NULL DEFAULT '',
 return_cycle integer NOT NULL DEFAULT 0, batch_id uuid REFERENCES supply_batches(id),published_snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_catalog ON items(publication,physical,created_at DESC,id);
CREATE INDEX items_search ON items USING gin(to_tsvector('simple',title||' '||sku));
CREATE TABLE product_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),item_id uuid REFERENCES items(id),batch_id uuid REFERENCES supply_batches(id),title text NOT NULL,reference text NOT NULL,created_at timestamptz DEFAULT now());
CREATE TABLE media_assets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),item_id uuid NOT NULL REFERENCES items(id),original_key text NOT NULL,checksum text NOT NULL,mime text NOT NULL,width integer NOT NULL,height integer NOT NULL,variants jsonb NOT NULL DEFAULT '{}',position integer NOT NULL DEFAULT 0,role text NOT NULL DEFAULT 'FRONT',state text NOT NULL DEFAULT 'READY',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX media_item ON media_assets(item_id,position);
CREATE TABLE selections(user_id uuid PRIMARY KEY REFERENCES users(id),item_ids uuid[] NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE checkout_drafts(user_id uuid PRIMARY KEY REFERENCES users(id),value_enc text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE leases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','RELEASED','CONVERTED','EXPIRED')),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE lease_lines(lease_id uuid REFERENCES leases(id),item_id uuid REFERENCES items(id),item_version integer NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(lease_id,item_id));
CREATE TABLE inventory_claim(item_id uuid PRIMARY KEY REFERENCES items(id),owner_type text NOT NULL CHECK(owner_type IN ('CHECKOUT','RESERVATION','COUNTER_SALE','HANDOVER')),owner_id uuid NOT NULL,user_id uuid REFERENCES users(id),expires_at timestamptz,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX claims_owner ON inventory_claim(owner_type,owner_id);
CREATE TABLE claim_history(id bigserial PRIMARY KEY,item_id uuid NOT NULL REFERENCES items(id),owner_type text NOT NULL,owner_id uuid NOT NULL,user_id uuid,action text NOT NULL,reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE order_number_seq START 1001;
CREATE TABLE orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),number bigint NOT NULL UNIQUE DEFAULT nextval('order_number_seq'),user_id uuid NOT NULL REFERENCES users(id),method text NOT NULL CHECK(method IN ('PICKUP','BELPOST','EUROPOST')),status text NOT NULL DEFAULT 'CHECKING',version integer NOT NULL DEFAULT 1,total_minor integer NOT NULL CHECK(total_minor>=0),recipient_enc text,rule_snapshot jsonb NOT NULL,verify_by timestamptz NOT NULL,cancel_by timestamptz NOT NULL,ready_at timestamptz,pickup_deadline timestamptz,dispatch_deadline timestamptz,pickup_code_hash text,pickup_code_enc text,code_attempts integer NOT NULL DEFAULT 0,code_window_at timestamptz,assigned_to uuid REFERENCES users(id),proposal jsonb,cancel_requested jsonb,exception boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
CREATE INDEX orders_user ON orders(user_id,created_at DESC);
CREATE INDEX orders_queue ON orders(status,verify_by);
CREATE TABLE order_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),item_id uuid NOT NULL REFERENCES items(id),snapshot jsonb NOT NULL,price_minor integer NOT NULL CHECK(price_minor>=0),outcome text NOT NULL DEFAULT 'RESERVED' CHECK(outcome IN ('RESERVED','CANCELLED','EXPIRED','HANDED_OVER','RELEASE_PENDING','RETURNING','RETURNED')),checked boolean NOT NULL DEFAULT false,UNIQUE(order_id,item_id));
CREATE INDEX order_lines_item ON order_lines(item_id);
CREATE TABLE reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL UNIQUE REFERENCES orders(id),user_id uuid NOT NULL REFERENCES users(id),status text NOT NULL DEFAULT 'VERIFYING',ready_at timestamptz,pickup_deadline timestamptz);
CREATE TABLE reservation_lines(reservation_id uuid REFERENCES reservations(id),order_line_id uuid UNIQUE REFERENCES order_lines(id),status text NOT NULL DEFAULT 'RESERVED',reason text NOT NULL DEFAULT '',PRIMARY KEY(reservation_id,order_line_id));
CREATE TABLE recipient_history(id bigserial PRIMARY KEY,order_id uuid NOT NULL REFERENCES orders(id),version integer NOT NULL,value_enc text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE shipments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),carrier text NOT NULL,tracking text NOT NULL, status text NOT NULL DEFAULT 'REGISTERED',version integer NOT NULL DEFAULT 1,source text NOT NULL,accepted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(carrier,tracking));
CREATE UNIQUE INDEX shipment_active_per_order ON shipments(order_id) WHERE status<>'CANCELLED';
CREATE TABLE shipment_lines(shipment_id uuid REFERENCES shipments(id),order_line_id uuid REFERENCES order_lines(id),outcome text NOT NULL DEFAULT 'IN_TRANSIT',PRIMARY KEY(shipment_id,order_line_id));
CREATE TABLE shipment_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shipment_id uuid REFERENCES shipments(id),status text NOT NULL,source text NOT NULL,raw jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE availability_operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES users(id),item_ids uuid[] NOT NULL,state text NOT NULL DEFAULT 'STARTED',expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
CREATE TABLE handovers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),actor_id uuid NOT NULL REFERENCES users(id),state text NOT NULL DEFAULT 'STARTED',created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(order_id));
CREATE TABLE return_cases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),reason text NOT NULL,status text NOT NULL DEFAULT 'OPEN',version integer NOT NULL DEFAULT 1,decision text,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),received_at timestamptz,closed_at timestamptz);
CREATE TABLE return_lines(return_id uuid REFERENCES return_cases(id),order_line_id uuid REFERENCES order_lines(id),inspection text,PRIMARY KEY(return_id,order_line_id));
CREATE TABLE contact_notes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),actor_id uuid REFERENCES users(id),note_enc text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE idempotency_records(actor_id uuid NOT NULL REFERENCES users(id),key text NOT NULL,scope text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,status integer NOT NULL DEFAULT 200,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,key));
CREATE TABLE user_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),order_id uuid REFERENCES orders(id),type text NOT NULL,message text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX user_events_user ON user_events(user_id,created_at DESC);
CREATE TABLE outbox_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_id uuid NOT NULL,entity_version integer NOT NULL,event_type text NOT NULL,recipient_id uuid NOT NULL REFERENCES users(id),message text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',state text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,last_error text,sent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(entity_id,entity_version,event_type,recipient_id));
CREATE INDEX outbox_pending ON outbox_events(state,available_at);
CREATE TABLE delivery_attempts(id bigserial PRIMARY KEY,event_id uuid REFERENCES outbox_events(id),result text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs(name text PRIMARY KEY,last_run_at timestamptz NOT NULL DEFAULT now(),state jsonb NOT NULL DEFAULT '{}');
CREATE TABLE operation_issues(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_id uuid,item_id uuid REFERENCES items(id),order_id uuid REFERENCES orders(id),kind text NOT NULL,message text NOT NULL,state text NOT NULL DEFAULT 'OPEN',assigned_to uuid REFERENCES users(id),resolution text,created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz);
CREATE UNIQUE INDEX unique_open_issue ON operation_issues(kind,entity_id) WHERE state='OPEN';
CREATE TABLE audit_events(id bigserial PRIMARY KEY,actor_id uuid REFERENCES users(id),command text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE access_events(id bigserial PRIMARY KEY,actor_id uuid REFERENCES users(id),action text NOT NULL,entity_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE deletion_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),status text NOT NULL DEFAULT 'PENDING',reason text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
CREATE TABLE deletion_ledger(id bigserial PRIMARY KEY,user_id uuid,scope text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE telegram_updates(update_id bigint PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
