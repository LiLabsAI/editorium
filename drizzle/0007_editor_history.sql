ALTER TABLE `chat_messages` ADD `image_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `root_image_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `op_class` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `bbox_json` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_id` text;--> statement-breakpoint
CREATE INDEX `chat_messages_root_idx` ON `chat_messages` (`root_image_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `chat_threads` ADD `root_image_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_family_unique` ON `chat_threads` (`album_id`,`root_image_id`);--> statement-breakpoint
ALTER TABLE `images` ADD `root_image_id` text;--> statement-breakpoint
CREATE INDEX `images_root_idx` ON `images` (`root_image_id`);--> statement-breakpoint
-- Backfill each photo's family root by walking source_image_id up to an
-- original (orphans whose source was deleted become their own root).
WITH RECURSIVE chain(id, root) AS (
	SELECT id, id FROM images WHERE source_image_id IS NULL
	UNION ALL
	SELECT i.id, chain.root FROM images i JOIN chain ON i.source_image_id = chain.id
)
UPDATE images SET root_image_id = (SELECT root FROM chain WHERE chain.id = images.id);--> statement-breakpoint
UPDATE images SET root_image_id = id WHERE root_image_id IS NULL;
