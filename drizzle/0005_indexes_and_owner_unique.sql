CREATE INDEX `albums_project_idx` ON `albums` (`project_id`);--> statement-breakpoint
CREATE INDEX `chat_messages_thread_idx` ON `chat_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_threads_album_idx` ON `chat_threads` (`album_id`);--> statement-breakpoint
CREATE INDEX `credit_events_user_idx` ON `credit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `edit_instructions_image_idx` ON `edit_instructions` (`image_id`,`status`);--> statement-breakpoint
CREATE INDEX `image_annotations_image_idx` ON `image_annotations` (`image_id`);--> statement-breakpoint
CREATE INDEX `image_palettes_image_idx` ON `image_palettes` (`image_id`);--> statement-breakpoint
CREATE INDEX `image_versions_image_idx` ON `image_versions` (`image_id`);--> statement-breakpoint
CREATE INDEX `images_album_idx` ON `images` (`album_id`,`position_idx`);--> statement-breakpoint
CREATE INDEX `images_source_idx` ON `images` (`source_image_id`);--> statement-breakpoint
CREATE INDEX `jobs_user_created_idx` ON `jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_owner_unique` ON `projects` (`owner_id`);--> statement-breakpoint
CREATE INDEX `segment_prompts_segment_idx` ON `segment_prompts` (`segment_id`);--> statement-breakpoint
CREATE INDEX `segments_image_idx` ON `segments` (`image_id`,`order_idx`);--> statement-breakpoint
CREATE INDEX `share_links_image_idx` ON `share_links` (`image_id`);--> statement-breakpoint
-- Data fix: jobs orphaned by the old chat path (charged, never enqueued) sat in
-- "queued" forever. Close them out so they stop looking in-flight.
UPDATE `jobs` SET `status` = 'error', `error` = 'stale: never enqueued', `finished_at` = (unixepoch() * 1000) WHERE `status` IN ('queued', 'running') AND `created_at` < (unixepoch() * 1000) - 3600000;
