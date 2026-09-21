CREATE TABLE `edit_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` text NOT NULL,
	`text` text NOT NULL,
	`bbox_x` real NOT NULL,
	`bbox_y` real NOT NULL,
	`bbox_w` real NOT NULL,
	`bbox_h` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_image_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade
);
