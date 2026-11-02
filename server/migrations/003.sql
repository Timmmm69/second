ALTER TABLE orders ADD COLUMN verified_at timestamptz;
-- Preserve an evidenced verification instant for existing rows. Delivery rows
-- without a historical audit remain NULL and require operational verification.
UPDATE orders o SET verified_at=COALESCE(o.ready_at,(SELECT max(a.created_at) FROM audit_events a WHERE a.entity_id=o.id::text AND a.command='orders.ready'))
WHERE o.ready_at IS NOT NULL OR EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=o.id::text AND a.command='orders.ready');
