CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`cover_image_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`attached_image_id` text,
	`mention_image_ids` text,
	`attached_palette_ids` text,
	`result_image_id` text,
	`result_version_id` text,
	`operation` text,
	`job_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`album_id` text NOT NULL,
	`title` text DEFAULT 'New chat' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`job_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `image_palettes` (
	`image_id` text NOT NULL,
	`palette_id` text NOT NULL,
	`scope` text DEFAULT 'image' NOT NULL,
	`segment_id` text,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`palette_id`) REFERENCES `palettes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `image_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` text NOT NULL,
	`parent_version_id` text,
	`label` text NOT NULL,
	`r2_key_full` text NOT NULL,
	`prompt` text,
	`operation` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`album_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key_original` text NOT NULL,
	`r2_key_web` text,
	`r2_key_thumb` text,
	`mime` text NOT NULL,
	`width_px` integer DEFAULT 0 NOT NULL,
	`height_px` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`source_image_id` text,
	`current_version_id` text,
	`filename_label` text NOT NULL,
	`bookmarked_at` integer,
	`segment_status` text DEFAULT 'none' NOT NULL,
	`position_idx` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`user_id` text NOT NULL,
	`image_id` text,
	`segment_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`error` text,
	`payload_json` text,
	`workflow_id` text,
	`credits_charged` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `palettes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`colors_json` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `references` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`r2_key_thumb` text NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `segment_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`segment_id` text NOT NULL,
	`text` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `segments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` text NOT NULL,
	`parent_segment_id` text,
	`label` text NOT NULL,
	`caption` text,
	`bbox_x` real NOT NULL,
	`bbox_y` real NOT NULL,
	`bbox_w` real NOT NULL,
	`bbox_h` real NOT NULL,
	`mask_r2_key` text,
	`polygon_json` text,
	`locked_at` integer,
	`deleted_at` integer,
	`has_prompt` integer DEFAULT false NOT NULL,
	`order_idx` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`image_id` text,
	`album_id` text,
	`allow_download` integer DEFAULT true NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_unique` ON `share_links` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`credit_balance` integer DEFAULT 20 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
