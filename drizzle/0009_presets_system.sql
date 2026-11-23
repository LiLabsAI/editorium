CREATE TABLE `presets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`category` text DEFAULT 'custom' NOT NULL,
	`kind` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`adjustments_json` text,
	`prompt_template` text,
	`target_scope` text DEFAULT 'whole' NOT NULL,
	`op_class` text DEFAULT 'reimagine' NOT NULL,
	`default_intensity` text DEFAULT 'balanced' NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `presets_project_kind_idx` ON `presets` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `presets_owner_idx` ON `presets` (`owner_id`);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `preset_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `preset_name` text;--> statement-breakpoint
ALTER TABLE `image_versions` ADD `preset_id` text;--> statement-breakpoint
ALTER TABLE `image_versions` ADD `preset_name` text;