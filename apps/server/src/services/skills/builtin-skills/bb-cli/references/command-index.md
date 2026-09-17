# Core command index

This index lists every command path that the core CLI registers. Read the task-specific reference before you use a command. Check live help for flags and defaults.

## status

- `bb status`

## settings

- `bb settings`
- `bb settings show`
- `bb settings ai-services`
- `bb settings general`
- `bb settings experiment`
- `bb settings keyboard`
- `bb settings keyboard hints`
- `bb settings keyboard list`
- `bb settings keyboard set`
- `bb settings keyboard reset`
- `bb settings usage`
- `bb settings version`
- `bb settings reload`

## project

- `bb project`
- `bb project source`
- `bb project source add`
- `bb project source update`
- `bb project source delete`
- `bb project attachment`
- `bb project attachment upload`
- `bb project attachment download`
- `bb project list`
- `bb project history`
- `bb project reorder`
- `bb project branches`
- `bb project paths`
- `bb project commands`
- `bb project files`
- `bb project content`
- `bb project create`
- `bb project show`
- `bb project update`
- `bb project delete`

## provider

- `bb provider`
- `bb provider list`
- `bb provider models`

## manager

- `bb manager`
- `bb manager hire`
- `bb manager list`
- `bb manager status`
- `bb manager delete`

## machine

- `bb machine`
- `bb machine list`
- `bb machine show`
- `bb machine join-code`
- `bb machine rename`
- `bb machine remove`
- `bb machine retry-update`
- `bb machine provider-cli`
- `bb machine provider-cli status`
- `bb machine provider-cli install`

## updates

- `bb updates`
- `bb updates status`
- `bb updates apply`

## terminal

- `bb terminal`
- `bb terminal list`
- `bb terminal create`
- `bb terminal start`
- `bb terminal show`
- `bb terminal attach`
- `bb terminal send`
- `bb terminal resize`
- `bb terminal output`
- `bb terminal wait`
- `bb terminal rename`
- `bb terminal restart`
- `bb terminal close`
- `bb terminal stop`

## thread

- `bb thread`
- `bb thread wait`
- `bb thread spawn`
- `bb thread fork`
- `bb thread list`
- `bb thread show`
- `bb thread log`
- `bb thread output`
- `bb thread open`
- `bb thread pane`
- `bb thread section`
- `bb thread section list`
- `bb thread section create`
- `bb thread section rename`
- `bb thread section delete`
- `bb thread search`
- `bb thread history`
- `bb thread read`
- `bb thread unread`
- `bb thread reorder-pinned`
- `bb thread count`
- `bb thread queue`
- `bb thread queue list`
- `bb thread queue create`
- `bb thread queue update`
- `bb thread queue send`
- `bb thread queue delete`
- `bb thread queue reorder`
- `bb thread queue group`
- `bb thread tabs`
- `bb thread tabs show`
- `bb thread tabs set`
- `bb thread update`
- `bb thread archive`
- `bb thread unarchive`
- `bb thread pin`
- `bb thread unpin`
- `bb thread delete`
- `bb thread edit-message`
- `bb thread tell`
- `bb thread retry`
- `bb thread stop`
- `bb thread compact`
- `bb thread clear`
- `bb thread cancel-plan`
- `bb thread clear-goal`
- `bb thread interactions`
- `bb thread interactions list`
- `bb thread interactions show`
- `bb thread interactions approve`
- `bb thread interactions grant`
- `bb thread interactions answer`
- `bb thread interactions respond`
- `bb thread interactions deny`

## environment

- `bb environment`
- `bb environment show`
- `bb environment status`
- `bb environment branches`
- `bb environment paths`
- `bb environment diff`
- `bb environment diff-files`
- `bb environment diff-file`
- `bb environment diff-patch`
- `bb environment update`
- `bb environment commit`
- `bb environment archive-threads`
- `bb environment pull-request`
- `bb environment pull-request show`
- `bb environment pull-request ready`
- `bb environment pull-request draft`
- `bb environment pull-request merge`

## file

- `bb file`
- `bb file read`
- `bb file write`
- `bb file list`
- `bb file paths`
- `bb file mkdir`
- `bb file move`
- `bb file remove`

## theme

- `bb theme`
- `bb theme list`
- `bb theme set`
- `bb theme dir`
- `bb theme favicon`
- `bb theme favicon set`
- `bb theme favicon reset`
- `bb theme style`
- `bb theme style set`
- `bb theme style reset`
- `bb theme show`
- `bb theme reset`

## plugin

- `bb plugin`
- `bb plugin search`
- `bb plugin list`
- `bb plugin source`
- `bb plugin install`
- `bb plugin outdated`
- `bb plugin update`
- `bb plugin new`
- `bb plugin types`
- `bb plugin migrate`
- `bb plugin build`
- `bb plugin dev`
- `bb plugin reload`
- `bb plugin enable`
- `bb plugin disable`
- `bb plugin config`
- `bb plugin token`
- `bb plugin run`
- `bb plugin logs`
- `bb plugin remove`

## marketplace

- `bb marketplace`
- `bb marketplace add`
- `bb marketplace list`
- `bb marketplace refresh`
- `bb marketplace remove`

## skill

- `bb skill`
- `bb skill list`
- `bb skill show`
- `bb skill files`
- `bb skill update`
- `bb skill delete`
- `bb skill search`
- `bb skill registry`
- `bb skill registry detail`
- `bb skill install`
- `bb skill cli-skills-status`
- `bb skill install-cli-skills`

## guide

- `bb guide`

## voice

- `bb voice`
- `bb voice transcribe`

## browser

- `bb browser`
- `bb browser instances`
- `bb browser tabs`
- `bb browser create`
- `bb browser acquire`
- `bb browser connection`
- `bb browser release`
- `bb browser reveal`
- `bb browser close`
- `bb browser capture`
- `bb browser watch`


### Managed previews and native browser inspection

`bb preview show|configure|start|stop|restart|logs --project <id>` manages the project's recorded preview terminal. Configure requires explicit host, absolute cwd, and launch command; it saves without executing. `bb guide browser` documents the workflow and remote-host limitations.

Unconfirmed cleanup blocks replacement. After inspecting or stopping the old processes on their host, `bb preview detach --project <id> --terminal <exact-id> --acknowledge-unconfirmed-process` explicitly releases only the reviewed lost session's tracking. It does not stop processes or confirm exit. `show --json` retains up to 20 detached sessions with host/config, last URL, logs and unconfirmed exit status. Never detach automatically to bypass a failed Stop.

`bb browser targets <lease-id>` lists page target IDs for existing native control. `bb browser evaluate <lease-id> --expression <javascript> [--target <id>] [--timeout-ms <ms>]` inspects or tests that page through scoped Electron CDP, including Windows. Supply the same explicit host/instance/generation/thread flags as the acquire operation; run on the selected browser host. Never expose connection credentials. Release the lease when done.
For live HTML inspection, persist a browser tab with `htmlSource:{hostId,rootPath,filePath}` using `bb thread tabs set`, preserving other tabs and the revision returned by `tabs show`. The desktop owns scoped lease creation and renewal when selected. See `bb guide browser` for the descriptor and native capture/evaluate workflow.
