CREATE TABLE `image_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` text NOT NULL,
	`text` text NOT NULL,
	`norm_x` real DEFAULT 0.5 NOT NULL,
	`norm_y` real DEFAULT 0.5 NOT NULL,
	`font_size` real DEFAULT 0.04 NOT NULL,
	`color` text DEFAULT '#ffffff' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `segment_id` text;--> statement-breakpoint
ALTER TABLE `image_versions` ADD `r2_key_web` text;--> statement-breakpoint
ALTER TABLE `image_versions` ADD `r2_key_thumb` text;--> statement-breakpoint
ALTER TABLE `segments` ADD `hidden_at` integer;