CREATE TABLE `thread_turn_preparations` (
	`owner_plugin_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`execution_context_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`request_json` text NOT NULL,
	`environment_json` text NOT NULL,
	`owner_generation` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`accepted_revision` integer,
	`interrupt_revision` integer,
	`queued_message_id` text,
	`client_turn_request_id` text,
	`provider_thread_id` text,
	`turn_id` text,
	`accepted_event_id` text,
	`terminal_event_id` text,
	`terminal_status` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_plugin_id`, `operation_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_turn_preparations_queue_idx` ON `thread_turn_preparations` (`queued_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_turn_preparations_request_idx` ON `thread_turn_preparations` (`client_turn_request_id`);--> statement-breakpoint
CREATE INDEX `thread_turn_preparations_thread_state_idx` ON `thread_turn_preparations` (`thread_id`,`state`);--> statement-breakpoint
CREATE INDEX `thread_turn_preparations_owner_generation_idx` ON `thread_turn_preparations` (`owner_plugin_id`,`owner_generation`);