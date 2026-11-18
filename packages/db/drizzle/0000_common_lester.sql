CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text,
	`messages` text,
	`context` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_conversations_project_id` ON `ai_conversations` (`project_id`);--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`type` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`selected_text` text NOT NULL,
	`color` text,
	`target_id` text,
	`target_type` text,
	`description` text,
	`foreshadow_type` text,
	`foreshadow_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_annotations_project_id` ON `annotations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_annotations_chapter_id` ON `annotations` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`order` integer NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`label` text,
	`pov` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chapters_project_id` ON `chapters` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_chapters_order` ON `chapters` (`order`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text,
	`thumbnail` text,
	`color` text,
	`desire` text,
	`fear` text,
	`belief` text,
	`weakness` text,
	`appearance` text,
	`personality` text,
	`backstory` text,
	`speech_style` text,
	`states` text,
	`relations` text,
	`chapters` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_characters_project_id` ON `characters` (`project_id`);--> statement-breakpoint
CREATE TABLE `earmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`type` text NOT NULL,
	`foreshadow_id` text,
	`description` text,
	`outcome` text,
	`probability` real,
	`related_characters` text,
	`related_items` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_earmarks_project_id` ON `earmarks` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_earmarks_chapter_id` ON `earmarks` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `foreshadows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'planted' NOT NULL,
	`seed_chapter` integer NOT NULL,
	`seed_text` text,
	`seed_annotation_id` text,
	`hints` text,
	`payoff_chapter` integer,
	`payoff_text` text,
	`payoff_annotation_id` text,
	`related_characters` text,
	`related_items` text,
	`related_events` text,
	`earmarks` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_foreshadows_project_id` ON `foreshadows` (`project_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`description` text,
	`thumbnail` text,
	`color` text,
	`states` text,
	`holders` text,
	`current_holders` text,
	`relations` text,
	`chapters` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_items_project_id` ON `items` (`project_id`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`thumbnail` text,
	`color` text,
	`latitude` real,
	`longitude` real,
	`map_zoom` integer,
	`states` text,
	`relations` text,
	`chapters` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_locations_project_id` ON `locations` (`project_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`content` text DEFAULT '' NOT NULL,
	`tags` text,
	`pinned` integer DEFAULT false NOT NULL,
	`linked_chapter_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notes_project_id` ON `notes` (`project_id`);--> statement-breakpoint
CREATE TABLE `outline_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`order` integer NOT NULL,
	`linked_chapter_ids` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_nodes_project_id` ON `outline_nodes` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cover_image` text,
	`pen_name` text,
	`genre` text,
	`target_word_count` integer,
	`current_word_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_projects_user_id` ON `projects` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reference_books` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`content` text DEFAULT '' NOT NULL,
	`chapters` text DEFAULT '[]' NOT NULL,
	`current_chapter` integer DEFAULT 0 NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_reference_books_project_id` ON `reference_books` (`project_id`);--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`project_ids` text,
	`shared_character_ids` text,
	`shared_location_ids` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`content` text NOT NULL,
	`word_count` integer NOT NULL,
	`label` text,
	`auto` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_chapter_id` ON `snapshots` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `story_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`chapter` integer NOT NULL,
	`participants` text,
	`related_items` text,
	`related_locations` text,
	`consequences` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_story_events_project_id` ON `story_events` (`project_id`);--> statement-breakpoint
CREATE TABLE `text_markers` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`color` text NOT NULL,
	`label` text,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_text_markers_chapter_id` ON `text_markers` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `timeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`chapter` integer,
	`timestamp` text,
	`order` integer NOT NULL,
	`character_ids` text,
	`type` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_timeline_events_project_id` ON `timeline_events` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar` text,
	`is_admin` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ai_features` text DEFAULT '{}' NOT NULL,
	`ai_provider_config` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `writing_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`chapter_id` text,
	`duration` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_writing_stats_project_id` ON `writing_stats` (`project_id`);