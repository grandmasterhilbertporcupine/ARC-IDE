CREATE TABLE `thread_preparations` (
	`owner_plugin_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`request_json` text NOT NULL,
	`owner_generation` text NOT NULL,
	`turn_policy` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`provisioning_context_json` text,
	`environment_json` text,
	`accepted_revision` integer,
	`queued_message_id` text,
	`client_turn_request_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_plugin_id`, `operation_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_preparations_thread_idx` ON `thread_preparations` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_preparations_queue_idx` ON `thread_preparations` (`queued_message_id`);--> statement-breakpoint
CREATE INDEX `thread_preparations_owner_generation_idx` ON `thread_preparations` (`owner_plugin_id`,`owner_generation`);