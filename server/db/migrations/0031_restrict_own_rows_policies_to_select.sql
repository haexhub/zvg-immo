DROP POLICY "own_rows" ON "alert_subscriptions" CASCADE;--> statement-breakpoint
DROP POLICY "own_rows" ON "api_keys" CASCADE;--> statement-breakpoint
DROP POLICY "own_rows" ON "saved_searches" CASCADE;--> statement-breakpoint
DROP POLICY "own_rows" ON "watchlist_items" CASCADE;--> statement-breakpoint
DROP POLICY "own_rows" ON "lawyer_inquiries" CASCADE;--> statement-breakpoint
CREATE POLICY "own_rows" ON "alert_subscriptions" AS PERMISSIVE FOR SELECT TO public USING ("alert_subscriptions"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "api_keys" AS PERMISSIVE FOR SELECT TO public USING ("api_keys"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "saved_searches" AS PERMISSIVE FOR SELECT TO public USING ("saved_searches"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "watchlist_items" AS PERMISSIVE FOR SELECT TO public USING ("watchlist_items"."user_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "own_rows" ON "lawyer_inquiries" AS PERMISSIVE FOR SELECT TO public USING ("lawyer_inquiries"."user_id" = auth.uid());