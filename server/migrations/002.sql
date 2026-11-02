ALTER TABLE idempotency_records ADD COLUMN entity_id uuid;
CREATE INDEX idempotency_entity ON idempotency_records(entity_id);
CREATE INDEX issues_item_state ON operation_issues(item_id,state);
