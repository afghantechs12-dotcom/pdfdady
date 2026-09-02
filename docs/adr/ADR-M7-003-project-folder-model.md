# ADR-M7-003: Project and Folder Model

**Status:** Accepted for planning.

## Decision

Project and Folder are separate entities. A Project is a business/workflow context with lifecycle, owner/team, description, deadline, dashboard, and future project policy. A Folder is a hierarchical navigation container with optional parent Folder and optional Project.

A Workspace has many Projects and Folders. A Project belongs to exactly one Workspace. A Folder belongs to exactly one Workspace and optionally one Project. A DocumentRecord belongs to exactly one Workspace and may reference a Project and/or Folder according to validated placement policy.

All references must share Workspace. Folder moves perform cycle detection and transactional revalidation. A Folder cannot move across Workspaces. Trashing/moving a Project applies explicit subtree metadata semantics without immediate byte deletion. Drag/drop always has keyboard alternatives and reports partial/bulk failures explicitly.

`ProjectPermissionGrant` is not implied by this model and remains provisional pending explicit sharing approval.
