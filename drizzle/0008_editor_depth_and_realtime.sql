CREATE TABLE `ai_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_requests_user_created_idx` ON `ai_requests` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `edit_instructions` ADD `mask_r2_key` text;--> statement-breakpoint
ALTER TABLE `image_versions` ADD `adjustments_json` text;--> statement-breakpoint
ALTER TABLE `images` ADD `adjustments_json` text;--> statement-breakpoint
ALTER TABLE `images` ADD `overlay_r2_key` text;--> statement-breakpoint
ALTER TABLE `references` ADD `title` text DEFAULT 'Reference' NOT NULL;--> statement-breakpoint
ALTER TABLE `references` ADD `r2_key_full` text;--> statement-breakpoint
ALTER TABLE `references` ADD `mime` text DEFAULT 'image/png' NOT NULL;--> statement-breakpoint
ALTER TABLE `references` ADD `width_px` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `references` ADD `height_px` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `references_project_idx` ON `references` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `image_palettes_unique` ON `image_palettes` (`image_id`,`palette_id`);