-- ============================================================
-- 项目库 Schema（每本书独立数据库文件）
--
-- 与主库 0000_common_lester.sql 的差异：
-- - 只包含项目级表（16 张），不含 users/projects/series/user_settings
-- - 去掉对 projects/users 的外键（跨库无法外键约束）
-- - 保留项目库内部表之间的外键（如 annotations→chapters）
-- - project_id 字段保留（冗余但兼容现有 service 层逻辑）
-- ============================================================

CREATE TABLE IF NOT EXISTS `chapters` (
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
	`story_time` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chapters_project_id` ON `chapters` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chapters_order` ON `chapters` (`order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chapters_deleted_at` ON `chapters` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chapters_project_order` ON `chapters` (`project_id`, `order`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text,
	`thumbnail` text,
	`color` text,
	`role` text,
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_characters_project_id` ON `characters` (`project_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`description` text,
	`thumbnail` text,
	`color` text,
	`credit_price` real,
	`states` text,
	`holders` text,
	`current_holders` text,
	`relations` text,
	`chapters` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_items_project_id` ON `items` (`project_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credit_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`character_id` text,
	`chapter` integer NOT NULL DEFAULT 1,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`reason` text,
	`related_item_id` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_credit_transactions_project_id` ON `credit_transactions` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_credit_transactions_character_id` ON `credit_transactions` (`character_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`thumbnail` text,
	`color` text,
	`latitude` real,
	`longitude` real,
	`map_zoom` integer,
	`world` text,
	`states` text,
	`relations` text,
	`chapters` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_locations_project_id` ON `locations` (`project_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `story_events` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_story_events_project_id` ON `story_events` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_story_events_chapter` ON `story_events` (`chapter`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `foreshadows` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_foreshadows_project_id` ON `foreshadows` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_foreshadows_seed_chapter` ON `foreshadows` (`seed_chapter`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_foreshadows_payoff_chapter` ON `foreshadows` (`payoff_chapter`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `earmarks` (
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
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`foreshadow_id`) REFERENCES `foreshadows`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_earmarks_project_id` ON `earmarks` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_earmarks_chapter_id` ON `earmarks` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_earmarks_chapter_type` ON `earmarks` (`chapter_id`, `type`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `annotations` (
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
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_annotations_project_id` ON `annotations` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_annotations_chapter_id` ON `annotations` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_annotations_chapter_offset` ON `annotations` (`chapter_id`, `start_offset`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `outline_nodes` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_outline_nodes_project_id` ON `outline_nodes` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_outline_nodes_project_parent` ON `outline_nodes` (`project_id`, `parent_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `timeline_events` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_timeline_events_project_id` ON `timeline_events` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_timeline_events_project_chapter` ON `timeline_events` (`project_id`, `chapter`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`content` text DEFAULT '' NOT NULL,
	`tags` text,
	`pinned` integer DEFAULT false NOT NULL,
	`linked_chapter_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`linked_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_notes_project_id` ON `notes` (`project_id`);
--> statement-breakpoint
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_reference_books_project_id` ON `reference_books` (`project_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `writing_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`chapter_id` text,
	`duration` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_writing_stats_project_id` ON `writing_stats` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_writing_stats_project_date` ON `writing_stats` (`project_id`, `date`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`content` text NOT NULL,
	`word_count` integer NOT NULL,
	`label` text,
	`auto` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_snapshots_chapter_id` ON `snapshots` (`chapter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_snapshots_chapter_created` ON `snapshots` (`chapter_id`, `created_at` DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text,
	`messages` text,
	`context` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_conversations_project_id` ON `ai_conversations` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_conversations_project_updated` ON `ai_conversations` (`project_id`, `updated_at` DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `text_markers` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`color` text NOT NULL,
	`label` text,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_text_markers_chapter_id` ON `text_markers` (`chapter_id`);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS plugin_kv (
	id text PRIMARY KEY NOT NULL,
	plugin_id text NOT NULL,
	key text NOT NULL,
	value text NOT NULL,
	project_id text,
	created_at integer NOT NULL,
	updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_kv_unique ON plugin_kv (plugin_id, key, project_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_memory (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	agent_id text NOT NULL,
	form text NOT NULL,
	key text NOT NULL,
	value text NOT NULL,
	source_ref text,
	created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_unique ON agent_memory (agent_id, form, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory (agent_id, form);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memory_audit (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	agent_id text NOT NULL,
	action text NOT NULL,
	keys text NOT NULL,
	reason text,
	allow integer NOT NULL,
	detail text,
	at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_audit_at ON memory_audit (project_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memory_audit_agent ON memory_audit (project_id, agent_id, at DESC);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fact_conflicts (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	slot text NOT NULL,
	existing_value text,
	incoming_value text,
	source text,
	status text NOT NULL,
	resolution text,
	created_at integer NOT NULL,
	resolved_at integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fact_conflicts_open ON fact_conflicts (project_id, status, created_at DESC);
